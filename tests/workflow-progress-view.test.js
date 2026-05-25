import assert from "node:assert/strict";
import test from "node:test";

import { createPhaseState } from "../src/state/phase-state.js";
import { transitionToPhase } from "../src/state/phase-transitions.js";
import { renderWorkflowProgress } from "../src/tui/workflow-progress-view.js";

// biome-ignore lint/complexity/useRegexLiterals: String construction avoids Biome control-character regex diagnostics for intentional ANSI assertions.
const ANSI_PATTERN = new RegExp("\\u001b\\[[0-9;]*m", "g");
// biome-ignore lint/complexity/useRegexLiterals: String construction avoids Biome control-character regex diagnostics for intentional ANSI assertions.
const ANSI_COLOR_PATTERN = new RegExp("\\u001b\\[38;2;");

function stripAnsi(value) {
  return value.replace(ANSI_PATTERN, "");
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
  assert.equal(plainLines[1], "▶ 1/8 Generate Spec · [▶ · · · · · · ·]");
  assert.equal(plainLines[2], "Loopbacks · 0");
  assert.match(lines.join("\n"), ANSI_COLOR_PATTERN);
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
  assert.match(
    text,
    /Review -> Red-Green TDD Implement · review-critical-bugs/,
  );
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
  assert.match(
    lines.join("\n"),
    /✗ fail · unit_tests · required · blocks transition/,
  );
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
  assert.match(lines.join("\n"), /Approval · \/ralph-works approve/);
  assert.match(lines.join("\n"), /\/ralph-works approve --render-html/);
});

test("workflow progress view shows pending handoff details", () => {
  const state = {
    ...createPhaseState(),
    currentPhase: "red_team",
    phaseStatus: "handoff_pending",
    pendingHandoff: {
      id: "handoff-123",
      status: "pending",
      boundary: "phase",
      sourcePhase: "generate_spec",
      targetPhase: "red_team",
    },
  };

  const lines = renderWorkflowProgress(state, { color: false });
  const text = lines.join("\n");

  assert.match(lines[0], /ralph-works · HANDOFF PENDING/);
  assert.match(text, /Handoff · handoff_pending/);
  assert.match(text, /id handoff-123/);
  assert.match(text, /boundary phase/);
  assert.match(text, /target Red Team/);
});

test("workflow progress view shows failed handoff details and error", () => {
  const state = {
    ...createPhaseState(),
    currentPhase: "review",
    phaseStatus: "handoff_failed",
    pendingHandoff: {
      id: "handoff-failed",
      status: "failed",
      boundary: "task",
      sourcePhase: "tdd_implement",
      targetPhase: "review",
      errorMessage: "session switch cancelled by user",
    },
  };

  const lines = renderWorkflowProgress(state, { color: false });
  const text = lines.join("\n");

  assert.match(lines[0], /ralph-works · HANDOFF FAILED/);
  assert.match(text, /Handoff · handoff_failed/);
  assert.match(text, /id handoff-failed/);
  assert.match(text, /boundary task/);
  assert.match(text, /target Review/);
  assert.match(text, /Handoff error · session switch cancelled by user/);
});

test("workflow progress view shows complete state", () => {
  let state = createPhaseState();
  for (const phase of [
    "red_team",
    "harden_spec",
    "create_tasks",
    "tdd_implement",
    "review",
    "complete",
  ]) {
    state = transitionToPhase(state, phase, { reason: "test" });
  }

  const lines = renderWorkflowProgress(state, { color: false });
  const text = lines.join("\n");

  assert.match(lines[0], /ralph-works · COMPLETE/);
  assert.match(text, /✓ 8\/8 Complete/);
});
