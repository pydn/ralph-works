import { readFile } from "node:fs/promises";
import path from "node:path";

export type GatePhaseId = "tdd_implement";
export type GateFailBehavior = "block_transition";

export interface GateDefinition {
  name: string;
  command: string;
  required?: boolean;
}

export interface GateConfig {
  gates: GateDefinition[];
  run_after_phase: GatePhaseId[];
  fail_behavior: GateFailBehavior;
}

export const DEFAULT_GATE_CONFIG = {
  gates: [],
  run_after_phase: ["tdd_implement"],
  fail_behavior: "block_transition",
} satisfies GateConfig;

interface ObjectWithCode {
  code?: unknown;
}

function createDefaultGateConfig(): GateConfig {
  return {
    gates: [],
    run_after_phase: ["tdd_implement"],
    fail_behavior: "block_transition",
  };
}

function hasErrorCode(error: unknown, code: string): error is ObjectWithCode {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as ObjectWithCode).code === code
  );
}

export async function loadGateConfig(
  rootDir: string,
  fileName = "gate.config.json",
): Promise<unknown> {
  const configPath = path.join(rootDir, fileName);

  try {
    const raw = await readFile(configPath, "utf8");
    return JSON.parse(raw) as unknown;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return createDefaultGateConfig();
    }
    throw error;
  }
}
