import assert from "node:assert/strict";
import test from "node:test";
import {
  CostOperationError,
  ProviderCallError,
  WorkflowDispatchError,
  isNonRetryableProviderError,
  providerErrorDetail,
  safePersistedError,
} from "../dist/errors.js";

test("provider failures keep the upstream reason without repetitive error text", () => {
  const rateLimited = new ProviderCallError(
    "OpenRouter /chat/completions failed with HTTP 429",
    false,
    429,
    undefined,
    "rate_limited",
    undefined,
    "Provider returned rate limit exceeded"
  );
  assert.equal(
    safePersistedError(rateLimited, "Trial failed"),
    "OpenRouter /chat/completions failed with HTTP 429: Provider returned rate limit exceeded · Wait a moment or run fewer setups."
  );

  const missingModel = new ProviderCallError(
    "OpenRouter /chat/completions failed with HTTP 404",
    false,
    404,
    undefined,
    "invalid_model",
    undefined,
    "No endpoints found for anthropic/claude-fable-5"
  );
  assert.equal(
    safePersistedError(missingModel, "Trial failed"),
    "OpenRouter /chat/completions failed with HTTP 404: No endpoints found for anthropic/claude-fable-5 · Pick a different model."
  );

  const tooLong = new ProviderCallError(
    "OpenRouter /embeddings failed with HTTP 400",
    false,
    400,
    undefined,
    "input_too_long",
    undefined,
    "Embedding input has 835 tokens, exceeding the model maximum of 512."
  );
  assert.match(safePersistedError(tooLong, "Trial failed"), /larger context window/);
  assert.equal(isNonRetryableProviderError(tooLong), true);
  assert.equal(isNonRetryableProviderError(rateLimited), false);
});

test("duplicate provider detail is shown once", () => {
  const error = new ProviderCallError(
    "OpenRouter request failed",
    false,
    500,
    undefined,
    undefined,
    undefined,
    "OpenRouter request failed"
  );
  assert.equal(safePersistedError(error, "Trial failed"), "OpenRouter request failed");
});

test("provider bodies are parsed and secrets are redacted", () => {
  assert.equal(
    providerErrorDetail(
      JSON.stringify({
        error: {
          message: "No endpoints found",
          metadata: { raw: "token sk-live-secret1234 was rejected" },
        },
      })
    ),
    "No endpoints found (token [redacted] was rejected)"
  );
});

test("unknown errors collapse to the fallback", () => {
  assert.equal(
    safePersistedError(new Error("secret stack /Users/ojus/key"), "Trial failed"),
    "Trial failed"
  );
});

test("workflow and cost errors keep their crafted messages", () => {
  assert.equal(
    safePersistedError(
      new WorkflowDispatchError("workflow_not_found", "Workflow not found", "missing"),
      "dispatch failed"
    ),
    "Workflow not found: missing"
  );
  assert.equal(
    safePersistedError(new CostOperationError("Budget exceeded", false), "cost failed"),
    "Budget exceeded"
  );
});
