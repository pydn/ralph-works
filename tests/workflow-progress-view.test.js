import assert from "node:assert/strict";
import test from "node:test";

import { createPhaseState } from "../src/state/phase-state.js";
import { transitionToPhase } from "../src/state/phase-transitions.js";
import { renderWorkflowProgress } from "../src/tui/workflow-progress-view.js";

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

test("workflow progress view uses the compact ralph-works widget look", () => {
  const state = createPhaseState();
  const lines = renderWorkflowProgress(state, {
    activeModel: "anthropic/claude-review",
    color: true,
  });
  const plainLines = lines.map(stripAnsi);

  assert.equal(
    plainLines[0],
    "ralph-works · RUNNING · model anthropic/claude-review",
  );
  assert.equal(
    plainLines[1],
    "▶ 1/8 Generate Spec · [▶ · · · · · · ·]",
  );
  assert.equal(plainLines[2], "Loopbacks · 0");
  assert.match(lines.join("\n"), /\u001b\[38;2;/);
});

test("workflow progress view makes review loopback visible", () => {
  let state = createPhaseState();
  for (const phase of [
    "red_team",
    "harden_spec",
    "create_tasks",
    "tdd_implement",
    "review",
  ]) {
    state = transitionToPhase(state, phase);
  }
  state = transitionToPhase(state, "tdd_implement", {
    reason: "review-critical-bugs",
  });

  const lines = renderWorkflowProgress(state, { color: false });
  const text = lines.join("\n");

  assert.match(text, /Loopbacks · 1/);
  assert.match(text, /Review -> Red-Green TDD Implement · review-critical-bugs/);
});

test("workflow progress view shows required gate status", () => {
  const state = {
    ...createPhaseState(),
    gateResults: [
      {
        name: "unit_tests",
        required: true,
        passed: false,
        blocksTransition: true,
      },
      {
        name: "lint",
        required: false,
        passed: true,
        blocksTransition: false,
      },
    ],
  };

  const lines = renderWorkflowProgress(state, { color: false });

  assert.match(lines.join("\n"), /Gates/);
  assert.match(lines.join("\n"), /✗ fail · unit_tests · required · blocks transition/);
  assert.match(lines.join("\n"), /✓ pass · lint · optional/);
});

test("workflow progress view shows harden approval waiting state", () => {
  const state = {
    ...createPhaseState(),
    currentPhase: "harden_spec",
    phaseStatus: "awaiting_harden_approval",
  };

  const lines = renderWorkflowProgress(state, { color: false });

  assert.match(lines[0], /ralph-works · WAITING/);
  assert.match(lines.join("\n"), /Harden Spec/);
});
