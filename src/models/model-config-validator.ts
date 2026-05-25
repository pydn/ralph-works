import { isRalphWorksPhase } from "../state/phase-state.ts";
import type { ModelConfig } from "./model-config-loader.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function validateModelConfig(config: unknown): string[] {
  const errors: string[] = [];

  if (!isRecord(config)) {
    return ["model.config.json must contain a JSON object."];
  }

  if (
    config.default_model !== undefined &&
    (typeof config.default_model !== "string" ||
      config.default_model.trim() === "")
  ) {
    errors.push("default_model must be a non-empty string when defined.");
  }

  if (config.phase_models === undefined || config.phase_models === null) {
    return errors;
  }

  if (!isRecord(config.phase_models)) {
    errors.push("phase_models must be an object.");
    return errors;
  }

  for (const [phase, model] of Object.entries(config.phase_models)) {
    if (!isRalphWorksPhase(phase) || phase === "complete") {
      errors.push(
        `phase_models.${phase} is not a configurable RalphWorks phase.`,
      );
    }
    if (typeof model !== "string" || model.trim() === "") {
      errors.push(`phase_models.${phase} must be a non-empty string.`);
    }
  }

  return errors;
}

export function isModelConfig(config: unknown): config is ModelConfig {
  return validateModelConfig(config).length === 0;
}
