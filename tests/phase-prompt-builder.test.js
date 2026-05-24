import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { buildPhasePrompt } from "../src/prompts/phase-prompt-builder.js";
import { createPhaseState } from "../src/state/phase-state.js";
import { transitionToPhase } from "../src/state/phase-transitions.js";

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

test("review phase prompt requires exact LGTM for completion", () => {
  const prompt = buildPhasePrompt(reviewState(), {
    extensionRoot: path.resolve("."),
  });

  assert.match(prompt, /exactly `LGTM`/);
  assert.doesNotMatch(prompt, /looks good to me/i);
  assert.doesNotMatch(prompt, /RALPH_PHASE_COMPLETE/);
});
