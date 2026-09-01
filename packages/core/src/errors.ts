const MAX_PERSISTED_ERROR_LENGTH = 1000;
const MAX_DETAIL_LENGTH = 400;

/** Error names whose messages are safe to show and store (no secrets / vendor dumps). */
const PUBLIC_ERROR_NAMES = new Set([
  "SafeUrlFetchError",
  "ProviderCallError",
  "WorkflowDispatchError",
  "CostOperationError",
  "BudgetReservationError",
  "ChaosError",
]);

/** Machine-readable classification for a provider failure. */
export type ProviderErrorCode =
  | "insufficient_credits"
  | "rate_limited"
  | "auth"
  | "invalid_model"
  | "input_too_long"
  | "provider_unavailable";

/** Beginner-readable hint appended to the upstream text for each known code. */
const PROVIDER_CODE_HINTS: Record<ProviderErrorCode, string> = {
  insufficient_credits: "Add provider credits, then retry.",
  rate_limited: "Wait a moment or run fewer setups.",
  auth: "Check OPENROUTER_API_KEY.",
  invalid_model: "Pick a different model.",
  input_too_long:
    "This embedding model's context is shorter than the document chunks. Pick a model with a larger context window.",
  provider_unavailable: "Retry when the provider is available.",
};

/** Maps HTTP status (and optional body text) to a stable provider error code. */
export function classifyProviderHttpStatus(
  status: number,
  bodyText?: string
): ProviderErrorCode | undefined {
  if (status === 402) return "insufficient_credits";
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "invalid_model";
  if (status === 400) {
    const body = bodyText ?? "";
    if (/token/i.test(body) && /exceed/i.test(body)) return "input_too_long";
    return /model/i.test(body) ? "invalid_model" : undefined;
  }
  if (status >= 500) return "provider_unavailable";
  return undefined;
}

/** True when retrying the same call cannot succeed. */
export function isNonRetryableProviderError(error: unknown): boolean {
  if (!(error instanceof ProviderCallError)) return false;
  if (
    error.status === 400 ||
    error.status === 401 ||
    error.status === 403 ||
    error.status === 404 ||
    error.status === 402
  ) {
    return true;
  }
  return (
    error.code === "invalid_model" ||
    error.code === "input_too_long" ||
    error.code === "auth" ||
    error.code === "insufficient_credits"
  );
}

/**
 * Upstream bodies are echoed to operators, so drop anything token-shaped before
 * it reaches the database, the UI, or logs.
 */
function redactSecrets(text: string): string {
  return text
    .replace(/\b(sk|rnd|key)[-_][A-Za-z0-9._-]{8,}/gi, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, "Bearer [redacted]")
    .replace(/([?&](?:api[_-]?key|token|secret)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, "//[redacted]@");
}

function clean(text: string, maxLength: number): string {
  return redactSecrets(text)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function uniqueParts(parts: Array<string | undefined>): string[] {
  const result: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    const cleaned = clean(part, MAX_PERSISTED_ERROR_LENGTH);
    if (!cleaned) continue;
    const normalized = cleaned.toLocaleLowerCase();
    if (
      result.some((existing) => {
        const current = existing.toLocaleLowerCase();
        return current === normalized || current.includes(normalized);
      })
    ) {
      continue;
    }
    result.push(cleaned);
  }
  return result;
}

/**
 * Persist only errors explicitly produced as safe public messages.
 * Provider and workflow failures keep the upstream text so an operator can tell
 * a rate limit from a retired model slug. Unknown errors collapse to the
 * fallback, so stack traces never land in the database or UI.
 */
export function safePersistedError(
  error: unknown,
  fallback = "Operation failed"
): string {
  if (error instanceof ProviderCallError) {
    const hint = error.code ? PROVIDER_CODE_HINTS[error.code] : undefined;
    const source = uniqueParts([error.message, error.detail]).join(": ");
    return clean(
      uniqueParts([source, hint]).join(" · "),
      MAX_PERSISTED_ERROR_LENGTH
    );
  }
  if (error instanceof WorkflowDispatchError) {
    return clean(
      uniqueParts([error.message, error.detail]).join(": "),
      MAX_PERSISTED_ERROR_LENGTH
    );
  }
  if (
    error instanceof Error &&
    PUBLIC_ERROR_NAMES.has(error.name) &&
    error.message.trim() !== ""
  ) {
    return clean(error.message, MAX_PERSISTED_ERROR_LENGTH);
  }
  return clean(fallback, MAX_PERSISTED_ERROR_LENGTH);
}

/** Normalizes an upstream error body into a short, secret-free detail string. */
export function providerErrorDetail(bodyText: string | undefined): string | undefined {
  if (!bodyText || bodyText.trim() === "") return undefined;
  let message: string | undefined;
  try {
    const parsed = JSON.parse(bodyText) as {
      error?: { message?: unknown; metadata?: { raw?: unknown } } | string;
      message?: unknown;
    };
    const candidate =
      typeof parsed.error === "string"
        ? parsed.error
        : typeof parsed.error?.message === "string"
          ? parsed.error.message
          : typeof parsed.message === "string"
            ? parsed.message
            : undefined;
    const raw = typeof parsed.error === "object" ? parsed.error?.metadata?.raw : undefined;
    if (candidate) {
      message = typeof raw === "string" ? `${candidate} (${raw})` : candidate;
    }
  } catch {
    // Arbitrary text can echo prompts or HTML. Keep only structured provider
    // error fields, which are useful without reflecting a whole response body.
    return "Provider returned a non-JSON error response";
  }
  if (!message) return undefined;
  const detail = clean(message, MAX_DETAIL_LENGTH);
  return detail === "" ? undefined : detail;
}

/**
 * Provider failure annotated with whether the paid request may have executed.
 * Unknown errors are treated as billing-ambiguous by the cost pipeline.
 */
export class ProviderCallError extends Error {
  override readonly name = "ProviderCallError";

  constructor(
    message: string,
    readonly billingAmbiguous: boolean,
    readonly status?: number,
    readonly retryAfterMs?: number,
    /** Code-based classification so callers never string-match error text. */
    readonly code?: ProviderErrorCode,
    /** Adapter-supplied link that helps the user resolve this error. */
    readonly helpUrl?: string,
    /** Upstream message, kept so operators can debug the real cause. */
    readonly detail?: string
  ) {
    super(message);
  }
}

/** A costed operation that cannot be replayed without risking a second charge. */
export class CostOperationError extends Error {
  override readonly name = "CostOperationError";

  constructor(
    message: string,
    readonly retryable: boolean,
    readonly originalError?: unknown
  ) {
    super(message);
  }
}

export type WorkflowDispatchErrorCode =
  | "workflow_auth"
  | "workflow_not_found"
  | "workflow_unavailable";

/** Vendor-neutral workflow start failure returned by dispatcher adapters. */
export class WorkflowDispatchError extends Error {
  override readonly name = "WorkflowDispatchError";

  constructor(
    readonly code: WorkflowDispatchErrorCode,
    message: string,
    readonly detail: string,
    readonly statusCode?: number
  ) {
    super(message);
  }
}
