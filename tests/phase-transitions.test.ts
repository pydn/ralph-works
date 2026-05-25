import assert from "node:assert/strict";
import test from "node:test";

import { createPhaseState } from "../src/state/phase-state.ts";
import {
  advancePhase,
  transitionToPhase,
} from "../src/state/phase-transitions.ts";

test("phase state starts in generate_spec and knows every Ralph loop phase", () => {
  const state = createPhaseState({ now: () => "2026-05-23T00:00:00.000Z" });

  assert.equal(state.currentPhase, "generate_spec");
  assert.deepEqual(
    state.phases.map((phase) => phase.id),
    [
      "generate_spec",
      "red_team",
      "harden_spec",
      "render_html_optional",
      "create_tasks",
      "tdd_implement",
      "review",
      "complete",
    ],
  );
});

test("advancePhase can skip optional HTML rendering", () => {
  let state = createPhaseState({ now: () => "2026-05-23T00:00:00.000Z" });

  state = advancePhase(state);
  state = advancePhase(state);
  state = advancePhase(state, { renderHtml: false });

  assert.equal(state.currentPhase, "create_tasks");
  assert.deepEqual(state.completedPhases, [
    "generate_spec",
    "red_team",
    "harden_spec",
  ]);
});

test("review can loop back to TDD implementation and records loopback history", () => {
  let state = createPhaseState({ now: () => "2026-05-23T00:00:00.000Z" });

  for (const phase of [
    "red_team",
    "harden_spec",
    "create_tasks",
    "tdd_implement",
    "review",
  ]) {
    state = transitionToPhase(state, phase, { reason: `test:${phase}` });
  }

  state = transitionToPhase(state, "tdd_implement", {
    reason: "review-critical-bugs",
  });

  assert.equal(state.currentPhase, "tdd_implement");
  assert.equal(state.loopbackCount, 1);
  assert.equal(state.transitionHistory.at(-1)?.kind, "loopback");
});

test("review approval moves workflow to complete", () => {
  let state = createPhaseState({ now: () => "2026-05-23T00:00:00.000Z" });

  for (const phase of [
    "red_team",
    "harden_spec",
    "create_tasks",
    "tdd_implement",
    "review",
    "complete",
  ]) {
    state = transitionToPhase(state, phase, { reason: `test:${phase}` });
  }

  assert.equal(state.currentPhase, "complete");
  assert.equal(state.completedPhases.at(-1), "review");
});

test("illegal transitions are rejected", () => {
  const state = createPhaseState();

  assert.throws(
    () => transitionToPhase(state, "review", { reason: "too-early" }),
    /Illegal RalphWorks transition/,
  );
});
