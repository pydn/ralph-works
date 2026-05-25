import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { buildPhasePrompt } from "../src/prompts/phase-prompt-builder.ts";
import { createPhaseState } from "../src/state/phase-state.ts";
import { transitionToPhase } from "../src/state/phase-transitions.ts";

function reviewState() {
  let state = createPhaseState({ feature: "review-flow" });
  for (const phase of [
    "red_team",
    "harden_spec",
    "create_tasks",
    "tdd_implement",
    "review",
  ]) {
    state = transitionToPhase(state, phase, { reason: `test:${phase}` });
  }
  return state;
}

function tddState() {
  let state = createPhaseState({ feature: "review-flow" });
  for (const phase of [
    "red_team",
    "harden_spec",
    "create_tasks",
    "tdd_implement",
  ]) {
    state = transitionToPhase(state, phase, { reason: `test:${phase}` });
  }
  return state;
}

test("review phase prompt requires exact LGTM for completion", () => {
  const prompt = buildPhasePrompt(reviewState(), {
    extensionRoot: path.resolve("."),
  });

  assert.match(prompt, /exactly `LGTM`/);
  assert.doesNotMatch(prompt, /looks good to me/i);
  assert.doesNotMatch(prompt, /RALPH_PHASE_COMPLETE/);
});

test("phase prompts use docs artifact paths with a sanitized feature prefix", () => {
  const state = createPhaseState({
    feature: "../Hello World!!",
    promptText: "Write a script.",
  });
  const prompt = buildPhasePrompt(state, {
    extensionRoot: path.resolve("."),
  });

  assert.match(prompt, /Current output: docs\/hello-world-generated-spec\.md/);
  assert.doesNotMatch(prompt, /Current output: generated-spec\.md/);
});

test("TDD phase prompt tells the agent to choose tasks from durable artifacts", () => {
  const prompt = buildPhasePrompt(tddState(), {
    extensionRoot: path.resolve("."),
  });

  assert.match(prompt, /Prior Task Creation: docs\/review-flow-task-list\.md/);
  assert.match(
    prompt,
    /Current output: docs\/review-flow-implementation-status\.json/,
  );
  assert.match(
    prompt,
    /Inspect the task list and implementation status artifacts to choose the next incomplete task/i,
  );
});
