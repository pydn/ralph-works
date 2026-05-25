import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  loadModelConfig,
  type ModelConfig,
} from "../src/models/model-config-loader.ts";
import { validateModelConfig } from "../src/models/model-config-validator.ts";

test("missing model config falls back to no active model override", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ralph-models-"));
  try {
    const config = (await loadModelConfig(dir)) as ModelConfig;

    assert.deepEqual(config, {
      default_model: undefined,
      phase_models: {},
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("valid model config supports default and phase-specific models", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ralph-models-"));
  try {
    await writeFile(
      path.join(dir, "model.config.json"),
      JSON.stringify({
        default_model: "anthropic/claude-default",
        phase_models: {
          generate_spec: "openai/gpt-spec",
          review: "anthropic/claude-review",
        },
      }),
    );

    const config = (await loadModelConfig(dir)) as ModelConfig;

    assert.deepEqual(validateModelConfig(config), []);
    assert.equal(config.phase_models.review, "anthropic/claude-review");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("invalid model config reports invalid phases", () => {
  const errors = validateModelConfig({
    default_model: 42,
    phase_models: {
      nope: "model",
      review: "",
    },
  });

  assert.match(errors.join("\n"), /default_model/);
  assert.match(errors.join("\n"), /phase_models\.nope/);
  assert.match(errors.join("\n"), /phase_models\.review/);
});
