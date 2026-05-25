import assert from "node:assert/strict";
import test from "node:test";

import {
  RALPH_WORKS_HANDOFF_MESSAGE_ENTRY_TYPE,
  RALPH_WORKS_STATE_ENTRY_TYPE,
  restoreRalphWorksState,
  setupRalphWorksReplacementSession,
} from "../src/harness/pi-state-persistence.js";
import { createPhaseState } from "../src/state/phase-state.js";
import { createPendingSessionHandoff } from "../src/state/session-handoff-state.js";

function createFakeReplacementSessionManager({
  sessionFile = "sessions/replacement.json",
  entries = [],
} = {}) {
  return {
    entries,
    appendCustomEntry(customType, data) {
      const entry = {
        type: "custom",
        customType,
        data,
      };
      entries.push(entry);
      return `entry-${entries.length}`;
    },
    appendCustomMessageEntry(customType, content, display, details) {
      const entry = {
        type: "custom_message",
        customType,
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

  const restored = restoreRalphWorksState({
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
    restored.phases.find((phase) => phase.id === "generate_spec").artifactPath,
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

  const result = setupRalphWorksReplacementSession(sessionManager, state, {
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
    entries: [
      {
        type: "custom",
        customType: RALPH_WORKS_STATE_ENTRY_TYPE,
        data: staleSourceState,
      },
    ],
  });

  setupRalphWorksReplacementSession(sessionManager, replacementState, {
    handoffId: "handoff-2",
    handoffSummary: "handoff summary",
  });

  const restored = restoreRalphWorksState({ sessionManager });

  assert.equal(restored.feature, "new-target");
  assert.equal(restored.pendingHandoff.id, "handoff-2");
  assert.equal(restored.pendingHandoff.status, "ready_in_new_session");
  assert.equal(restored.pendingHandoff.taskId, "T002");
  assert.equal(
    restored.phases.find((phase) => phase.id === "generate_spec").artifactPath,
    "docs/new-target-generated-spec.md",
  );
});
