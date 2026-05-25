import type { GateConfig } from "./gate-config-loader.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function validateGateConfig(config: unknown): string[] {
  const errors: string[] = [];

  if (!isRecord(config)) {
    return ["gate.config.json must contain a JSON object."];
  }

  const gates = config.gates;
  if (!Array.isArray(gates)) {
    errors.push("gates must be an array.");
  } else {
    gates.forEach((gate, index) => {
      if (!isRecord(gate)) {
        errors.push(`gates[${index}] must be an object.`);
        return;
      }
      if (typeof gate.name !== "string" || gate.name.trim() === "") {
        errors.push(`gates[${index}].name must be a non-empty string.`);
      }
      if (typeof gate.command !== "string" || gate.command.trim() === "") {
        errors.push(`gates[${index}].command must be a non-empty string.`);
      }
      if (gate.required !== undefined && typeof gate.required !== "boolean") {
        errors.push(`gates[${index}].required must be a boolean.`);
      }
    });
  }

  const runAfterPhase = config.run_after_phase;
  if (!Array.isArray(runAfterPhase)) {
    errors.push("run_after_phase must be an array.");
  } else {
    const invalidPhases = runAfterPhase.filter(
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

export function isGateConfig(config: unknown): config is GateConfig {
  return validateGateConfig(config).length === 0;
}
