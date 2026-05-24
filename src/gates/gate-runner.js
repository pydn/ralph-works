import { createGateResult } from "./gate-result.js";

export async function runConfiguredGates(
  config,
  { executor, signal, timeout } = {},
) {
  if (typeof executor !== "function") {
    throw new Error("runConfiguredGates requires an executor function.");
  }

  const results = [];
  for (const gate of config.gates ?? []) {
    try {
      const executionResult = await executor(gate, { signal, timeout });
      results.push(createGateResult(gate, executionResult));
    } catch (error) {
      results.push(
        createGateResult(gate, {
          code: 1,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  return results;
}
