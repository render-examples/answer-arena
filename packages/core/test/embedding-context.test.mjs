import assert from "node:assert/strict";
import test from "node:test";
import {
  MIN_EMBEDDING_CONTEXT_LENGTH,
  classifyProviderHttpStatus,
  embeddingContextFitsChunks,
  embeddingContextTooShortMessage,
  tooShortEmbeddingModels,
} from "../dist/index.js";

test("chunk-sized embedding windows are rejected, unknown windows are allowed", () => {
  assert.equal(embeddingContextFitsChunks(512), false);
  assert.equal(embeddingContextFitsChunks(MIN_EMBEDDING_CONTEXT_LENGTH), true);
  assert.equal(embeddingContextFitsChunks(undefined), true);
});

test("tooShortEmbeddingModels reports only published windows below the floor", () => {
  const short = tooShortEmbeddingModels(
    ["baai/bge-base-en-v1.5", "baai/bge-m3", "unknown/embed"],
    [
      { id: "baai/bge-base-en-v1.5", contextLength: 512 },
      { id: "baai/bge-m3", contextLength: 8194 },
    ]
  );
  assert.deepEqual(short, [
    { id: "baai/bge-base-en-v1.5", contextLength: 512 },
  ]);
  assert.match(
    embeddingContextTooShortMessage("baai/bge-base-en-v1.5", 512),
    /512 tokens/
  );
});

test("token overflow 400s classify as input_too_long, not invalid_model", () => {
  assert.equal(
    classifyProviderHttpStatus(
      400,
      '{"message":"Embedding input has 835 tokens, exceeding the model maximum of 512."}'
    ),
    "input_too_long"
  );
  assert.equal(
    classifyProviderHttpStatus(400, '{"message":"No endpoints found for this model"}'),
    "invalid_model"
  );
  assert.equal(classifyProviderHttpStatus(404), "invalid_model");
});
