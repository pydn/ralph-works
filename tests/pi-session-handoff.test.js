import assert from "node:assert/strict";
import test from "node:test";
import {
  executeRalphWorksSessionHandoff,
  RALPH_WORKS_NEW_SESSION_NOTICE,
} from "../src/harness/pi-session-handoff.js";
import {
  RALPH_WORKS_HANDOFF_MESSAGE_ENTRY_TYPE,
  RALPH_WORKS_STATE_ENTRY_TYPE,
} from "../src/harness/pi-state-persistence.js";
import { createPhaseState } from "../src/state/phase-state.js";
import { createPendingSessionHandoff } from "../src/state/session-handoff-state.js";

function createPendingState({ id = "handoff-1" } = {}) {
  return createPendingSessionHandoff(
    createPhaseState({
      feature: "new-session",
      promptText: "create fresh sessions",
      now: () => "2026-05-24T00:00:00.000Z",
    }),
    {
      id,
      boundary: "phase",
      reason: "completed generate_spec",
      targetPhase: "red_team",
      now: () => "2026-05-24T01:00:00.000Z",
    },
  );
}

function createReplacementSessionManager({
  sessionFile = "sessions/replacement.jsonl",
} = {}) {
  const entries = [];
  return {
    entries,
    appendCustomEntry(customType, data) {
      entries.push({ type: "custom", customType, data });
    },
    appendCustomMessageEntry(customType, content, display, details) {
      entries.push({
        type: "custom_message",
        customType,
        content,
        display,
        details,
      });
    },
    getSessionFile() {
      return sessionFile;
    },
  };
}

function createHandoffContext({
  newSession,
  parentSession = "sessions/source.jsonl",
} = {}) {
  const calls = {
    notifications: [],
    newSessions: [],
  };
  const ctx = {
    cwd: process.cwd(),
    ui: {
      notify(message, level) {
        calls.notifications.push({ message, level });
      },
    },
    sessionManager: {
      getSessionFile() {
        return parentSession;
      },
    },
  };

  if (newSession) {
    ctx.newSession = async (options) => {
      calls.newSessions.push(options);
      return newSession(options);
    };
  }

  return { ctx, calls };
}

test("session handoff creates a replacement session with parent metadata, setup, and replacement-only continuation", async () => {
  const state = createPendingState();
  const replacementManager = createReplacementSessionManager();
  const replacementCtx = { sessionManager: replacementManager };
  const stateChanges = [];
  const { ctx, calls } = createHandoffContext({
    newSession: async (options) => {
      await options.setup(replacementManager);
      await options.withSession(replacementCtx);
      return { cancelled: false };
    },
  });
  let seenReplacementCtx;

  const result = await executeRalphWorksSessionHandoff(ctx, state, {
    handoffId: "handoff-1",
    handoffSummary: "bounded handoff summary",
    now: () => "2026-05-24T01:01:00.000Z",
    onStateChange(nextState) {
      stateChanges.push(nextState);
    },
    async withReplacementSession(newCtx) {
      seenReplacementCtx = newCtx;
    },
  });

  assert.equal(result.failed, false);
  assert.equal(calls.notifications[0].message, RALPH_WORKS_NEW_SESSION_NOTICE);
  assert.equal(calls.notifications[0].level, "info");
  assert.equal(calls.newSessions.length, 1);
  assert.equal(calls.newSessions[0].parentSession, "sessions/source.jsonl");
  assert.equal(typeof calls.newSessions[0].setup, "function");
  assert.equal(typeof calls.newSessions[0].withSession, "function");
  assert.equal(seenReplacementCtx, replacementCtx);

  assert.equal(stateChanges.length, 1);
  assert.equal(stateChanges[0].pendingHandoff.status, "in_progress");

  assert.equal(replacementManager.entries.length, 2);
  assert.equal(
    replacementManager.entries[0].customType,
    RALPH_WORKS_STATE_ENTRY_TYPE,
  );
  assert.equal(
    replacementManager.entries[0].data.pendingHandoff.status,
    "ready_in_new_session",
  );
  assert.equal(
    replacementManager.entries[0].data.pendingHandoff.replacementSessionFile,
    "sessions/replacement.jsonl",
  );
  assert.equal(
    replacementManager.entries[1].customType,
    RALPH_WORKS_HANDOFF_MESSAGE_ENTRY_TYPE,
  );
  assert.equal(
    replacementManager.entries[1].content,
    "bounded handoff summary",
  );
});

test("session handoff failure for unavailable newSession blocks the pipeline", async () => {
  const state = createPendingState();
  const stateChanges = [];
  const { ctx, calls } = createHandoffContext();

  const result = await executeRalphWorksSessionHandoff(ctx, state, {
    handoffId: "handoff-1",
    now: () => "2026-05-24T01:01:00.000Z",
    onStateChange(nextState) {
      stateChanges.push(nextState);
    },
  });

  assert.equal(result.failed, true);
  assert.equal(result.state.pipelineStatus, "blocked");
  assert.equal(result.state.phaseStatus, "handoff_failed");
  assert.equal(result.state.pendingHandoff.status, "failed");
  assert.match(result.state.pendingHandoff.errorMessage, /newSession/i);
  assert.deepEqual(
    calls.notifications.map((notification) => notification.message),
    [RALPH_WORKS_NEW_SESSION_NOTICE, result.state.pendingHandoff.errorMessage],
  );
  assert.deepEqual(
    stateChanges.map((nextState) => nextState.pendingHandoff.status),
    ["in_progress", "failed"],
  );
});

test("session handoff thrown creation errors block the pipeline", async () => {
  const state = createPendingState();
  const stateChanges = [];
  const { ctx } = createHandoffContext({
    newSession: async () => {
      throw new Error("switch failed");
    },
  });

  const result = await executeRalphWorksSessionHandoff(ctx, state, {
    handoffId: "handoff-1",
    now: () => "2026-05-24T01:01:00.000Z",
    onStateChange(nextState) {
      stateChanges.push(nextState);
    },
  });

  assert.equal(result.failed, true);
  assert.equal(result.state.pipelineStatus, "blocked");
  assert.equal(result.state.pendingHandoff.status, "failed");
  assert.match(result.state.pendingHandoff.errorMessage, /switch failed/i);
  assert.deepEqual(
    stateChanges.map((nextState) => nextState.pendingHandoff.status),
    ["in_progress", "failed"],
  );
});

test("session handoff replacement continuation errors are persisted in the replacement session", async () => {
  const state = createPendingState();
  const replacementManager = createReplacementSessionManager();
  const replacementCtx = {
    sessionManager: replacementManager,
    ui: { notify() {} },
  };
  const stateChanges = [];
  const { ctx } = createHandoffContext({
    newSession: async (options) => {
      await options.setup(replacementManager);
      await options.withSession(replacementCtx);
      return { cancelled: false };
    },
  });

  const result = await executeRalphWorksSessionHandoff(ctx, state, {
    handoffId: "handoff-1",
    handoffSummary: "handoff summary",
    now: () => "2026-05-24T01:01:00.000Z",
    onStateChange(nextState) {
      stateChanges.push(nextState);
    },
    async withReplacementSession() {
      throw new Error("replacement prompt failed");
    },
  });

  assert.equal(result.failed, true);
  assert.equal(result.state.pipelineStatus, "blocked");
  assert.equal(result.state.pendingHandoff.status, "failed");
  assert.match(
    result.state.pendingHandoff.errorMessage,
    /replacement prompt failed/i,
  );
  assert.deepEqual(
    stateChanges.map((nextState) => nextState.pendingHandoff.status),
    ["in_progress"],
  );
  assert.equal(
    replacementManager.entries.at(-1).customType,
    RALPH_WORKS_STATE_ENTRY_TYPE,
  );
  assert.equal(
    replacementManager.entries.at(-1).data.pendingHandoff.status,
    "failed",
  );
});

test("session handoff cancellation records a failed handoff and does not run replacement continuation", async () => {
  const state = createPendingState();
  const stateChanges = [];
  const replacementManager = createReplacementSessionManager();
  const { ctx } = createHandoffContext({
    newSession: async (options) => {
      await options.setup(replacementManager);
      return { cancelled: true };
    },
  });
  let replacementContinuationCalled = false;

  const result = await executeRalphWorksSessionHandoff(ctx, state, {
    handoffId: "handoff-1",
    handoffSummary: "handoff summary",
    now: () => "2026-05-24T01:01:00.000Z",
    onStateChange(nextState) {
      stateChanges.push(nextState);
    },
    async withReplacementSession() {
      replacementContinuationCalled = true;
    },
  });

  assert.equal(result.failed, true);
  assert.equal(replacementContinuationCalled, false);
  assert.equal(result.state.pipelineStatus, "blocked");
  assert.equal(result.state.pendingHandoff.status, "failed");
  assert.match(result.state.pendingHandoff.errorMessage, /cancelled/i);
  assert.deepEqual(
    stateChanges.map((nextState) => nextState.pendingHandoff.status),
    ["in_progress", "failed"],
  );
});

test("session handoff setup errors fail in the source session without replacement continuation", async () => {
  const state = createPendingState();
  const stateChanges = [];
  const { ctx } = createHandoffContext({
    newSession: async (options) => {
      await options.setup(createReplacementSessionManager());
      return { cancelled: false };
    },
  });
  let replacementContinuationCalled = false;

  const result = await executeRalphWorksSessionHandoff(ctx, state, {
    handoffId: "handoff-1",
    now: () => "2026-05-24T01:01:00.000Z",
    onStateChange(nextState) {
      stateChanges.push(nextState);
    },
    setupReplacementSession() {
      throw new Error("setup exploded");
    },
    async withReplacementSession() {
      replacementContinuationCalled = true;
    },
  });

  assert.equal(result.failed, true);
  assert.equal(replacementContinuationCalled, false);
  assert.equal(result.state.pipelineStatus, "blocked");
  assert.equal(result.state.pendingHandoff.status, "failed");
  assert.match(result.state.pendingHandoff.errorMessage, /setup exploded/i);
  assert.deepEqual(
    stateChanges.map((nextState) => nextState.pendingHandoff.status),
    ["in_progress", "failed"],
  );
});
