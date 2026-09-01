import { and, eq, inArray, sql } from "drizzle-orm";
import {
  createPipelinePorts,
  defineWorkflowTask,
} from "@ragtime/composition";
import {
  runConfigSchema,
  QUESTION_GEN_SYSTEM,
  buildQuestionGenUserPrompt,
} from "@ragtime/core";
import { getAppConfig } from "@ragtime/core";
import {
  appendRunEvent,
  getDb,
  schema,
  transitionRun,
} from "@ragtime/db";
import { runInWaves } from "../lib/fanout.js";
import { ingestDocument, embedCorpus } from "./ingest.js";
import {
  MAX_TRIAL_ATTEMPTS,
  TRIAL_LEASE_MS,
  runTrial,
} from "./trial.js";

/**
 * Top-level bake-off orchestration: ingest/embed as needed, fan out trials,
 * then aggregate spend and finalize run status.
 */
const { runs, documents, trials, combos, questions, chunks } = schema;
const TRIAL_POLL_INTERVAL_MS = 2_000;
const TRIAL_DRAIN_TIMEOUT_MS =
  TRIAL_LEASE_MS * (MAX_TRIAL_ATTEMPTS + 1) + 60_000;

/** How much of the comparison survived, which decides whether a run has value. */
async function countCompleteTrials(
  runId: string,
  questionIds: string[]
): Promise<number> {
  const rows = await getDb()
    .select({ id: trials.id })
    .from(trials)
    .where(
      and(
        eq(trials.runId, runId),
        inArray(trials.questionId, questionIds),
        eq(trials.status, "complete")
      )
    );
  return rows.length;
}

/** Recompute the run's settled spend from the cost ledger. */
export const aggregateRun = defineWorkflowTask(
  {
    name: "aggregate_run",
    compute: "small",
    timeoutSeconds: 120,
    retry: { maxRetries: 2, waitDurationMs: 3000, backoffScaling: 2 },
  },
  async function aggregateRun(runId: string): Promise<{ totalCostUsd: number }> {
    const db = getDb();
    const rows = await db.execute<{ total: string }>(sql`
      SELECT GREATEST(
        COALESCE((
          SELECT SUM(actual_usd)
          FROM run_cost_entries
          WHERE run_id = ${runId} AND status = 'settled'
        ), 0),
        COALESCE((
          SELECT total_cost_usd FROM runs WHERE id = ${runId}
        ), 0)
      ) AS total
    `);
    const total = Number(rows[0]?.total ?? 0);
    await db
      .update(runs)
      .set({ totalCostUsd: String(total) })
      .where(eq(runs.id, runId));
    return { totalCostUsd: total };
  }
);

/** Optional helper: ask a model to invent evaluation questions for a corpus. */
export const generateQuestions = defineWorkflowTask(
  {
    name: "generate_questions",
    compute: "small",
    timeoutSeconds: 120,
    retry: { maxRetries: 2, waitDurationMs: 3000, backoffScaling: 2 },
  },
  async function generateQuestions(args: { corpusId: string; n: number; model: string }) {
    const db = getDb();
    const { gateway } = createPipelinePorts();
    const allChunks = await db.select().from(chunks).where(eq(chunks.corpusId, args.corpusId));
    if (allChunks.length === 0) throw new Error("No chunks in corpus");

    const step = Math.max(1, Math.floor(allChunks.length / args.n));
    const samples = allChunks.filter((_, i) => i % step === 0).slice(0, args.n).map((c, i) => ({
      title: `Chunk ${i + 1}`,
      excerpt: c.content.slice(0, 800),
    }));

    const { text } = await gateway.chat({
      model: args.model,
      messages: [
        { role: "system", content: QUESTION_GEN_SYSTEM },
        { role: "user", content: buildQuestionGenUserPrompt(samples, args.n) },
      ],
    });

    const parsed = JSON.parse(text.replace(/```json|```/g, "").trim()) as {
      questions?: { text: string; referenceAnswer: string }[];
    };

    let created = 0;
    for (const q of parsed.questions ?? []) {
      await db.insert(questions).values({
        corpusId: args.corpusId,
        text: q.text,
        referenceAnswer: q.referenceAnswer,
        origin: "generated",
      });
      created++;
    }
    return { created };
  }
);

/**
 * Entry task the web service starts for each comparison.
 * Owns corpus readiness, trial fan-out, polling, and terminal status.
 */
export const runBakeoff = defineWorkflowTask(
  {
    name: "run_bakeoff",
    compute: "standard",
    timeoutSeconds: 3600,
    retry: { maxRetries: 1, waitDurationMs: 10000, backoffScaling: 2 },
  },
  async function runBakeoff(runId: string): Promise<{ status: string }> {
    const db = getDb();
    const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
    if (!run) throw new Error(`Run not found: ${runId}`);

    const terminalStatuses = new Set([
      "complete",
      "failed",
      "canceled",
      "budget_exceeded",
    ]);
    if (terminalStatuses.has(run.status)) return { status: run.status };

    const config = runConfigSchema.parse(run.config);
    const readStatus = async (): Promise<string> => {
      const current = await db.query.runs.findFirst({
        where: eq(runs.id, runId),
      });
      return current?.status ?? "missing";
    };
    const failPhase = async (
      expected: "ingesting" | "running",
      message: string
    ): Promise<{ status: string }> => {
      const failedRun = await transitionRun(db, runId, expected, "failed", {
        error: message,
        finishedAt: new Date(),
      });
      if (!failedRun) return { status: await readStatus() };
      await appendRunEvent(db, runId, "run.status", {
        status: "failed",
        error: message,
      });
      return { status: "failed" };
    };

    let status = run.status;
    if (status === "draft") {
      const ingesting = await transitionRun(db, runId, "draft", "ingesting", {
        startedAt: new Date(),
        error: null,
      });
      if (ingesting) {
        status = "ingesting";
        await appendRunEvent(db, runId, "run.status", {
          status: "ingesting",
        });
      } else {
        status = await readStatus();
      }
    }

    if (terminalStatuses.has(status) || status === "missing") {
      return { status };
    }

    // Each phase is restartable. A workflow retry resumes from the persisted run
    // status instead of returning early and leaving the run stranded.
    if (status === "ingesting") {
      const pendingDocs = await db
        .select({ id: documents.id })
        .from(documents)
        .where(
          sql`${documents.corpusId} = ${run.corpusId} AND ${documents.status} != 'ready'`
        );

      const { docIngestFanoutBatch } = getAppConfig();
      const ingestResults = await runInWaves(
        pendingDocs,
        docIngestFanoutBatch,
        (document) => ingestDocument({ documentId: document.id, runId })
      );
      if (ingestResults.some((result) => result.status === "rejected")) {
        return await failPhase("ingesting", "Document ingestion failed");
      }

      const embedModels = [...new Set(config.embeddingModels)];
      const embedResults = await Promise.allSettled(
        embedModels.map((model) =>
          embedCorpus({ runId, corpusId: run.corpusId, model })
        )
      );
      if (embedResults.some((result) => result.status === "rejected")) {
        const current = await readStatus();
        if (terminalStatuses.has(current)) return { status: current };
        return await failPhase("ingesting", "Corpus embedding failed");
      }
      const embedError = embedResults
        .filter((result) => result.status === "fulfilled")
        .map((result) => result.value.error)
        .find((error): error is string => Boolean(error));
      if (embedError) {
        const current = await readStatus();
        if (terminalStatuses.has(current)) return { status: current };
        return await failPhase("ingesting", embedError);
      }

      const questionIds = config.questionIds;
      if (questionIds === "all") {
        return await failPhase(
          "ingesting",
          "Run question snapshot is missing"
        );
      }

      const runCombos = await db
        .select()
        .from(combos)
        .where(eq(combos.runId, runId));
      for (const combo of runCombos) {
        for (const questionId of questionIds) {
          await db.execute(sql`
            INSERT INTO trials (run_id, combo_id, question_id, status, stages)
            VALUES (${runId}, ${combo.id}, ${questionId}, 'pending', '{}')
            ON CONFLICT (combo_id, question_id) DO NOTHING
          `);
        }
      }

      const running = await transitionRun(db, runId, "ingesting", "running");
      if (running) {
        status = "running";
        await appendRunEvent(db, runId, "run.status", { status: "running" });
      } else {
        status = await readStatus();
      }
    }

    if (terminalStatuses.has(status) || status === "missing") {
      return { status };
    }

    if (status === "running") {
      if (config.questionIds === "all") {
        return await failPhase("running", "Run question snapshot is missing");
      }
      const snapshotQuestionIds = config.questionIds;
      const { trialFanoutBatch } = getAppConfig();
      const drainDeadline = Date.now() + TRIAL_DRAIN_TIMEOUT_MS;

      while (true) {
        const current = await readStatus();
        if (terminalStatuses.has(current)) return { status: current };

        const incomplete = await db
          .select({
            id: trials.id,
            status: trials.status,
            attempts: trials.attempts,
            leaseExpiresAt: trials.leaseExpiresAt,
          })
          .from(trials)
          .where(
            and(
              eq(trials.runId, runId),
              inArray(trials.questionId, snapshotQuestionIds),
              sql`${trials.status} NOT IN ('complete', 'skipped')`
            )
          );
        if (incomplete.length === 0) break;

        const now = Date.now();
        const hasLiveLease = (trial: (typeof incomplete)[number]) =>
          trial.status === "running" &&
          trial.leaseExpiresAt != null &&
          trial.leaseExpiresAt.getTime() > now;
        const exhausted = incomplete.filter(
          (trial) =>
            trial.attempts >= MAX_TRIAL_ATTEMPTS && !hasLiveLease(trial)
        );
        if (exhausted.length > 0 || now >= drainDeadline) {
          const failed = incomplete.filter(
            (trial) => trial.status === "failed"
          ).length;
          const stuck = incomplete.length - failed;
          const scored = await countCompleteTrials(runId, snapshotQuestionIds);
          // A bake-off compares setups, and that comparison still holds when
          // some trials could not finish. Report the run on what it scored and
          // let the grid show the gaps, rather than discarding every result
          // because one model would not answer.
          if (scored === 0) {
            return await failPhase(
              "running",
              `Bake-off incomplete: ${failed} failed, ${stuck} pending/running trials`
            );
          }
          await appendRunEvent(db, runId, "run.partial", {
            scored,
            failed,
            stuck,
          });
          break;
        }

        const runnable = incomplete.filter(
          (trial) =>
            trial.status === "pending" ||
            trial.status === "failed" ||
            (trial.status === "running" && !hasLiveLease(trial))
        );
        if (runnable.length > 0) {
          await runInWaves(runnable, trialFanoutBatch, (trial) =>
            runTrial(trial.id)
          );
          continue;
        }

        const nearestLeaseExpiry = Math.min(
          ...incomplete
            .map((trial) => trial.leaseExpiresAt?.getTime() ?? now)
            .filter((expiresAt) => expiresAt > now)
        );
        const delayMs = Math.max(
          50,
          Math.min(
            TRIAL_POLL_INTERVAL_MS,
            nearestLeaseExpiry - now + 10
          )
        );
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }

      const aggregating = await transitionRun(
        db,
        runId,
        "running",
        "aggregating"
      );
      if (aggregating) {
        status = "aggregating";
        await appendRunEvent(db, runId, "run.status", {
          status: "aggregating",
        });
      } else {
        status = await readStatus();
      }
    }

    if (terminalStatuses.has(status) || status === "missing") {
      return { status };
    }

    if (status === "aggregating") {
      await aggregateRun(runId);
      const completed = await transitionRun(
        db,
        runId,
        "aggregating",
        "complete",
        { finishedAt: new Date() }
      );
      if (!completed) return { status: await readStatus() };
      await appendRunEvent(db, runId, "run.status", { status: "complete" });
      return { status: "complete" };
    }

    return { status: await readStatus() };
  }
);
