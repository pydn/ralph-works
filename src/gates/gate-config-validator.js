export function validateGateConfig(config) {
  const errors = [];

  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return ["gate.config.json must contain a JSON object."];
  }

  if (!Array.isArray(config.gates)) {
    errors.push("gates must be an array.");
  } else {
    config.gates.forEach((gate, index) => {
      if (!gate || typeof gate !== "object" || Array.isArray(gate)) {
        errors.push(`gates[${index}] must be an object.`);
        return;
      }
      if (typeof gate.name !== "string" || gate.name.trim() === "") {
        errors.push(`gates[${index}].name must be a non-empty string.`);
      }
      if (typeof gate.command !== "string" || gate.command.trim() === "") {
        errors.push(`gates[${index}].command must be a non-empty string.`);
      }
      if (
        gate.required !== undefined &&
        typeof gate.required !== "boolean"
      ) {
        errors.push(`gates[${index}].required must be a boolean.`);
      }
    });
  }

  if (!Array.isArray(config.run_after_phase)) {
    errors.push("run_after_phase must be an array.");
  } else {
    const invalidPhases = config.run_after_phase.filter(
      (phase) => phase !== "tdd_implement",
    );
    if (invalidPhases.length > 0) {
      errors.push("run_after_phase currently supports only tdd_implement.");
    }
  }

  if (config.fail_behavior !== "block_transition") {
    errors.push("fail_behavior must be block_transition.");
  }

  return errors;
}
