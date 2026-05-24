import assert from "node:assert/strict";
import test from "node:test";

import { runConfiguredGates } from "../src/gates/gate-runner.js";
import { requiredGatesPassed } from "../src/gates/gate-result.js";

test("gate runner executes gates serially through the supplied executor", async () => {
  const calls = [];
  const results = await runConfiguredGates(
    {
      gates: [
        { name: "unit_tests", command: "npm test", required: true },
        { name: "lint", command: "npm run lint", required: true },
      ],
      run_after_phase: ["tdd_implement"],
      fail_behavior: "block_transition",
    },
    {
      executor: async (gate) => {
        calls.push(gate.command);
        return { code: 0, stdout: `${gate.name} ok`, stderr: "" };
      },
    },
  );

  assert.deepEqual(calls, ["npm test", "npm run lint"]);
  assert.equal(requiredGatesPassed(results), true);
});

test("required gate failure blocks completion", async () => {
  const results = await runConfiguredGates(
    {
      gates: [
        { name: "unit_tests", command: "npm test", required: true },
        { name: "lint", command: "npm run lint", required: false },
      ],
      run_after_phase: ["tdd_implement"],
      fail_behavior: "block_transition",
    },
    {
      executor: async (gate) => ({
        code: gate.name === "unit_tests" ? 1 : 0,
        stdout: "",
        stderr: gate.name === "unit_tests" ? "failed" : "",
      }),
    },
  );

  assert.equal(results[0].passed, false);
  assert.equal(results[0].blocksTransition, true);
  assert.equal(requiredGatesPassed(results), false);
});
