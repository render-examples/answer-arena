export const RAG_SYSTEM_PROMPT = `You answer questions strictly from the provided context.
Cite every factual claim as [chunk:N] where N matches the chunk number in the context.
If the context is insufficient to answer the question, say so explicitly.
Do not use outside knowledge.`;

export function buildGenerationUserPrompt(
  contextBlocks: { idx: number; content: string }[],
  question: string
): string {
  const blocks = contextBlocks
    .map((b) => `[chunk:${b.idx}]\n${b.content}`)
    .join("\n\n");
  return `CONTEXT:\n${blocks}\n\nQUESTION:\n${question}`;
}

export const JUDGE_PROMPT = `You are grading one answer from a retrieval-augmented QA system.

You will receive:
- CONTEXT: the retrieved passages the system was given
- QUESTION: the user question
- REFERENCE: a trusted reference answer
- CANDIDATE: the answer to grade

Score three dimensions as integers from 0 to 10:

- faithfulness: Is every claim in CANDIDATE supported by CONTEXT?
  Penalize any claim not present in CONTEXT, even if it happens to be true.
  A candidate that says the context is insufficient, when it truly is, scores high.
- correctness: Does CANDIDATE agree with REFERENCE on the substance of the answer?
  Wording differences do not matter. Factual disagreement does.
- completeness: Does CANDIDATE cover the essential points of REFERENCE?
  Penalize missing key facts. Do not reward padding.

Respond with ONLY this JSON, no markdown, no commentary:
{"faithfulness": 0, "correctness": 0, "completeness": 0, "rationale": "<max 40 words>"}`;

export const JUDGE_PROMPT_NO_REFERENCE = `You are grading one answer from a retrieval-augmented QA system.

You will receive:
- CONTEXT: the retrieved passages the system was given
- QUESTION: the user question
- CANDIDATE: the answer to grade

No reference answer exists for this question, so do NOT score correctness.
Score two dimensions as integers from 0 to 10:

- faithfulness: Is every claim in CANDIDATE supported by CONTEXT?
  Penalize any claim not present in CONTEXT, even if it happens to be true.
  A candidate that says the context is insufficient, when it truly is, scores high.
- completeness: Does CANDIDATE address the essential parts of QUESTION using CONTEXT?
  Penalize missing key facts available in CONTEXT. Do not reward padding.

Respond with ONLY this JSON, no markdown, no commentary:
{"faithfulness": 0, "completeness": 0, "rationale": "<max 40 words>"}`;

export function buildJudgeUserPrompt(
  context: string,
  question: string,
  reference: string | null,
  candidate: string
): string {
  const referenceBlock =
    reference != null && reference.trim() !== ""
      ? `\n\nREFERENCE:\n${reference}`
      : "";
  return `CONTEXT:\n${context}\n\nQUESTION:\n${question}${referenceBlock}\n\nCANDIDATE:\n${candidate}`;
}

export const QUESTION_GEN_SYSTEM = `You generate evaluation questions for a RAG system.
Each question must be answerable strictly from the provided document excerpts.
Return JSON only: {"questions":[{"text":"...","referenceAnswer":"..."}]}`;

export function buildQuestionGenUserPrompt(
  samples: { title: string; excerpt: string }[],
  n: number
): string {
  const docs = samples
    .map((s, i) => `--- Document ${i + 1}: ${s.title} ---\n${s.excerpt}`)
    .join("\n\n");
  return `Generate exactly ${n} question and reference-answer pairs grounded in these excerpts:\n\n${docs}`;
}

/** Chunking: ~800 tokens target, 15% overlap (chars/4 token estimate). */
export const CHUNK_TARGET_TOKENS = 800;
export const CHUNK_OVERLAP_RATIO = 0.15;
export const CHARS_PER_TOKEN_ESTIMATE = 4;

/**
 * Embedding models must fit persisted chunks. The char/4 estimate undercounts
 * SciFact text (live chunks reached ~835 tokens), so the floor sits above the
 * chunk target rather than matching it.
 */
export const MIN_EMBEDDING_CONTEXT_LENGTH = 1024;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}
