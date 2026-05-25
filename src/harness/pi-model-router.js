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
  return resolvePhaseModel(await loadValidModelConfig(ctx), state.currentPhase)
    ?.raw;
}

function rawOnlyModelTarget(modelRef) {
  return { raw: modelRef.raw };
}

function appendableModelTarget(modelRef) {
  return {
    provider: modelRef.provider,
    id: modelRef.id,
    raw: modelRef.raw,
  };
}

function notifyMissingModel(ctx, rawModel) {
  ctx.ui?.notify?.(`Configured model not found: ${rawModel}`, "warning");
}

function notifyMissingAuth(ctx, rawModel) {
  ctx.ui?.notify?.(`No API key available for model: ${rawModel}`, "error");
}

function findConfiguredModel(ctx, modelTarget) {
  if (!modelTarget?.provider) {
    return undefined;
  }

  const modelId = modelTarget.id ?? modelTarget.modelId;
  if (!modelId) {
    return undefined;
  }

  return ctx.modelRegistry?.find?.(modelTarget.provider, modelId);
}

export async function resolveModelTargetForCurrentPhase(ctx, state) {
  const modelRef = resolvePhaseModel(
    await loadValidModelConfig(ctx),
    state.currentPhase,
  );
  if (!modelRef) {
    return undefined;
  }

  if (!modelRef.provider) {
    return rawOnlyModelTarget(modelRef);
  }

  const model = ctx.modelRegistry?.find?.(modelRef.provider, modelRef.id);
  if (!model) {
    notifyMissingModel(ctx, modelRef.raw);
    return rawOnlyModelTarget(modelRef);
  }

  if (
    typeof ctx.modelRegistry?.hasConfiguredAuth === "function" &&
    !ctx.modelRegistry.hasConfiguredAuth(model)
  ) {
    notifyMissingAuth(ctx, modelRef.raw);
    return rawOnlyModelTarget(modelRef);
  }

  return appendableModelTarget(modelRef);
}

export async function applyModelTargetToCurrentSession(pi, ctx, modelTarget) {
  if (!modelTarget) {
    return undefined;
  }

  if (!modelTarget.provider) {
    return modelTarget.raw;
  }

  const model = findConfiguredModel(ctx, modelTarget);
  if (!model) {
    notifyMissingModel(ctx, modelTarget.raw);
    return modelTarget.raw;
  }

  try {
    const selected = await pi.setModel?.(model);
    if (selected === false) {
      notifyMissingAuth(ctx, modelTarget.raw);
    }
  } catch (error) {
    notifyMissingAuth(ctx, modelTarget.raw);
    ctx.ui?.notify?.(
      `Model routing failed for ${modelTarget.raw}: ${error.message}`,
      "error",
    );
  }

  return modelTarget.raw;
}

export async function routeModelForCurrentPhase(pi, ctx, state) {
  return applyModelTargetToCurrentSession(
    pi,
    ctx,
    await resolveModelTargetForCurrentPhase(ctx, state),
  );
}
