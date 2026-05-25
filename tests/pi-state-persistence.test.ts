import assert from "node:assert/strict";
import test from "node:test";
import type { RalphWorksSessionManager } from "../src/harness/pi-harness-types.ts";
import {
  RALPH_WORKS_HANDOFF_MESSAGE_ENTRY_TYPE,
  RALPH_WORKS_STATE_ENTRY_TYPE,
  restoreRalphWorksState,
  setupRalphWorksReplacementSession,
} from "../src/harness/pi-state-persistence.ts";
import { createPhaseState } from "../src/state/phase-state.ts";
import type { WorkflowState } from "../src/state/phase-types.ts";
import { createPendingSessionHandoff } from "../src/state/session-handoff-state.ts";

type RecordedArray<T> = Omit<T[], "at" | "find"> & {
  [index: number]: T;
  at(index: number): T;
  find(predicate: (value: T, index: number, obj: T[]) => unknown): T;
};

function recordedArray<T>(items: T[] = []): RecordedArray<T> {
  return items as RecordedArray<T>;
}

type WorkflowStateWithHandoff = WorkflowState & {
  pendingHandoff: NonNullable<WorkflowState["pendingHandoff"]> & {
    replacementSessionFile: string;
    taskId: string;
  };
};

interface TestSessionEntry {
  [key: string]: unknown;
  type: string;
  customType: string;
  data: WorkflowStateWithHandoff;
  content: string;
  display: boolean;
  details?: Record<string, unknown>;
}

interface TestReplacementSessionManager extends RalphWorksSessionManager {
  entries: RecordedArray<TestSessionEntry>;
  getEntries(): RecordedArray<TestSessionEntry>;
  getSessionFile(): string;
}

function restoreRequiredState(ctx: {
  sessionManager?: RalphWorksSessionManager;
}): WorkflowStateWithHandoff {
  const restored = restoreRalphWorksState(ctx);
  assert.ok(restored, "expected restored RalphWorks state");
  return restored as WorkflowStateWithHandoff;
}

function setupReplacementSession(
  ...args: Parameters<typeof setupRalphWorksReplacementSession>
): Omit<ReturnType<typeof setupRalphWorksReplacementSession>, "state"> & {
  state: WorkflowStateWithHandoff;
} {
  const result = setupRalphWorksReplacementSession(...args);
  return { ...result, state: result.state as WorkflowStateWithHandoff };
}

function createFakeReplacementSessionManager({
  sessionFile = "sessions/replacement.json",
  entries = recordedArray<TestSessionEntry>(),
}: {
  sessionFile?: string;
  entries?: RecordedArray<TestSessionEntry>;
} = {}): TestReplacementSessionManager {
  return {
    entries,
    appendCustomEntry(customType: string, data: WorkflowState) {
      const entry: TestSessionEntry = {
        type: "custom",
        customType,
        data: data as WorkflowStateWithHandoff,
        content: "",
        display: false,
      };
      entries.push(entry);
      return `entry-${entries.length}`;
    },
    appendCustomMessageEntry(
      customType: string,
      content: string,
      display: boolean,
      details?: Record<string, unknown>,
    ) {
      const entry: TestSessionEntry = {
        type: "custom_message",
        customType,
        data: undefined as unknown as WorkflowStateWithHandoff,
        content,
        display,
        details,
      };
      entries.push(entry);
      return `entry-${entries.length}`;
    },
    getEntries() {
      return entries;
    },
    getSessionFile() {
      return sessionFile;
    },
  };
}

test("restored sessions rebuild artifact paths with the feature prefix", () => {
  const saved = {
    ...createPhaseState({ feature: "../Hello World!!" }),
    phases: [
      {
        id: "generate_spec",
        artifactPath: "generated-spec.md",
      },
    ],
  };

  const restored = restoreRequiredState({
    sessionManager: {
      getEntries() {
        return [
          {
            type: "custom",
            customType: RALPH_WORKS_STATE_ENTRY_TYPE,
            data: saved,
          },
        ];
      },
    },
  });

  assert.equal(
    restored.phases.find((phase) => phase.id === "generate_spec")?.artifactPath,
    "docs/hello-world-generated-spec.md",
  );
});

test("replacement session setup appends durable state and LLM-visible handoff context", () => {
  const state = createPendingSessionHandoff(
    createPhaseState({
      feature: "fresh-session",
      promptText: "use a new Pi session",
      now: () => "2026-05-24T00:00:00.000Z",
    }),
    {
      id: "handoff-1",
      boundary: "phase",
      reason: "completed generate_spec",
      targetPhase: "red_team",
      now: () => "2026-05-24T01:00:00.000Z",
    },
  );
  const sessionManager = createFakeReplacementSessionManager();

  const result = setupReplacementSession(sessionManager, state, {
    handoffId: "handoff-1",
    handoffSummary: "bounded handoff summary",
    now: () => "2026-05-24T01:01:00.000Z",
  });

  assert.equal(result.state.pendingHandoff.status, "ready_in_new_session");
  assert.equal(
    result.state.pendingHandoff.replacementSessionFile,
    "sessions/replacement.json",
  );
  assert.deepEqual(
    sessionManager.entries.map((entry) => entry.type),
    ["custom", "custom_message"],
  );

  assert.equal(
    sessionManager.entries[0].customType,
    RALPH_WORKS_STATE_ENTRY_TYPE,
  );
  assert.equal(
    sessionManager.entries[0].data.pendingHandoff.status,
    "ready_in_new_session",
  );

  assert.equal(
    sessionManager.entries[1].customType,
    RALPH_WORKS_HANDOFF_MESSAGE_ENTRY_TYPE,
  );
  assert.equal(sessionManager.entries[1].content, "bounded handoff summary");
  assert.equal(sessionManager.entries[1].display, true);
  assert.deepEqual(sessionManager.entries[1].details, {
    handoffId: "handoff-1",
    boundary: "phase",
    sourcePhase: "generate_spec",
    targetPhase: "red_team",
  });
});

test("replacement session setup restores from the replacement session durable entry", () => {
  const staleSourceState = createPhaseState({ feature: "old-source" });
  const replacementState = createPendingSessionHandoff(
    createPhaseState({ feature: "new-target" }),
    {
      id: "handoff-2",
      boundary: "task",
      reason: "completed T002",
      targetPhase: "tdd_implement",
      taskId: "T002",
    },
  );
  const sessionManager = createFakeReplacementSessionManager({
    entries: recordedArray<TestSessionEntry>([
      {
        type: "custom",
        customType: RALPH_WORKS_STATE_ENTRY_TYPE,
        data: staleSourceState as WorkflowStateWithHandoff,
        content: "",
        display: false,
      },
    ]),
  });

  setupReplacementSession(sessionManager, replacementState, {
    handoffId: "handoff-2",
    handoffSummary: "handoff summary",
  });

  const restored = restoreRequiredState({ sessionManager });

  assert.equal(restored.feature, "new-target");
  assert.equal(restored.pendingHandoff.id, "handoff-2");
  assert.equal(restored.pendingHandoff.status, "ready_in_new_session");
  assert.equal(restored.pendingHandoff.taskId, "T002");
  assert.equal(
    restored.phases.find((phase) => phase.id === "generate_spec")?.artifactPath,
    "docs/new-target-generated-spec.md",
  );
});
