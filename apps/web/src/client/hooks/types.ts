import type { ComboResult } from "@ragtime/core";

export type SampleQuestion = {
  id: string;
  text: string;
  referenceAnswer: string | null;
};

export type DemoInfo = {
  ready: boolean;
  corpusId: string | null;
  documentCount: number;
  readyDocumentCount?: number;
  questionCount: number;
  name?: string;
};

export type CatalogModel = {
  id: string;
  name: string;
  contextLength?: number;
  pricing?: { prompt?: string; completion?: string; request?: string };
};

export type GatewayIdentity = {
  id: string;
  label: string;
  docsUrl?: string;
  creditsUrl?: string;
};

/** One explicit pipeline the user composes: embedding, optional reranker, answer model. */
export type Setup = {
  id: string;
  embeddingModel: string;
  rerankModel: string | null;
  genModel: string;
};

export type Catalog = {
  embedding: CatalogModel[];
  rerank: CatalogModel[];
  chat: CatalogModel[];
  gateway: GatewayIdentity;
};

export type GridCell = {
  trialId: string;
  comboId: string;
  questionId: string;
  status: string;
  overallScore: string | null;
  attempts: number;
  answer: string | null;
  error?: string | null;
  judgeOnly?: boolean;
};

export type RunPayload = {
  run: {
    id: string;
    corpusId: string;
    status: string;
    name: string;
    budgetUsd: string;
    totalCostUsd: string;
    startedAt: string | null;
    finishedAt?: string | null;
    createdAt: string;
    error: string | null;
  };
  comboResults: ComboResult[];
  grid: GridCell[];
  questions: { id: string; text: string }[];
  phases: {
    documents: { total: number; ready: number };
    embeddings: { model: string; total: number; done: number }[];
    trials: Record<string, number>;
  };
};

export type TrialDetail = {
  trial: {
    answer: string | null;
    stages: import("@ragtime/core").TrialStages;
    overallScore: string | null;
    status: string;
    error?: string | null;
    attempts?: number;
  };
  question: { text: string; referenceAnswer: string | null };
  combo: { embeddingModel: string; rerankModel: string | null; genModel: string };
  chunks: { id: string; idx: number; content: string }[];
};
