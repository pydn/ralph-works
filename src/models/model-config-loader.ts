import { readFile } from "node:fs/promises";
import path from "node:path";

import type { RalphWorksPhaseId } from "../state/phase-types.ts";

export interface ModelConfig {
  default_model?: string;
  phase_models: Partial<Record<RalphWorksPhaseId, string>>;
}

export const DEFAULT_MODEL_CONFIG = {
  default_model: undefined,
  phase_models: {},
} satisfies ModelConfig;

interface ObjectWithCode {
  code?: unknown;
}

function createDefaultModelConfig(): ModelConfig {
  return {
    default_model: undefined,
    phase_models: {},
  };
}

function hasErrorCode(error: unknown, code: string): error is ObjectWithCode {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as ObjectWithCode).code === code
  );
}

export async function loadModelConfig(
  rootDir: string,
  fileName = "model.config.json",
): Promise<unknown> {
  const configPath = path.join(rootDir, fileName);

  try {
    const raw = await readFile(configPath, "utf8");
    return JSON.parse(raw) as unknown;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return createDefaultModelConfig();
    }
    throw error;
  }
}
