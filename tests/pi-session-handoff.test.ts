import assert from "node:assert/strict";
import test from "node:test";
import type {
  RalphWorksContext,
  RalphWorksNewSessionOptions,
  RalphWorksNewSessionResult,
} from "../src/harness/pi-harness-types.ts";
import {
  executeRalphWorksSessionHandoff,
  RALPH_WORKS_NEW_SESSION_NOTICE,
} from "../src/harness/pi-session-handoff.ts";
import {
  RALPH_WORKS_HANDOFF_MESSAGE_ENTRY_TYPE,
  RALPH_WORKS_STATE_ENTRY_TYPE,
} from "../src/harness/pi-state-persistence.ts";
import { createPhaseState } from "../src/state/phase-state.ts";
import type { WorkflowState } from "../src/state/phase-types.ts";
import { createPendingSessionHandoff } from "../src/state/session-handoff-state.ts";

type RecordedArray<T> = Omit<T[], "at"> & {
  [index: number]: T;
  at(index: number): T;
};

function recordedArray<T>(): RecordedArray<T> {
  return [] as unknown as RecordedArray<T>;
}

type WorkflowStateWithHandoff = WorkflowState & {
  pendingHandoff: NonNullable<WorkflowState["pendingHandoff"]> & {
    errorMessage: string;
    replacementSessionFile: string;
  };
};

interface TestSessionEntry {
  type: string;
  customType: string;
  data: WorkflowStateWithHandoff;
  content: string;
  display: boolean;
  details?: Record<string, unknown>;
}

interface TestReplacementSessionManager {
  entries: RecordedArray<TestSessionEntry>;
  appendCustomEntry(customType: string, data: WorkflowState): void;
  appendCustomMessageEntry(
    customType: string,
    content: string,
    display: boolean,
    details?: Record<string, unknown>,
  ): void;
  getSessionFile(): string;
}

interface HandoffCalls {
  notifications: RecordedArray<{ message: string; level?: string }>;
  newSessions: RecordedArray<RalphWorksNewSessionOptions>;
}

type HandoffContext = Partial<RalphWorksContext> & {
  cwd: string;
  ui: { notify(message: string, level?: string): void };
  sessionManager: { getSessionFile(): string };
  newSession?: (
    options: RalphWorksNewSessionOptions,
  ) => RalphWorksNewSessionResult | Promise<RalphWorksNewSessionResult>;
};

async function executeTestHandoff(
  ...args: Parameters<typeof executeRalphWorksSessionHandoff>
): Promise<
  Omit<Awaited<ReturnType<typeof executeRalphWorksSessionHandoff>>, "state"> & {
    state: WorkflowStateWithHandoff;
  }
> {
  const result = await executeRalphWorksSessionHandoff(...args);
  return { ...result, state: result.state as WorkflowStateWithHandoff };
}

function createPendingState({
  id = "handoff-1",
} = {}): WorkflowStateWithHandoff {
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
  ) as WorkflowStateWithHandoff;
}

function createReplacementSessionManager({
  sessionFile = "sessions/replacement.jsonl",
} = {}): TestReplacementSessionManager {
  const entries = recordedArray<TestSessionEntry>();
  return {
    entries,
    appendCustomEntry(customType: string, data: WorkflowState) {
      entries.push({
        type: "custom",
        customType,
        data: data as WorkflowStateWithHandoff,
        content: "",
        display: false,
      });
    },
    appendCustomMessageEntry(
      customType: string,
      content: string,
      display: boolean,
      details?: Record<string, unknown>,
    ) {
      entries.push({
        type: "custom_message",
        customType,
        data: undefined as unknown as WorkflowStateWithHandoff,
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
}: {
  newSession?: (
    options: RalphWorksNewSessionOptions,
  ) => RalphWorksNewSessionResult | Promise<RalphWorksNewSessionResult>;
  parentSession?: string;
} = {}): { ctx: HandoffContext; calls: HandoffCalls } {
  const calls: HandoffCalls = {
    notifications: recordedArray<{ message: string; level?: string }>(),
    newSessions: recordedArray<RalphWorksNewSessionOptions>(),
  };
  const ctx: HandoffContext = {
    cwd: process.cwd(),
    ui: {
      notify(message: string, level?: string) {
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
    ctx.newSession = async (options: RalphWorksNewSessionOptions) => {
      calls.newSessions.push(options);
      return newSession(options);
    };
  }

  return { ctx, calls };
}

test("session handoff creates a replacement session with parent metadata, setup, and replacement-only continuation", async () => {
  const state = createPendingState();
  const replacementManager = createReplacementSessionManager();
  const replacementCtx: RalphWorksContext = {
    cwd: process.cwd(),
    sessionManager: replacementManager,
  };
  const stateChanges = recordedArray<WorkflowStateWithHandoff>();
  const { ctx, calls } = createHandoffContext({
    newSession: async (options) => {
      await options.setup(replacementManager);
      await options.withSession(replacementCtx);
      return { cancelled: false };
    },
  });
  let seenReplacementCtx: RalphWorksContext | undefined;

  const result = await executeTestHandoff(ctx, state, {
    handoffId: "handoff-1",
    handoffSummary: "bounded handoff summary",
    now: () => "2026-05-24T01:01:00.000Z",
    onStateChange(nextState) {
      stateChanges.push(nextState as WorkflowStateWithHandoff);
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
  const stateChanges = recordedArray<WorkflowStateWithHandoff>();
  const { ctx, calls } = createHandoffContext();

  const result = await executeTestHandoff(ctx, state, {
    handoffId: "handoff-1",
    now: () => "2026-05-24T01:01:00.000Z",
    onStateChange(nextState) {
      stateChanges.push(nextState as WorkflowStateWithHandoff);
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
  const stateChanges = recordedArray<WorkflowStateWithHandoff>();
  const { ctx } = createHandoffContext({
    newSession: async () => {
      throw new Error("switch failed");
    },
  });

  const result = await executeTestHandoff(ctx, state, {
    handoffId: "handoff-1",
    now: () => "2026-05-24T01:01:00.000Z",
    onStateChange(nextState) {
      stateChanges.push(nextState as WorkflowStateWithHandoff);
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
  const replacementCtx: RalphWorksContext = {
    cwd: process.cwd(),
    sessionManager: replacementManager,
    ui: { notify() {} },
  };
  const stateChanges = recordedArray<WorkflowStateWithHandoff>();
  const { ctx } = createHandoffContext({
    newSession: async (options) => {
      await options.setup(replacementManager);
      await options.withSession(replacementCtx);
      return { cancelled: false };
    },
  });

  const result = await executeTestHandoff(ctx, state, {
    handoffId: "handoff-1",
    handoffSummary: "handoff summary",
    now: () => "2026-05-24T01:01:00.000Z",
    onStateChange(nextState) {
      stateChanges.push(nextState as WorkflowStateWithHandoff);
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
  const stateChanges = recordedArray<WorkflowStateWithHandoff>();
  const replacementManager = createReplacementSessionManager();
  const { ctx } = createHandoffContext({
    newSession: async (options) => {
      await options.setup(replacementManager);
      return { cancelled: true };
    },
  });
  let replacementContinuationCalled = false;

  const result = await executeTestHandoff(ctx, state, {
    handoffId: "handoff-1",
    handoffSummary: "handoff summary",
    now: () => "2026-05-24T01:01:00.000Z",
    onStateChange(nextState) {
      stateChanges.push(nextState as WorkflowStateWithHandoff);
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
  const stateChanges = recordedArray<WorkflowStateWithHandoff>();
  const { ctx } = createHandoffContext({
    newSession: async (options) => {
      await options.setup(createReplacementSessionManager());
      return { cancelled: false };
    },
  });
  let replacementContinuationCalled = false;

  const result = await executeTestHandoff(ctx, state, {
    handoffId: "handoff-1",
    now: () => "2026-05-24T01:01:00.000Z",
    onStateChange(nextState) {
      stateChanges.push(nextState as WorkflowStateWithHandoff);
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
