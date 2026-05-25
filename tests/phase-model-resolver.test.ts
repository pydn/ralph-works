import assert from "node:assert/strict";
import test from "node:test";

import {
  parseModelReference,
  resolvePhaseModel,
} from "../src/models/phase-model-resolver.ts";

test("phase model resolver prefers phase model over default model", () => {
  const model = resolvePhaseModel(
    {
      default_model: "anthropic/default",
      phase_models: {
        review: "openai/reviewer",
      },
    },
    "review",
  );

  assert.ok(model);
  assert.equal(model.raw, "openai/reviewer");
  assert.equal(model.provider, "openai");
  assert.equal(model.id, "reviewer");
});

test("phase model resolver falls back to default model", () => {
  const model = resolvePhaseModel(
    {
      default_model: "anthropic/default",
      phase_models: {},
    },
    "create_tasks",
  );

  assert.ok(model);
  assert.equal(model.raw, "anthropic/default");
});

test("phase model resolver returns undefined without a configured model", () => {
  assert.equal(
    resolvePhaseModel({ default_model: undefined, phase_models: {} }, "review"),
    undefined,
  );
});

test("model references may be provider/model or bare model ids", () => {
  assert.deepEqual(parseModelReference("openai/gpt-5"), {
    raw: "openai/gpt-5",
    provider: "openai",
    id: "gpt-5",
  });
  assert.deepEqual(parseModelReference("local-model"), {
    raw: "local-model",
    provider: undefined,
    id: "local-model",
  });
});
