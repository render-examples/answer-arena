import { and, eq, inArray, isNull, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  runConfigSchema,
  getAppConfig,
  envNumber,
  comboLabel,
  safePersistedError,
  WorkflowDispatchError,
  RunAdmissionError,
  checkRunAdmission,
  STRANDED_DRAFT_SECONDS,
  ABANDONED_RUN_SECONDS,
  embeddingContextTooShortMessage,
  tooShortEmbeddingModels,
} from "@ragtime/core";
import { createWorkflowDispatcher } from "@ragtime/composition";
import {
  getDb,
  schema,
  getComboResults,
  listRunEvents,
  getPhaseCounters,
  getChunksByIds,
  appendRunEvent,
  transitionRun,
  countActiveRuns,
  lockRunAdmission,
  reapAbandonedRuns,
  getActiveRunForSession,
} from "@ragtime/db";
import { getOwnedRun } from "../lib/ownership.js";
import { asSessionRequest } from "../types.js";
import { createRunPlan, getRunPlanRejection } from "./run-plan.js";
import { getModelCatalog } from "../lib/catalog-cache.js";

const { questions, runs, combos, trials } = schema;

const ACTIVE = new Set(["ingesting", "running", "aggregating"]);

/** Snapshot of question ids stored on the run config (empty when "all"). */
function persistedQuestionSnapshot(config: unknown): string[] {
  const parsed = runConfigSchema.safeParse(config);
  return parsed.success && parsed.data.questionIds !== "all"
    ? parsed.data.questionIds
    : [];
}

/** Create, start, poll, cancel, and list comparison runs for the session. */
export function registerRunRoutes(app: FastifyInstance): void {
  const db = getDb();
  const config = getAppConfig();
  const workflowDispatcher = createWorkflowDispatcher(config.workflowSlug);

  app.post("/api/runs", async (req, reply) => {
    const { sessionId } = asSessionRequest(req);
    const parsed = runConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const body = parsed.data;
    const maxBudget = envNumber("MAX_RUN_BUDGET_USD", 5);
    const budgetUsd = Math.min(body.budgetUsd ?? maxBudget, maxBudget);

    const requestedQuestionPredicate =
      body.questionIds === "all"
        ? and(
            eq(questions.corpusId, body.corpusId),
            or(isNull(questions.sessionId), eq(questions.sessionId, sessionId))
          )
        : and(
            eq(questions.corpusId, body.corpusId),
            inArray(questions.id, body.questionIds),
            or(isNull(questions.sessionId), eq(questions.sessionId, sessionId))
          );
    const authorizedQuestions = await db
      .select({ id: questions.id })
      .from(questions)
      .where(requestedQuestionPredicate);
    const maxTrials = envNumber("MAX_TRIALS_PER_RUN", 324);
    const plan = createRunPlan(
      body,
      authorizedQuestions.map((question) => question.id),
      { judgeModelFallback: config.judgeModel }
    );

    const rejection = getRunPlanRejection(plan, maxTrials);
    if (rejection) {
      return reply.status(rejection.statusCode).send({ error: rejection.error });
    }

    try {
      const catalog = await getModelCatalog();
      const tooShort = tooShortEmbeddingModels(
        plan.config.embeddingModels,
        catalog.embedding
      );
      if (tooShort[0]) {
        return reply.status(400).send({
          error: embeddingContextTooShortMessage(
            tooShort[0].id,
            tooShort[0].contextLength
          ),
          code: "input_too_long",
        });
      }
    } catch {
      // Catalog lookup is a guardrail, not a hard dependency of run creation.
    }

    let run: typeof runs.$inferSelect;
    try {
      run = await db.transaction(async (tx) => {
        // Decide admission under a lock so two simultaneous requests cannot
        // both read a stale count and both start a run.
        await lockRunAdmission(tx);
        await reapAbandonedRuns(tx, {
          strandedDraftSeconds: STRANDED_DRAFT_SECONDS,
          abandonedRunSeconds: ABANDONED_RUN_SECONDS,
        });
        const rejection = checkRunAdmission(
          await countActiveRuns(tx, sessionId),
          {
            maxActiveRunsPerSession: config.maxActiveRunsPerSession,
            maxActiveRunsTotal: config.maxActiveRunsTotal,
          }
        );
        if (rejection) throw rejection;

        const [createdRun] = await tx
          .insert(runs)
          .values({
            corpusId: plan.config.corpusId,
            sessionId,
            name: plan.config.name,
            status: "draft",
            config: plan.config,
            budgetUsd: String(budgetUsd),
          })
          .returning();
        if (!createdRun) throw new Error("Failed to create run.");

        const relevanceThreshold =
          plan.config.relevanceThreshold != null
            ? String(plan.config.relevanceThreshold)
            : null;
        const comboSeeds = plan.config.setups
          ? plan.config.setups.map((setup) => ({
              embeddingModel: setup.embeddingModel,
              rerankModel: setup.rerankModel,
              genModel: setup.genModel,
            }))
          : plan.config.embeddingModels.flatMap((embeddingModel) =>
              plan.config.rerankModels.flatMap((rerankModel) =>
                plan.config.genModels.map((genModel) => ({
                  embeddingModel,
                  rerankModel,
                  genModel,
                }))
              )
            );
        const comboRows = comboSeeds.map((seed) => ({
          runId: createdRun.id,
          embeddingModel: seed.embeddingModel,
          rerankModel: seed.rerankModel,
          genModel: seed.genModel,
          retrieveK: plan.config.retrieveK,
          finalK: plan.config.finalK,
          relevanceThreshold,
        }));
        await tx.insert(combos).values(comboRows);
        return createdRun;
      });
    } catch (err) {
      if (err instanceof RunAdmissionError) {
        reply.header("Retry-After", String(err.retryAfterSeconds));
        return reply.status(429).send({ error: err.message, code: err.code });
      }
      throw err;
    }

    try {
      await workflowDispatcher.dispatch("run_bakeoff", [run.id]);
    } catch (err) {
      const failure =
        err instanceof WorkflowDispatchError
          ? err
          : new WorkflowDispatchError(
              "workflow_unavailable",
              "The workflow dispatcher could not start the task.",
              err instanceof Error ? err.message : String(err)
            );
      const publicError = safePersistedError(err, failure.message);
      app.log.error(
        {
          runId: run.id,
          errorName: err instanceof Error ? err.name : "Unknown",
          code: failure.code,
          statusCode: failure.statusCode,
          detail: failure.detail,
        },
        "Workflow start failed"
      );
      const failed = await transitionRun(db, run.id, "draft", "failed", {
        error: publicError,
        finishedAt: new Date(),
      });
      if (failed) {
        await appendRunEvent(db, run.id, "run.status", {
          status: "failed",
          error: publicError,
        });
      }
      return reply.status(502).send({ error: publicError, code: failure.code });
    }

    return { data: { runId: run.id } };
  });

  // Static segment, so this is matched ahead of /api/runs/:id.
  app.get("/api/runs/active", async (req) => {
    const { sessionId } = asSessionRequest(req);
    return { data: await getActiveRunForSession(db, sessionId) };
  });

  app.get<{ Params: { id: string } }>("/api/runs/:id", async (req, reply) => {
    const { sessionId } = asSessionRequest(req);
    const run = await getOwnedRun(db, req.params.id, sessionId);
    if (!run) return reply.status(404).send({ error: "Not found" });

    const comboResults = await getComboResults(db, req.params.id);
    const snapshotQuestionIds = persistedQuestionSnapshot(run.config);
    const grid =
      snapshotQuestionIds.length > 0
        ? await db
            .select({
              trialId: trials.id,
              comboId: trials.comboId,
              questionId: trials.questionId,
              status: trials.status,
              overallScore: trials.overallScore,
              attempts: trials.attempts,
              answer: trials.answer,
              error: trials.error,
            })
            .from(trials)
            .where(
              and(
                eq(trials.runId, req.params.id),
                inArray(trials.questionId, snapshotQuestionIds)
              )
            )
        : [];

    const questionIds = [...new Set(grid.map((g) => g.questionId))];
    const questionRows =
      questionIds.length > 0
        ? await db
            .select({
              id: questions.id,
              text: questions.text,
              referenceAnswer: questions.referenceAnswer,
            })
            .from(questions)
            .where(inArray(questions.id, questionIds))
        : [];

    // A question with no reference answer is scored "judge-only": no correctness.
    const judgeOnlyQuestionIds = new Set(
      questionRows.filter((q) => q.referenceAnswer == null).map((q) => q.id)
    );

    const phases = await getPhaseCounters(db, req.params.id, run.corpusId);

    return {
      data: {
        run,
        phases,
        comboResults: comboResults.map((c) => ({
          ...c,
          label: comboLabel(c.embeddingModel, c.rerankModel, c.genModel),
        })),
        grid: grid.map((cell) => ({
          ...cell,
          judgeOnly: judgeOnlyQuestionIds.has(cell.questionId),
        })),
        questions: questionRows.map((q) => ({ id: q.id, text: q.text })),
      },
    };
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    "/api/runs/:id/events",
    async (req, reply) => {
      const { sessionId } = asSessionRequest(req);
      const run = await getOwnedRun(db, req.params.id, sessionId);
      if (!run) return reply.status(404).send({ error: "Not found" });

      const after = Number(req.query.after ?? 0);
      const rows = await listRunEvents(db, req.params.id, after);
      return {
        data: rows.map((r) => ({
          id: Number(r.id),
          runId: r.run_id,
          at: r.at,
          type: r.type,
          entityId: r.entity_id,
          payload: r.payload,
        })),
      };
    }
  );

  app.post<{ Params: { id: string } }>("/api/runs/:id/cancel", async (req, reply) => {
    const { sessionId } = asSessionRequest(req);
    const run = await getOwnedRun(db, req.params.id, sessionId);
    if (!run) return reply.status(404).send({ error: "Not found" });

    if (["complete", "failed", "canceled", "budget_exceeded"].includes(run.status)) {
      return { data: { canceled: run.status === "canceled", status: run.status } };
    }

    const canceled = await transitionRun(
      db,
      req.params.id,
      ["draft", "ingesting", "running", "aggregating"],
      "canceled",
      { finishedAt: new Date() }
    );
    if (canceled) {
      await appendRunEvent(db, req.params.id, "run.status", {
        status: "canceled",
      });
      return { data: { canceled: true, status: "canceled" } };
    }

    const current = await getOwnedRun(db, req.params.id, sessionId);
    return {
      data: {
        canceled: current?.status === "canceled",
        status: current?.status ?? "missing",
      },
    };
  });
}

export { ACTIVE };
