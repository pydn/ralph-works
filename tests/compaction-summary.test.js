import assert from "node:assert/strict";
import test from "node:test";

import { recordArtifact } from "../src/artifacts/artifact-tracker.js";
import {
  buildCompactionSummary,
  recordCompactionEvent,
} from "../src/artifacts/compaction-summary.js";
import { createPhaseState } from "../src/state/phase-state.js";
import { transitionToPhase } from "../src/state/phase-transitions.js";

test("compaction summary restores RalphWorks state and artifact references", () => {
  let state = createPhaseState({ now: () => "2026-05-23T00:00:00.000Z" });
  state = recordArtifact(state, "generatedSpec", "generated-spec.md");
  state = transitionToPhase(state, "red_team", { reason: "spec-complete" });
  state = recordArtifact(state, "redTeamFindings", "red-team-findings.md");

  const summary = buildCompactionSummary(state, {
    boundary: "phase",
    reason: "red-team-complete",
  });

  assert.match(summary, /ralph-works/);
  assert.match(summary, /Current phase: red_team/);
  assert.match(summary, /generatedSpec: docs\/feature-generated-spec.md/);
  assert.match(summary, /redTeamFindings: docs\/feature-red-team-findings.md/);
  assert.match(summary, /Boundary: phase/);
});

test("recordCompactionEvent stores phase and task boundaries", () => {
  const state = createPhaseState();
  const next = recordCompactionEvent(state, {
    boundary: "task",
    reason: "completed T001",
  });

  assert.equal(next.compactionEvents.length, 1);
  assert.equal(next.compactionEvents[0].boundary, "task");
});
