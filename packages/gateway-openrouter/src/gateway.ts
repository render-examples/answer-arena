import {
  ProviderCallError,
  classifyProviderHttpStatus,
  providerErrorDetail,
  type CatalogWarning,
  type GatewayIdentity,
  type ModelGateway,
  type ModelInfo,
  type ProviderErrorCode,
} from "@ragtime/core";

const BASE_URL = "https://openrouter.ai/api/v1";
const CREDITS_URL = "https://openrouter.ai/settings/credits";
const DOCS_URL = "https://openrouter.ai/docs";

const GATEWAY_IDENTITY: GatewayIdentity = {
  id: "openrouter",
  label: "OpenRouter",
  docsUrl: DOCS_URL,
  creditsUrl: CREDITS_URL,
};

/** Maps an HTTP status (and optional body text) to a stable error code. */
function classifyStatus(
  status: number,
  bodyText?: string
): ProviderErrorCode | undefined {
  return classifyProviderHttpStatus(status, bodyText);
}

function helpUrlForCode(code: ProviderErrorCode | undefined): string | undefined {
  return code === "insufficient_credits" ? CREDITS_URL : undefined;
}
const DEFAULT_MAX_COMPLETION_TOKENS = 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_GET_ATTEMPTS = 4;
const MAX_RETRY_DELAY_MS = 5_000;
const ROUTING_TOKEN_OVERHEAD = 4_096;
const GENERATION_LOOKUP_ATTEMPTS = 4;
const GENERATION_LOOKUP_DELAY_MS = 50;

function requireMaxCost(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("maxCostUsd must be a positive finite number");
  }
  return value;
}

function serializedTokenUpperBound(value: unknown): number {
  return Math.max(
    1,
    Buffer.byteLength(JSON.stringify(value), "utf8") + ROUTING_TOKEN_OVERHEAD
  );
}

function knownCost(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const rawMs = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(value) - Date.now();
  if (!Number.isFinite(rawMs) || rawMs <= 0) return undefined;
  return Math.min(rawMs, MAX_RETRY_DELAY_MS);
}

function boundedProviderPricing(args: {
  maxCostUsd: number;
  promptTokenUpperBound: number;
  completionTokenUpperBound?: number;
}) {
  const maxCostUsd = requireMaxCost(args.maxCostUsd);
  const hasCompletion = (args.completionTokenUpperBound ?? 0) > 0;
  const buckets = hasCompletion ? 3 : 2;
  const maxPrice: Record<string, number> = {
    request: maxCostUsd / buckets,
    prompt:
      ((maxCostUsd / buckets) * 1_000_000) /
      Math.max(1, args.promptTokenUpperBound),
  };
  if (hasCompletion) {
    maxPrice.completion =
      ((maxCostUsd / buckets) * 1_000_000) /
      Math.max(1, args.completionTokenUpperBound!);
  }
  return {
    sort: "price",
    max_price: maxPrice,
    allow_fallbacks: false,
    require_parameters: true,
  };
}

/** Builds a ModelGateway that talks to OpenRouter (catalog + chat/embed/rerank). */
export function createOpenRouterGateway(options?: {
  apiKey?: string;
  appUrl?: string;
  appTitle?: string;
}): ModelGateway {
  const apiKey = options?.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required");
  const appUrl = options?.appUrl ?? process.env.APP_URL ?? "http://localhost:5173";
  const appTitle = options?.appTitle ?? process.env.OPENROUTER_APP_TITLE ?? "Answer Arena";

  const headers = (): Record<string, string> => ({
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": appUrl,
    "X-OpenRouter-Title": appTitle,
  });

  async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_GET_ATTEMPTS; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        const status = (err as { status?: number }).status;
        const retryable =
          status === 429 ||
          (status !== undefined && status >= 500) ||
          (err instanceof ProviderCallError &&
            !err.billingAmbiguous &&
            status === undefined) ||
          err instanceof TypeError ||
          (err instanceof Error &&
            (err.name === "AbortError" || err.name === "TimeoutError"));
        if (!retryable || attempt === MAX_GET_ATTEMPTS - 1) break;
        const requestedDelay = (err as { retryAfterMs?: number }).retryAfterMs;
        const delay =
          requestedDelay ??
          Math.min(
            500 * 2 ** attempt + Math.random() * 250,
            MAX_RETRY_DELAY_MS
          );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastError;
  }

  async function request<T>(path: string, body?: unknown): Promise<T> {
    const execute = async () => {
      let res: Response;
      try {
        res = await fetch(`${BASE_URL}${path}`, {
          method: body ? "POST" : "GET",
          headers: headers(),
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "OpenRouter request failed";
        throw new ProviderCallError(
          message,
          body !== undefined,
          undefined,
          undefined,
          "provider_unavailable"
        );
      }
      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        const code = classifyStatus(res.status, bodyText);
        throw new ProviderCallError(
          `OpenRouter ${path} failed with HTTP ${res.status}`,
          body !== undefined && res.status >= 500,
          res.status,
          retryAfterMs(res.headers.get("retry-after")),
          code,
          helpUrlForCode(code),
          providerErrorDetail(bodyText)
        );
      }
      const text = await res.text();
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new ProviderCallError(
          `OpenRouter ${path} returned an invalid JSON response`,
          body !== undefined,
          res.status,
          undefined,
          undefined,
          undefined,
          providerErrorDetail(text)
        );
      }
    };

    // A lost response to a paid POST is billing-ambiguous. Retrying it inside the
    // same durable reservation could spend the reservation more than once.
    return body === undefined ? withRetry(execute) : execute();
  }

  async function generationCost(generationId: string): Promise<{
    costUsd: number | undefined;
    provider?: string;
    inputTokens?: number;
    outputTokens?: number;
  }> {
    for (let attempt = 0; attempt < GENERATION_LOOKUP_ATTEMPTS; attempt++) {
      try {
        const gen = await request<{
          data?: {
            total_cost?: number;
            native_tokens_prompt?: number;
            native_tokens_completion?: number;
            provider_name?: string;
          };
        }>(`/generation?id=${encodeURIComponent(generationId)}`);
        return {
          costUsd: knownCost(gen.data?.total_cost),
          provider: gen.data?.provider_name,
          inputTokens: gen.data?.native_tokens_prompt,
          outputTokens: gen.data?.native_tokens_completion,
        };
      } catch (error) {
        const status =
          error instanceof ProviderCallError ? error.status : undefined;
        if (
          status === 404 &&
          attempt < GENERATION_LOOKUP_ATTEMPTS - 1
        ) {
          await new Promise((resolve) =>
            setTimeout(
              resolve,
              GENERATION_LOOKUP_DELAY_MS * 2 ** attempt
            )
          );
          continue;
        }
        return { costUsd: undefined };
      }
    }
    return { costUsd: undefined };
  }

  return {
    async chat(req) {
      const start = Date.now();
      const body: Record<string, unknown> = {
        model: req.model,
        messages: req.messages,
        usage: { include: true },
      };
      if (req.maxCostUsd != null) {
        const maxTokens = req.maxTokens ?? DEFAULT_MAX_COMPLETION_TOKENS;
        body.max_tokens = maxTokens;
        body.provider = boundedProviderPricing({
          maxCostUsd: req.maxCostUsd,
          promptTokenUpperBound: serializedTokenUpperBound(req.messages),
          completionTokenUpperBound: maxTokens,
        });
      } else if (req.maxTokens != null) {
        body.max_tokens = req.maxTokens;
      }
      if (req.jsonSchema) {
        body.response_format = {
          type: "json_schema",
          json_schema: { name: "response", strict: true, schema: req.jsonSchema },
        };
      }
      const completion = await request<{
        id?: string;
        choices?: { message?: { content?: string } }[];
        usage?: { cost?: number; prompt_tokens?: number; completion_tokens?: number };
      }>("/chat/completions", body);

      let costUsd = knownCost(completion.usage?.cost);
      let provider: string | undefined;
      const generationId = completion.id;
      let tokens = {
        input: completion.usage?.prompt_tokens,
        output: completion.usage?.completion_tokens,
      };

      if (costUsd === undefined && generationId) {
        const gen = await generationCost(generationId);
        costUsd = gen.costUsd;
        provider = gen.provider;
        tokens = {
          input: gen.inputTokens,
          output: gen.outputTokens,
        };
      }

      return {
        text: completion.choices?.[0]?.message?.content ?? "",
        receipt: {
          latencyMs: Date.now() - start,
          costUsd: costUsd ?? 0,
          costUnknown: costUsd === undefined,
          tokens,
          provider,
          generationId,
        },
      };
    },

    async embed(req) {
      const start = Date.now();
      const body: Record<string, unknown> = { model: req.model, input: req.input };
      if (req.maxCostUsd != null) {
        body.provider = boundedProviderPricing({
          maxCostUsd: req.maxCostUsd,
          promptTokenUpperBound: serializedTokenUpperBound(req.input),
        });
      }
      const response = await request<{
        id?: string;
        data?: { embedding: number[] }[];
        usage?: { cost?: number; total_tokens?: number };
      }>("/embeddings", body);

      const vectors = (response.data ?? []).map((d) => d.embedding);
      const dims = vectors[0]?.length ?? 0;
      let costUsd = knownCost(response.usage?.cost);
      if (costUsd === undefined && response.id) {
        costUsd = (await generationCost(response.id)).costUsd;
      }
      return {
        vectors,
        dims,
        receipt: {
          latencyMs: Date.now() - start,
          costUsd: costUsd ?? 0,
          costUnknown: costUsd === undefined,
          tokens: { input: response.usage?.total_tokens },
        },
      };
    },

    async rerank(req) {
      const start = Date.now();
      const body: Record<string, unknown> = {
        model: req.model,
        query: req.query,
        documents: req.documents,
        top_n: req.topN,
      };
      if (req.maxCostUsd != null) {
        body.provider = boundedProviderPricing({
          maxCostUsd: req.maxCostUsd,
          promptTokenUpperBound: serializedTokenUpperBound({
            query: req.query,
            documents: req.documents,
          }),
        });
      }
      const data = await request<{
        id?: string;
        results?: { index: number; relevance_score: number }[];
        usage?: { cost?: number };
      }>("/rerank", body);
      let costUsd = knownCost(data.usage?.cost);
      if (costUsd === undefined && data.id) {
        costUsd = (await generationCost(data.id)).costUsd;
      }

      return {
        results: (data.results ?? []).map((r) => ({
          index: r.index,
          relevance: r.relevance_score,
        })),
        receipt: {
          latencyMs: Date.now() - start,
          costUsd: costUsd ?? 0,
          costUnknown: costUsd === undefined,
        },
      };
    },

    async catalog() {
      type ModelRow = {
        id: string;
        name?: string;
        context_length?: number;
        pricing?: { prompt?: string; completion?: string; request?: string };
        architecture?: { output_modalities?: string[] };
      };

      const warnings: CatalogWarning[] = [];

      // GET /models defaults to output_modalities=text, which excludes embeddings and rerank.
      const [allModels, embeddingOnly] = await Promise.all([
        request<{ data?: ModelRow[] }>("/models?output_modalities=all"),
        // A failure here must not masquerade as "this gateway has no embedding models".
        request<{ data?: ModelRow[] }>("/embeddings/models").catch((err: unknown) => {
          warnings.push({
            source: "/embeddings/models",
            message: err instanceof Error ? err.message : String(err),
          });
          return { data: [] as ModelRow[] };
        }),
      ]);

      const byId = new Map<string, ModelRow>();
      for (const m of [...(allModels.data ?? []), ...(embeddingOnly.data ?? [])]) {
        byId.set(m.id, m);
      }

      const embedding: ModelInfo[] = [];
      const rerank: ModelInfo[] = [];
      const chat: ModelInfo[] = [];

      for (const m of byId.values()) {
        const modalities = m.architecture?.output_modalities ?? [];
        const entry: ModelInfo = {
          id: m.id,
          name: m.name ?? m.id,
          contextLength: m.context_length,
          pricing: m.pricing,
        };
        if (modalities.includes("embeddings") || m.id.includes("embedding")) {
          embedding.push(entry);
        } else if (modalities.includes("rerank") || m.id.includes("rerank")) {
          rerank.push(entry);
        } else if (modalities.includes("text") || modalities.length === 0) {
          chat.push(entry);
        }
      }

      embedding.sort((a, b) => a.name.localeCompare(b.name));
      rerank.sort((a, b) => a.name.localeCompare(b.name));
      chat.sort((a, b) => a.name.localeCompare(b.name));

      return { embedding, rerank, chat, gateway: GATEWAY_IDENTITY, warnings };
    },
  };
}
