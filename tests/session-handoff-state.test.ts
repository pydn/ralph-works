import assert from "node:assert/strict";
import test from "node:test";

import { createPhaseState } from "../src/state/phase-state.ts";
import {
  completeSessionHandoff,
  createPendingSessionHandoff,
  failSessionHandoff,
  HANDOFF_PHASE_FAILED_STATUS,
  HANDOFF_PHASE_PENDING_STATUS,
  HANDOFF_STATUS_FAILED,
  HANDOFF_STATUS_IN_PROGRESS,
  HANDOFF_STATUS_PENDING,
  HANDOFF_STATUS_READY_IN_NEW_SESSION,
  isHandoffBlockingState,
  markSessionHandoffInProgress,
  markSessionHandoffReadyInNewSession,
  validatePendingSessionHandoff,
} from "../src/state/session-handoff-state.ts";

test("createPhaseState initializes new workflows with session handoff state only", () => {
  const state = createPhaseState({
    feature: "session-handoff",
    now: () => "2026-05-24T00:00:00.000Z",
  });

  assert.equal(state.phaseStatus, "executing");
  assert.deepEqual(state.sessionHandoffEvents, []);
  assert.equal(Object.hasOwn(state, "pendingHandoff"), false);
  assert.equal(Object.hasOwn(state, "compactionEvents"), false);
});

test("createPendingSessionHandoff creates and validates a pending descriptor", () => {
  const state = createPhaseState({ feature: "session-handoff" });

  const next = createPendingSessionHandoff(state, {
    id: "handoff-1",
    boundary: "phase",
    reason: "completed generate_spec",
    targetPhase: "red_team",
    now: () => "2026-05-24T01:00:00.000Z",
  });

  assert.equal(next.phaseStatus, HANDOFF_PHASE_PENDING_STATUS);
  assert.equal(next.pipelineStatus, "running");
  assert.deepEqual(next.pendingHandoff, {
    id: "handoff-1",
    boundary: "phase",
    reason: "completed generate_spec",
    sourcePhase: "generate_spec",
    targetPhase: "red_team",
    taskId: undefined,
    status: HANDOFF_STATUS_PENDING,
    createdAt: "2026-05-24T01:00:00.000Z",
    updatedAt: "2026-05-24T01:00:00.000Z",
  });

  const descriptor = validatePendingSessionHandoff(next, "handoff-1", {
    expectedSourcePhase: "generate_spec",
    expectedTargetPhase: "red_team",
    expectedStatuses: [HANDOFF_STATUS_PENDING],
  });
  assert.equal(descriptor.id, "handoff-1");
});

test("createPendingSessionHandoff is idempotent for the same descriptor and rejects another active handoff", () => {
  const state = createPendingSessionHandoff(createPhaseState(), {
    id: "handoff-1",
    boundary: "phase",
    reason: "completed generate_spec",
    targetPhase: "red_team",
    now: () => "2026-05-24T01:00:00.000Z",
  });

  const duplicate = createPendingSessionHandoff(state, {
    id: "handoff-1",
    boundary: "phase",
    reason: "completed generate_spec",
    targetPhase: "red_team",
    now: () => "2026-05-24T02:00:00.000Z",
  });
  assert.strictEqual(duplicate, state);

  assert.throws(
    () =>
      createPendingSessionHandoff(state, {
        id: "handoff-2",
        boundary: "phase",
        reason: "completed red_team",
        targetPhase: "harden_spec",
      }),
    /handoff already pending/i,
  );
});

test("completeSessionHandoff records a completed handoff event once", () => {
  const pending = createPendingSessionHandoff(createPhaseState(), {
    id: "handoff-1",
    boundary: "task",
    reason: "completed T001",
    targetPhase: "tdd_implement",
    taskId: "T001",
    now: () => "2026-05-24T01:00:00.000Z",
  });
  const inProgress = markSessionHandoffInProgress(pending, "handoff-1", {
    now: () => "2026-05-24T01:01:00.000Z",
  });
  const ready = markSessionHandoffReadyInNewSession(inProgress, "handoff-1", {
    now: () => "2026-05-24T01:02:00.000Z",
    replacementSessionFile: "sessions/replacement.json",
  });

  const completed = completeSessionHandoff(ready, "handoff-1", {
    now: () => "2026-05-24T01:03:00.000Z",
    phaseStatus: "executing",
    replacementSessionFile: "sessions/replacement.json",
  });

  assert.equal(completed.phaseStatus, "executing");
  assert.equal(Object.hasOwn(completed, "pendingHandoff"), false);
  assert.equal(completed.sessionHandoffEvents.length, 1);
  assert.deepEqual(completed.sessionHandoffEvents[0], {
    id: "handoff-1",
    boundary: "task",
    reason: "completed T001",
    sourcePhase: "generate_spec",
    targetPhase: "tdd_implement",
    taskId: "T001",
    status: "completed",
    createdAt: "2026-05-24T01:00:00.000Z",
    completedAt: "2026-05-24T01:03:00.000Z",
    replacementSessionFile: "sessions/replacement.json",
  });

  const completedAgain = completeSessionHandoff(completed, "handoff-1", {
    now: () => "2026-05-24T01:04:00.000Z",
  });
  assert.strictEqual(completedAgain, completed);
});

test("failSessionHandoff marks the pipeline blocked and exposes handoff blocking guards", () => {
  const pending = createPendingSessionHandoff(createPhaseState(), {
    id: "handoff-1",
    boundary: "phase",
    reason: "completed generate_spec",
    targetPhase: "red_team",
    now: () => "2026-05-24T01:00:00.000Z",
  });

  const failed = failSessionHandoff(pending, "handoff-1", {
    error: new Error("session switch cancelled"),
    now: () => "2026-05-24T01:01:00.000Z",
  });

  assert.equal(failed.phaseStatus, HANDOFF_PHASE_FAILED_STATUS);
  assert.equal(failed.pipelineStatus, "blocked");
  assert.ok(failed.pendingHandoff);
  assert.equal(failed.pendingHandoff.status, HANDOFF_STATUS_FAILED);
  assert.equal(failed.pendingHandoff.failedAt, "2026-05-24T01:01:00.000Z");
  assert.equal(failed.pendingHandoff.errorMessage, "session switch cancelled");
  assert.equal(isHandoffBlockingState(pending), true);
  assert.equal(isHandoffBlockingState(failed), true);
  assert.equal(isHandoffBlockingState(createPhaseState()), false);

  assert.throws(
    () =>
      validatePendingSessionHandoff(failed, "handoff-1", {
        expectedStatuses: [
          HANDOFF_STATUS_PENDING,
          HANDOFF_STATUS_IN_PROGRESS,
          HANDOFF_STATUS_READY_IN_NEW_SESSION,
        ],
      }),
    /status/i,
  );
});
