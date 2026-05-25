import type { GateDefinition } from "./gate-config-loader.ts";

export interface GateExecutionResult {
  code?: number | null;
  stdout?: string;
  stderr?: string;
  killed?: boolean;
}

export interface GateResult {
  [key: string]: unknown;
  name: string;
  command: string;
  required: boolean;
  code: number;
  stdout: string;
  stderr: string;
  passed: boolean;
  blocksTransition: boolean;
  killed: boolean;
}

export function createGateResult(
  gate: GateDefinition,
  executionResult: GateExecutionResult,
): GateResult {
  const code =
    typeof executionResult.code === "number" &&
    Number.isInteger(executionResult.code)
      ? executionResult.code
      : 1;
  const passed = code === 0;
  const required = gate.required !== false;

  return {
    name: gate.name,
    command: gate.command,
    required,
    code,
    stdout: executionResult.stdout ?? "",
    stderr: executionResult.stderr ?? "",
    passed,
    blocksTransition: required && !passed,
    killed: executionResult.killed === true,
  };
}

export function requiredGatesPassed(
  results: readonly Pick<GateResult, "passed" | "required">[],
): boolean {
  return results.every((result) => !result.required || result.passed);
}
