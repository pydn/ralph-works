import assert from "node:assert/strict";
import test from "node:test";

import { createPhaseState } from "../src/state/phase-state.js";
import {
  appendSessionBoundaryEvent,
  createSessionBoundaryEvent,
  findPendingSessionBoundaryEvent,
  findSessionBoundaryEvent,
  updatePendingSessionBoundaryEvent,
} from "../src/state/session-boundaries.js";

test("phase state starts with session boundary history separate from compaction history", () => {
  const state = createPhaseState();

  assert.deepEqual(state.sessionBoundaryEvents, []);
  assert.deepEqual(state.compactionEvents, []);
});

test("session boundary events include required metadata and safe defaults", () => {
  const event = createSessionBoundaryEvent({
    id: "boundary-1",
    boundaryType: "phase",
    reason: "completed generate_spec",
    fromPhase: "generate_spec",
    toPhase: "red_team",
    taskId: "T001",
    nextTaskId: "T002",
    previousSessionId: "previous.jsonl",
    replacementSessionId: "replacement.jsonl",
    elapsedMs: 42,
    now: () => "2026-05-24T00:00:00.000Z",
  });

  assert.deepEqual(event, {
    id: "boundary-1",
    boundaryType: "phase",
    reason: "completed generate_spec",
    fromPhase: "generate_spec",
    toPhase: "red_team",
    taskId: "T001",
    nextTaskId: "T002",
    timestamp: "2026-05-24T00:00:00.000Z",
    status: "pending",
    freshSessionAttempted: false,
    freshSessionCreated: false,
    fallbackUsed: false,
    elapsedMs: 42,
    previousSessionId: "previous.jsonl",
    replacementSessionId: "replacement.jsonl",
  });
});

test("session boundary helpers append idempotently, find, and update pending events", () => {
  const event = createSessionBoundaryEvent({
    id: "boundary-1",
    boundaryType: "task",
    reason: "completed T001",
    fromPhase: "tdd_implement",
    taskId: "T001",
    now: () => "2026-05-24T00:00:00.000Z",
  });

  let state = createPhaseState();
  state = appendSessionBoundaryEvent(state, event);
  state = appendSessionBoundaryEvent(state, {
    ...event,
    reason: "duplicate retry",
  });

  assert.equal(state.sessionBoundaryEvents.length, 1);
  assert.equal(
    findSessionBoundaryEvent(state, "boundary-1")?.reason,
    "completed T001",
  );
  assert.equal(
    findPendingSessionBoundaryEvent(state, "boundary-1")?.id,
    event.id,
  );

  state = updatePendingSessionBoundaryEvent(state, "boundary-1", {
    status: "launching",
    freshSessionAttempted: true,
  });

  assert.equal(
    findPendingSessionBoundaryEvent(state, "boundary-1")?.status,
    "launching",
  );

  state = updatePendingSessionBoundaryEvent(state, "boundary-1", {
    status: "created",
    freshSessionCreated: true,
    replacementSessionId: "replacement.jsonl",
  });

  assert.equal(
    findSessionBoundaryEvent(state, "boundary-1")?.status,
    "created",
  );
  assert.equal(
    findSessionBoundaryEvent(state, "boundary-1")?.freshSessionAttempted,
    true,
  );
  assert.equal(
    findSessionBoundaryEvent(state, "boundary-1")?.freshSessionCreated,
    true,
  );
  assert.equal(findPendingSessionBoundaryEvent(state, "boundary-1"), undefined);

  state = updatePendingSessionBoundaryEvent(state, "boundary-1", {
    status: "cancelled",
  });

  assert.equal(
    findSessionBoundaryEvent(state, "boundary-1")?.status,
    "created",
  );
});

test("session boundary helpers treat partial launch failures as retryable", () => {
  for (const status of [
    "pending",
    "launching",
    "cancelled",
    "fallback_unavailable",
    "followup_failed",
  ]) {
    const event = createSessionBoundaryEvent({
      id: `boundary-${status}`,
      boundaryType: "phase",
      status,
    });
    const state = appendSessionBoundaryEvent(createPhaseState(), event);

    assert.equal(
      findPendingSessionBoundaryEvent(state, event.id)?.status,
      status,
    );
  }

  for (const status of ["created", "fallback_compaction", "complete"]) {
    const event = createSessionBoundaryEvent({
      id: `boundary-${status}`,
      boundaryType: "phase",
      status,
    });
    const state = appendSessionBoundaryEvent(createPhaseState(), event);

    assert.equal(findPendingSessionBoundaryEvent(state, event.id), undefined);
  }
});
