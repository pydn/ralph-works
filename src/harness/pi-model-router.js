import { loadModelConfig } from "../models/model-config-loader.js";
import { validateModelConfig } from "../models/model-config-validator.js";
import { resolvePhaseModel } from "../models/phase-model-resolver.js";

export async function loadValidModelConfig(ctx) {
  const config = await loadModelConfig(ctx.cwd);
  const errors = validateModelConfig(config);
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
  return config;
}

export async function getActivePhaseModelName(ctx, state) {
  return resolvePhaseModel(await loadValidModelConfig(ctx), state.currentPhase)?.raw;
}

export async function routeModelForCurrentPhase(pi, ctx, state) {
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
    ctx.ui?.notify?.(`No API key available for model: ${modelRef.raw}`, "error");
  }

  return modelRef.raw;
}
