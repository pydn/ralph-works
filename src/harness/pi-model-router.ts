import {
  loadModelConfig,
  type ModelConfig,
} from "../models/model-config-loader.ts";
import {
  isModelConfig,
  validateModelConfig,
} from "../models/model-config-validator.ts";
import { resolvePhaseModel } from "../models/phase-model-resolver.ts";
import type { WorkflowState } from "../state/phase-types.ts";
import type { RalphWorksContext, RalphWorksPiApi } from "./pi-harness-types.ts";

export async function loadValidModelConfig(
  ctx: RalphWorksContext,
): Promise<ModelConfig> {
  const config = await loadModelConfig(ctx.cwd);
  const errors = validateModelConfig(config);
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
  if (!isModelConfig(config)) {
    throw new Error("model.config.json must contain a valid model config.");
  }
  return config;
}

export async function getActivePhaseModelName(
  ctx: RalphWorksContext,
  state: WorkflowState,
): Promise<string | undefined> {
  return resolvePhaseModel(await loadValidModelConfig(ctx), state.currentPhase)
    ?.raw;
}

export async function routeModelForCurrentPhase(
  pi: RalphWorksPiApi,
  ctx: RalphWorksContext,
  state: WorkflowState,
): Promise<string | undefined> {
  const modelRef = resolvePhaseModel(
    await loadValidModelConfig(ctx),
    state.currentPhase,
  );
  if (!modelRef) {
    return undefined;
  }

  if (!modelRef.provider) {
    return modelRef.raw;
  }

  const model = ctx.modelRegistry?.find?.(modelRef.provider, modelRef.id);
  if (!model) {
    ctx.ui?.notify?.(`Configured model not found: ${modelRef.raw}`, "warning");
    return modelRef.raw;
  }

  const selected = await pi.setModel?.(model);
  if (selected === false) {
    ctx.ui?.notify?.(
      `No API key available for model: ${modelRef.raw}`,
      "error",
    );
  }

  return modelRef.raw;
}
