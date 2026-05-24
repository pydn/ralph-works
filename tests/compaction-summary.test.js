import assert from "node:assert/strict";
import test from "node:test";

import { recordArtifact } from "../src/artifacts/artifact-tracker.js";
import {
  buildCompactionSummary,
  recordCompactionEvent,
  recordFallbackCompactionEvent,
} from "../src/artifacts/compaction-summary.js";
import { HARDEN_APPROVAL_STATUS } from "../src/state/phase-completion.js";
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

test("fallback compaction events remain available as legacy compatibility state", () => {
  const state = createPhaseState();
  const next = recordFallbackCompactionEvent(state, {
    boundary: "task",
    reason: "completed T001",
    now: () => "2026-05-24T00:00:00.000Z",
  });

  assert.deepEqual(next.compactionEvents, [
    {
      boundary: "task",
      reason: "completed T001",
      at: "2026-05-24T00:00:00.000Z",
    },
  ]);
});

test("recordCompactionEvent remains as a compatibility alias", () => {
  const state = createPhaseState();
  const next = recordCompactionEvent(state, {
    boundary: "phase",
    reason: "legacy caller",
    now: () => "2026-05-24T00:00:01.000Z",
  });

  assert.deepEqual(next.compactionEvents, [
    {
      boundary: "phase",
      reason: "legacy caller",
      at: "2026-05-24T00:00:01.000Z",
    },
  ]);
});

test("compaction summary preserves harden approval action after compaction", () => {
  let state = createPhaseState();
  state = transitionToPhase(state, "red_team", { reason: "spec-complete" });
  state = transitionToPhase(state, "harden_spec", {
    reason: "red-team-complete",
  });
  state = {
    ...state,
    phaseStatus: HARDEN_APPROVAL_STATUS,
  };

  const summary = buildCompactionSummary(state, {
    boundary: "phase",
    reason: "hardened spec awaiting approval",
  });

  assert.match(summary, /## Action Required/);
  assert.match(summary, /paused at harden_spec/);
  assert.match(summary, /must not continue/i);
  assert.match(summary, /\/ralph-works approve\b/);
  assert.match(summary, /\/ralph-works approve --render-html\b/);
});
