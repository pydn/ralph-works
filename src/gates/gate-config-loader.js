import { readFile } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_GATE_CONFIG = {
  gates: [],
  run_after_phase: ["tdd_implement"],
  fail_behavior: "block_transition",
};

export async function loadGateConfig(rootDir, fileName = "gate.config.json") {
  const configPath = path.join(rootDir, fileName);

  try {
    const raw = await readFile(configPath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        gates: [],
        run_after_phase: ["tdd_implement"],
        fail_behavior: "block_transition",
      };
    }
    throw error;
  }
}
