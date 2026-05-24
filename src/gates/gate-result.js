export function createGateResult(gate, executionResult) {
  const code = Number.isInteger(executionResult.code)
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

export function requiredGatesPassed(results) {
  return results.every((result) => !result.required || result.passed);
}
