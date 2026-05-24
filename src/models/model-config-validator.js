import { isRalphWorksPhase } from "../state/phase-state.js";

export function validateModelConfig(config) {
  const errors = [];

  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return ["model.config.json must contain a JSON object."];
  }

  if (
    config.default_model !== undefined &&
    (typeof config.default_model !== "string" ||
      config.default_model.trim() === "")
  ) {
    errors.push("default_model must be a non-empty string when defined.");
  }

  if (
    config.phase_models === undefined ||
    config.phase_models === null
  ) {
    return errors;
  }

  if (typeof config.phase_models !== "object" || Array.isArray(config.phase_models)) {
    errors.push("phase_models must be an object.");
    return errors;
  }

  for (const [phase, model] of Object.entries(config.phase_models)) {
    if (!isRalphWorksPhase(phase) || phase === "complete") {
      errors.push(`phase_models.${phase} is not a configurable RalphWorks phase.`);
    }
    if (typeof model !== "string" || model.trim() === "") {
      errors.push(`phase_models.${phase} must be a non-empty string.`);
    }
  }

  return errors;
}
