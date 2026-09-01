/** User-facing copy (single source of truth). */

import { MIN_EMBEDDING_CONTEXT_LENGTH } from "@ragtime/core";

export const FLOW_STEPS = [
  { label: "Choose a question", description: "Pick a sample or write your own" },
  {
    label: "Compose setups",
    description:
      "Each setup combines an embedding, an optional rerank, and a generation model",
  },
  {
    label: "Run and compare",
    description: "Setups run in parallel as durable workflow tasks",
  },
] as const;

export const RUN_STATUS_LABEL: Record<string, string> = {
  draft: "Starting",
  ingesting: "Indexing documents",
  running: "Running",
  aggregating: "Aggregating",
  complete: "Complete",
  failed: "Failed",
  canceled: "Canceled",
  budget_exceeded: "Budget exceeded",
};

export function runStatusLabel(status: string): string {
  return RUN_STATUS_LABEL[status] ?? status.replace(/_/g, " ");
}

export const TEST_STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  running: "Running",
  complete: "Complete",
  failed: "Failed",
  skipped: "Skipped",
};

/** Keyed by the stage names emitted in trial.stage events (see TrialStages). */
export const PIPELINE_STAGE_LABEL: Record<string, string> = {
  retrieval: "Retrieval",
  rerank: "Rerank",
  generation: "Generation",
  judge: "Judge",
};

export function stageLabel(stage: string): string {
  return PIPELINE_STAGE_LABEL[stage] ?? stage.replace(/_/g, " ");
}

export type RunPlanSummary = {
  trialCount: number;
  overLimit: boolean;
};

export function formatMatrixSummary(args: {
  embedCount: number;
  rerankCount: number;
  genCount: number;
  questionCount: number;
  maxTrials: number;
}): RunPlanSummary {
  const setupCount = args.embedCount * args.rerankCount * args.genCount;
  return formatSetupSummary({
    setupCount,
    questionCount: args.questionCount,
    maxTrials: args.maxTrials,
  });
}

/** Counts answers for explicit-setup mode and whether the run exceeds the trial cap. */
export function formatSetupSummary(args: {
  setupCount: number;
  questionCount: number;
  maxTrials: number;
}): RunPlanSummary {
  const trialCount = args.setupCount * args.questionCount;
  return {
    trialCount,
    overLimit: trialCount > args.maxTrials,
  };
}

export type FriendlyErrorMeta = {
  /** Machine-readable provider error code, mapped before any string heuristics. */
  code?: string;
  /** Adapter-supplied link that helps the user resolve the error. */
  helpUrl?: string;
};

/** Maps provider error codes to plain-language messages. Falls back to string heuristics. */
export function friendlyError(raw: string, meta?: FriendlyErrorMeta): string {
  switch (meta?.code) {
    case "insufficient_credits":
      return meta.helpUrl
        ? `Credits are low. Add more credits: ${meta.helpUrl}`
        : "Credits are low. Add more credits to your model gateway account.";
    case "rate_limited":
      return "The model gateway is rate limiting requests. Wait a moment and try again.";
    case "auth":
      return "The model gateway rejected the request. Check the API key configuration.";
    case "invalid_model":
      return "One of the selected models is not available on the model gateway.";
    case "input_too_long":
      return "A document chunk is longer than the embedding model's context window. Pick an embedding model with a larger context.";
    case "provider_unavailable":
      return "The model gateway is temporarily unavailable. Try again shortly.";
    case "workflow_auth":
      return "Run did not start: the workflow dispatcher rejected its credentials. Check the deployment configuration.";
    case "workflow_not_found":
      return "Run did not start: the configured workflow task is unavailable.";
    case "workflow_unavailable":
      return "Run did not start: the workflow dispatcher could not be reached. Try again shortly.";
    // Admission messages already name the limit that was hit, so pass them through.
    case "session_run_limit":
    case "global_run_limit":
      return raw;
    default:
      break;
  }

  const msg = raw.trim();
  if (!msg || msg === "Unknown error") {
    return "Request failed. Try fewer models or check the service logs.";
  }
  if (msg.includes("ECONNREFUSED") || msg.includes("CONNECT_TIMEOUT") || msg.includes("5432")) {
    return "Database unavailable. Wait a minute and try again.";
  }
  if (msg.includes("403") || msg.includes("forbidden")) {
    return "Run did not start. Check deployment configuration.";
  }
  if (msg.includes("402") || msg.includes("Insufficient credits")) {
    return "Credits are low. Add more credits to your model gateway account.";
  }
  if (msg.includes("matrix would run") || msg.includes("max ")) {
    return msg.replace(/model stack/gi, "model setup");
  }
  if (msg.includes("Not found")) {
    return "Run not found. It may belong to another browser session.";
  }
  return msg;
}

export const COPY = {
  app: {
    subtitle: "Playground to compare search + answer setups side by side",
    zones: { inputs: "Configure", run: "Compare", detail: "Inspect" },
    welcomeTitle: "Try different search + answer setups on the same question.",
    welcomeBody:
      "Load the sample docs, pick the models in each setup, then compare answers, evidence, cost, and speed side by side.",
    questionSection: "Question",
    modelsSection: "Setups",
    sampleQuestions: "Sample questions",
    promptPlaceholder: "What does the evidence say about…?",
    yourQuestion: "Question text",
    embedLabel: "Embedding",
    embedHint: "Finds candidate passages",
    embedInfo:
      `The embedding model turns your question and each passage into vectors, then finds the passages whose vectors are closest. Pick a model with at least ${MIN_EMBEDDING_CONTEXT_LENGTH} tokens of context for this library.`,
    rerankLabel: "Rerank (optional)",
    rerankHint: "Reorders passages before answering",
    rerankInfo:
      "A reranker re-scores the passages from the first search and moves the most relevant ones to the top. It is optional: leave it as None to skip this step.",
    noRerankLabel: "Include runs without rerank",
    genLabel: "Generation",
    genHint: "Writes the answer",
    genInfo:
      "The generation model reads the top passages and writes the final answer. This is the answer you compare across setups.",
    judgeLabel: "Judge model",
    judgeHint: "Scores every answer",
    judgeInfo:
      "The judge model reads each answer with the passages behind it, then scores faithfulness, correctness, and completeness. Every setup in a run is scored by the same judge.",
    fieldInfoAria: (name: string) => `What is ${name}?`,
    noneOption: "None",
    suggested: "Suggested",
    starterPreset: "Suggested setups",
    addSetup: "Add setup",
    removeSetup: "Remove setup",
    setupNumber: (n: number) => `Setup ${n}`,
    emptySetups: "Add a setup to compose your first pipeline.",
    matrixMode: "Matrix mode (cross every model)",
    matrixModeHint:
      "Pick models per stage and run every combination. Expanding fills the setup list above.",
    expandMatrix: "Expand into setups",
    advanced: "Retrieval settings",
    retrieveLabel: "Retrieve K",
    finalKLabel: "Final K",
    budgetLabel: "Budget (USD)",
    runButton: "Run",
    runningButton: "Running…",
    loadDemo: "Load demo library (100 medical abstracts)",
    loadingDemo: "Loading demo library…",
    demoLoadFailed: "Demo library failed to load",
    canvasIdleTitle: "No run in progress",
    canvasIdleBody:
      "Choose a question and configure at least one setup. Run the comparison to see every answer against the same evidence.",
    inspectorEmpty:
      "Select an answer to view its retrieved passages and the generated answer.",
    selectedSetup: "Selected setup",
    inspectorScoreAria: "Selected setup score",
    resizeAria: "Resize run and detail panes",
    runAgain: "New run",
    cancel: "Cancel run",
    escalateButton: (n: number) => `Run these setups across all ${n} questions`,
    escalateConfirmTitle: "Run the full comparison?",
    escalateConfirmBody: (trials: number, budget: string) =>
      `This runs every setup against all questions: ${trials} answers total, up to $${budget} in spend.`,
    escalateConfirm: "Run all questions",
    escalateCancel: "Not now",
    progressTitle: "Setups",
    progressHint: "Progress across every question. Select a setup to inspect one answer.",
    progressComplete: (done: number, total: number) => `${done}/${total} answered`,
    progress: (done: number, total: number) => `${done} of ${total} complete`,
    spend: (spent: string, budget: string) => `$${spent} / $${budget}`,
    elapsed: (sec: number) => `${sec.toFixed(1)}s`,
    bestScore: "Best score",
    answersTitle: "Answers",
    answersHint: "Same question, one answer per setup. Select one to see its passages.",
    answerPending: "Waiting to run",
    answerRunning: "Generating answer…",
    answerFailed: "This setup did not produce an answer.",
    answerFailedReason: (reason: string) => `Reason: ${reason}`,
    answerEmpty: "No answer returned.",
    inspectorFailure: "Why this setup failed",
    planOverLimit: "Too many answers for one run. Remove a setup or pick fewer questions.",
    setups: "Setups",
    setupCount: (n: number) => `${n} setup${n === 1 ? "" : "s"}`,
    setupsScored: (scored: number, total: number) =>
      `${scored} of ${total} setup${total === 1 ? "" : "s"} scored`,
    awaitingScores: "Waiting for scored setups",
    awaitingBestScore: "Not scored yet",
    arenaHint: "Select a setup to inspect its evidence.",
    judgeScore: "Judge score",
    judgeScoreTooltip:
      "A judge model rates faithfulness, correctness, and completeness from the retrieved passages.",
    judgeScoreAxis: "Judge score (0-100)",
    judgeOnlyBadge: "Judge-only",
    judgeOnlyTooltip:
      "No reference answer exists for this question, so correctness is not scored.",
    correctnessDimension: "Correctness",
    faithfulnessDimension: "Faithfulness",
    completenessDimension: "Completeness",
    executionTimeline: "Execution timeline",
    executionTimelineHint:
      "Clock time across setups. Bar position reveals parallel work; hover a stage for duration and attempt.",
    howItWorks: "How it works",
    githubLink: "GitHub",
    workflowsDocs: "Workflows docs",
  },
  howItWorks: {
    title: "How a comparison runs",
    steps: [
      {
        title: "One question",
        body: "Your question goes to every setup.",
      },
      {
        title: "One setup, three models",
        body: "Each setup is one combination of the three models.",
      },
      {
        title: "Durable workflow tasks",
        body: "Setups run in parallel as durable tasks. Click any answer to see the passages and scores behind it.",
      },
    ],
    footnote: "Runs are scoped to this browser session.",
  },
  results: {
    leaderboard: "Results",
    chartTitle: "Cost vs score",
    exportCsv: "Download CSV",
    columns: {
      setup: "Setup",
      quality: "Score",
      cost: "Cost",
      p50: "p50 latency",
      p95: "p95 latency",
      failures: "Failed",
    },
    selfJudgedTooltip: "The answer model scored its own output.",
    selfJudgedBadge: "self-judged",
  },
  grid: {
    legendPending: "Pending",
    legendRunning: "Running",
    legendHigh: "Complete",
    legendFailed: "Failed",
  },
  stages: {
    findPassages: (n: number) => `Retrieve (${n} passages)`,
    rerank: "Rerank",
    kept: (n: number) => `${n} passage${n === 1 ? "" : "s"} kept`,
    writeAnswer: "Generate",
    rateAnswer: (model: string) => `Judge (${model})`,
    costLatency: "Cost and latency",
    passageLabel: (idx: number) => `Passage ${idx}`,
    scores: (f: number, c: number, comp: number) =>
      `Faithfulness ${f} · Correctness ${c} · Completeness ${comp}`,
  },
  notify: {
    comparisonStarted: "Run started",
    comparisonStopped: "Run canceled",
    demoLoaded: "Demo library loaded",
  },
  common: {
    loading: "Loading…",
    tryAgain: "Retry",
    cancel: "Cancel",
    confirm: "Confirm",
    close: "Close",
    notFound: "Not found",
    notFoundBody: "This page does not exist.",
    loadFailed: "Load failed",
  },
} as const;
