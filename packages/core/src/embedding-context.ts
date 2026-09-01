import { MIN_EMBEDDING_CONTEXT_LENGTH } from "./prompts.js";

export type EmbeddingContextInfo = {
  id: string;
  contextLength?: number;
};

/** True when the model can embed current corpus chunks, or context is unknown. */
export function embeddingContextFitsChunks(
  contextLength: number | undefined
): boolean {
  if (contextLength == null || !Number.isFinite(contextLength)) return true;
  return contextLength >= MIN_EMBEDDING_CONTEXT_LENGTH;
}

/** Models whose published context window is shorter than corpus chunks. */
export function tooShortEmbeddingModels(
  modelIds: readonly string[],
  catalog: readonly EmbeddingContextInfo[]
): Array<{ id: string; contextLength: number }> {
  const byId = new Map(catalog.map((model) => [model.id, model]));
  const short: Array<{ id: string; contextLength: number }> = [];
  const seen = new Set<string>();
  for (const id of modelIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const contextLength = byId.get(id)?.contextLength;
    if (contextLength == null || !Number.isFinite(contextLength)) continue;
    if (contextLength < MIN_EMBEDDING_CONTEXT_LENGTH) {
      short.push({ id, contextLength });
    }
  }
  return short;
}

/** Operator-facing reason a 512-token embed model cannot index this corpus. */
export function embeddingContextTooShortMessage(
  modelId: string,
  contextLength: number
): string {
  return `${modelId} accepts ${contextLength} tokens, but document chunks need about ${MIN_EMBEDDING_CONTEXT_LENGTH}. Pick an embedding model with a larger context window.`;
}
