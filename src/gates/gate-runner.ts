import type { GateDefinition } from "./gate-config-loader.ts";
import {
  createGateResult,
  type GateExecutionResult,
  type GateResult,
} from "./gate-result.ts";

export interface GateExecutorContext {
  signal?: AbortSignal;
  timeout?: number;
}

export type GateExecutor = (
  gate: GateDefinition,
  context: GateExecutorContext,
) => GateExecutionResult | Promise<GateExecutionResult>;

export interface GateRunnerConfig {
  gates?: readonly GateDefinition[];
}

export interface RunConfiguredGatesOptions extends GateExecutorContext {
  executor?: GateExecutor;
}

export async function runConfiguredGates(
  config: GateRunnerConfig,
  { executor, signal, timeout }: RunConfiguredGatesOptions = {},
): Promise<GateResult[]> {
  if (typeof executor !== "function") {
    throw new Error("runConfiguredGates requires an executor function.");
  }

  const results: GateResult[] = [];
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
