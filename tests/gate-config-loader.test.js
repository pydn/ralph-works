import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadGateConfig } from "../src/gates/gate-config-loader.js";
import { validateGateConfig } from "../src/gates/gate-config-validator.js";

test("missing gate config falls back to an empty TDD gate set", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ralph-gates-"));
  try {
    const config = await loadGateConfig(dir);

    assert.deepEqual(config, {
      gates: [],
      run_after_phase: ["tdd_implement"],
      fail_behavior: "block_transition",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("valid gate config preserves required commands", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ralph-gates-"));
  try {
    await writeFile(
      path.join(dir, "gate.config.json"),
      JSON.stringify({
        gates: [
          { name: "unit_tests", command: "npm test", required: true },
          { name: "lint", command: "npm run lint", required: false },
        ],
        run_after_phase: ["tdd_implement"],
        fail_behavior: "block_transition",
      }),
    );

    const config = await loadGateConfig(dir);
    const errors = validateGateConfig(config);

    assert.deepEqual(errors, []);
    assert.equal(config.gates[0].name, "unit_tests");
    assert.equal(config.gates[0].required, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("invalid gate config reports specific validation errors", () => {
  const errors = validateGateConfig({
    gates: [{ name: "", command: "", required: "yes" }],
    run_after_phase: ["review"],
    fail_behavior: "ignore",
  });

  assert.match(errors.join("\n"), /gates\[0\]\.name/);
  assert.match(errors.join("\n"), /gates\[0\]\.command/);
  assert.match(errors.join("\n"), /gates\[0\]\.required/);
  assert.match(errors.join("\n"), /run_after_phase/);
  assert.match(errors.join("\n"), /fail_behavior/);
});
