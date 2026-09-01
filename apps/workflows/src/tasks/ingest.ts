import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  createPipelinePorts,
  defineWorkflowTask,
} from "@ragtime/composition";
import {
  extractAndChunk,
  embedChunkBatch as pipelineEmbedBatch,
  isNonRetryableProviderError,
  safePersistedError,
} from "@ragtime/core";
import {
  createRunCostController,
  getDb,
  schema,
  emitEvent,
  getMissingChunkIdsForModel,
} from "@ragtime/db";
import { getAppConfig } from "@ragtime/core";
import { maybeChaos, chunkIntoBatches } from "../lib/chaos.js";
import { runInWaves } from "../lib/fanout.js";

/**
 * Corpus prep tasks: turn a document into chunks, then embed missing vectors.
 * `embed_corpus` fans out `embed_chunk_batch` so large libraries stay within
 * per-task timeouts and retries.
 */
const { documents, chunks } = schema;

/** Extract text and persist chunks for one document (idempotent when already ready). */
export const ingestDocument = defineWorkflowTask(
  {
    name: "ingest_document",
    compute: "standard",
    timeoutSeconds: 300,
    retry: { maxRetries: 3, waitDurationMs: 3000, backoffScaling: 2 },
  },
  async function ingestDocument(args: { documentId: string; runId?: string }): Promise<{ chunkCount: number }> {
    const documentId = args.documentId;
    const db = getDb();
    const ports = createPipelinePorts();
    const doc = await db.query.documents.findFirst({ where: eq(documents.id, documentId) });
    if (!doc) throw new Error(`Document not found: ${documentId}`);

    if (doc.status === "ready") {
      const rows = await db.select().from(chunks).where(eq(chunks.documentId, documentId));
      return { chunkCount: rows.length };
    }

    await db.update(documents).set({ status: "ingesting", error: null }).where(eq(documents.id, documentId));

    try {
      const { text, chunks: parts } = await extractAndChunk({
        extractor: ports.extractor,
        chunker: ports.chunker,
        sourceType: doc.sourceType as "upload" | "url",
        rawText: doc.rawText,
        sourceUri: doc.sourceUri,
      });

      await ports.vectorStore.deleteAndInsertChunks(documentId, doc.corpusId, parts);
      await db.update(documents).set({ status: "ready", rawText: text, error: null }).where(eq(documents.id, documentId));
      if (args.runId) {
        emitEvent(db, args.runId, "doc.ingested", { documentId, chunkCount: parts.length }, documentId);
      }
      return { chunkCount: parts.length };
    } catch (err) {
      const message = safePersistedError(err, "Document ingestion failed");
      await db.update(documents).set({ status: "failed", error: message }).where(eq(documents.id, documentId));
      throw err;
    }
  }
);

/** Embed one batch of chunk ids for a single embedding model (cost-reserved). */
export const embedChunkBatch = defineWorkflowTask(
  {
    name: "embed_chunk_batch",
    compute: "small",
    timeoutSeconds: 120,
    retry: { maxRetries: 5, waitDurationMs: 2000, backoffScaling: 2 },
  },
  async function embedChunkBatch(args: {
    runId: string;
    corpusId: string;
    model: string;
    chunkIds: string[];
  }): Promise<{ embedded: number; error?: string }> {
    maybeChaos();
    const db = getDb();
    const ports = createPipelinePorts();
    const { maxProviderCallUsd } = getAppConfig();
    const costController = createRunCostController(
      db,
      args.runId,
      maxProviderCallUsd
    );
    const batchKey = createHash("sha256")
      .update(args.model)
      .update("\0")
      .update([...args.chunkIds].sort().join(","))
      .digest("hex");

    const result = await pipelineEmbedBatch({
      gateway: ports.gateway,
      vectorStore: ports.vectorStore,
      corpusId: args.corpusId,
      embeddingModel: args.model,
      chunkIds: args.chunkIds,
      costController,
      operationKey: `corpus:${args.corpusId}:${batchKey}`,
    }).catch((err: unknown) => {
      if (!isNonRetryableProviderError(err)) throw err;
      const message = safePersistedError(err, "Embedding failed");
      emitEvent(db, args.runId, "embed.batch", {
        model: args.model,
        error: message,
      });
      return { embedded: 0, error: message } as const;
    });

    if ("error" in result) {
      return { embedded: 0, error: result.error };
    }

    emitEvent(db, args.runId, "embed.batch", {
      model: args.model,
      embedded: result.embedded,
      receipt: result.receipt,
    });

    return { embedded: result.embedded };
  }
);

/** Fan out missing-chunk embeds for one model across the corpus. */
export const embedCorpus = defineWorkflowTask(
  {
    name: "embed_corpus",
    compute: "standard",
    timeoutSeconds: 600,
    retry: { maxRetries: 2, waitDurationMs: 5000, backoffScaling: 2 },
  },
  async function embedCorpus(args: {
    runId: string;
    corpusId: string;
    model: string;
  }): Promise<{ batches: number; error?: string }> {
    const db = getDb();
    const { embedBatchSize, embedFanoutBatch } = getAppConfig();
    const missing = await getMissingChunkIdsForModel(db, args.corpusId, args.model);
    const batches = chunkIntoBatches(missing, embedBatchSize);
    const waveResults = await runInWaves(batches, embedFanoutBatch, (ids) =>
      embedChunkBatch({
        runId: args.runId,
        corpusId: args.corpusId,
        model: args.model,
        chunkIds: ids,
      })
    );
    const embedError = waveResults.flatMap((result) => {
      if (result.status === "rejected") {
        return [
          result.reason instanceof Error
            ? result.reason.message
            : "One or more embed batches failed",
        ];
      }
      const value = result.value as { error?: string } | undefined;
      return value?.error ? [value.error] : [];
    })[0];
    if (embedError) {
      return { batches: batches.length, error: embedError };
    }
    return { batches: batches.length };
  }
);
