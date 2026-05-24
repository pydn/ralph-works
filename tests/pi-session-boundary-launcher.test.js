import assert from "node:assert/strict";
import test from "node:test";
import {
  launchPiSessionBoundary,
  RALPH_WORKS_SESSION_BOUNDARY_PLAN_ENTRY_TYPE,
} from "../src/harness/pi-session-boundary-launcher.js";
import { RALPH_WORKS_STATE_ENTRY_TYPE } from "../src/harness/pi-state-persistence.js";
import {
  buildSessionBoundaryPlan,
  RALPH_WORKS_SESSION_BOUNDARY_MESSAGE_TYPE,
} from "../src/harness/session-boundary-plan.js";
import { createPhaseState } from "../src/state/phase-state.js";
import {
  appendSessionBoundaryEvent,
  createSessionBoundaryEvent,
  findSessionBoundaryEvent,
} from "../src/state/session-boundaries.js";

function createBoundaryState(boundaryId = "boundary-1") {
  const state = createPhaseState({
    feature: "new-session",
    promptText: "fresh sessions",
  });
  return appendSessionBoundaryEvent(
    {
      ...state,
      currentPhase: "tdd_implement",
    },
    createSessionBoundaryEvent({
      id: boundaryId,
      boundaryType: "task",
      reason: "completed T002",
      fromPhase: "tdd_implement",
      taskId: "T002",
      nextTaskId: "T003",
      now: () => "2026-05-24T00:00:00.000Z",
    }),
  );
}

function createPlan(state, overrides = {}) {
  return buildSessionBoundaryPlan(state, {
    boundaryId: "boundary-1",
    boundaryType: "task",
    reason: "completed T002",
    nextActionType: "tdd_task_prompt",
    kickoffPrompt: "Continue TDD with T003.",
    selectedModelTarget: {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      raw: "anthropic/claude-sonnet-4-5",
    },
    task: {
      id: "T003",
      title: "Implement the fresh-session boundary launcher",
      raw: "- [ ] T003 P0 Implement the fresh-session boundary launcher",
    },
    ...overrides,
  });
}

function createWritableSessionManager(sessionFile = "/sessions/new.jsonl") {
  const entries = [];
  return {
    entries,
    getSessionFile() {
      return sessionFile;
    },
    getSessionId() {
      return "new-session-id";
    },
    appendCustomEntry(customType, data) {
      entries.push({ type: "custom", customType, data });
      return `${customType}-${entries.length}`;
    },
    appendCustomMessageEntry(customType, content, display, details) {
      entries.push({
        type: "custom_message",
        customType,
        content,
        display,
        details,
      });
      return `${customType}-${entries.length}`;
    },
    appendModelChange(provider, modelId) {
      entries.push({ type: "model", provider, modelId });
      return `model-${entries.length}`;
    },
  };
}

test("launchPiSessionBoundary creates a fresh session, seeds setup entries, links parent, and sends kickoff from replacement context", async () => {
  const state = createBoundaryState();
  const plan = createPlan(state);
  const order = [];
  const setupSessionManager = createWritableSessionManager();
  const replacementPrompts = [];
  const oldPrompts = [];
  let newSessionOptions;
  const ctx = {
    ui: { notify: () => {} },
    sessionManager: {
      getSessionFile: () => "/sessions/old.jsonl",
    },
    waitForIdle: async () => {
      order.push("waitForIdle");
    },
    sendUserMessage: async (content) => {
      oldPrompts.push(content);
    },
    compact: () => {
      throw new Error("compact should not run on the fresh-session path");
    },
    newSession: async (options) => {
      order.push("newSession");
      newSessionOptions = options;
      await options.setup(setupSessionManager);
      await options.withSession({
        ui: { notify: () => {} },
        sessionManager: createWritableSessionManager(),
        sendUserMessage: async (content, options) => {
          replacementPrompts.push({ content, options });
        },
      });
      return { cancelled: false };
    },
  };

  const result = await launchPiSessionBoundary(ctx, state, plan, {
    now: () => 100,
  });

  assert.deepEqual(order, ["waitForIdle", "newSession"]);
  assert.equal(newSessionOptions.parentSession, "/sessions/old.jsonl");
  assert.equal(oldPrompts.length, 0);
  assert.deepEqual(replacementPrompts, [
    {
      content: "Continue TDD with T003.",
      options: { deliverAs: "followUp" },
    },
  ]);
  assert.equal(result.status, "created");
  assert.equal(result.freshSessionCreated, true);
  assert.equal(result.fallbackUsed, false);
  assert.deepEqual(result.state.compactionEvents, []);

  const stateEntries = setupSessionManager.entries.filter(
    (entry) =>
      entry.type === "custom" &&
      entry.customType === RALPH_WORKS_STATE_ENTRY_TYPE,
  );
  assert.equal(stateEntries.length, 1);
  assert.equal(stateEntries[0].data.currentPhase, "tdd_implement");
  assert.equal(
    findSessionBoundaryEvent(stateEntries[0].data, "boundary-1").status,
    "created",
  );

  const customMessage = setupSessionManager.entries.find(
    (entry) => entry.type === "custom_message",
  );
  assert.equal(
    customMessage.customType,
    RALPH_WORKS_SESSION_BOUNDARY_MESSAGE_TYPE,
  );
  assert.equal(customMessage.display, true);
  assert.match(
    customMessage.content,
    /^RalphWorks is starting a new session for task\./,
  );
  assert.match(
    customMessage.content,
    /Repository files and RalphWorks artifacts are authoritative\./,
  );
  assert.deepEqual(customMessage.details, {
    boundaryId: "boundary-1",
    boundaryType: "task",
    reason: "completed T002",
    nextActionType: "tdd_task_prompt",
  });
  assert.ok(
    setupSessionManager.entries.some(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === RALPH_WORKS_SESSION_BOUNDARY_PLAN_ENTRY_TYPE &&
        entry.data.boundaryId === "boundary-1",
    ),
  );
  assert.ok(
    setupSessionManager.entries.some(
      (entry) =>
        entry.type === "model" &&
        entry.provider === "anthropic" &&
        entry.modelId === "claude-sonnet-4-5",
    ),
  );

  const event = findSessionBoundaryEvent(result.state, "boundary-1");
  assert.equal(event.status, "created");
  assert.equal(event.freshSessionAttempted, true);
  assert.equal(event.freshSessionCreated, true);
  assert.equal(event.fallbackUsed, false);
  assert.equal(event.previousSessionId, "/sessions/old.jsonl");
  assert.equal(event.replacementSessionId, "/sessions/new.jsonl");
  assert.equal(event.elapsedMs, 0);
});

test("launchPiSessionBoundary records cancellation without compaction or duplicate prompts", async () => {
  const state = createBoundaryState();
  const plan = createPlan(state, {
    reason: "completed T002 SECRET_TOKEN=do-not-copy",
  });
  const notifications = [];
  let compactCalled = false;
  let replacementPromptCalled = false;
  const ctx = {
    ui: { notify: (message, level) => notifications.push({ message, level }) },
    sessionManager: { getSessionFile: () => "/sessions/old.jsonl" },
    waitForIdle: async () => {},
    compact: () => {
      compactCalled = true;
    },
    newSession: async () => {
      replacementPromptCalled = true;
      return { cancelled: true };
    },
  };

  const result = await launchPiSessionBoundary(ctx, state, plan);

  assert.equal(result.status, "cancelled");
  assert.equal(result.cancelled, true);
  assert.equal(result.fallbackUsed, false);
  assert.equal(compactCalled, false);
  assert.equal(replacementPromptCalled, true);
  assert.match(notifications[0].message, /cancelled.*boundary-1/i);
  assert.match(notifications[0].message, /reason: completed T002/i);
  assert.doesNotMatch(notifications[0].message, /do-not-copy|SECRET_TOKEN/);
  assert.equal(
    findSessionBoundaryEvent(result.state, "boundary-1").status,
    "cancelled",
  );
});

test("launchPiSessionBoundary falls back to compaction when newSession is unavailable and continues current-session prompt", async () => {
  const state = createBoundaryState();
  const plan = createPlan(state);
  const notifications = [];
  const fallbackPrompts = [];
  let compactOptions;
  const ctx = {
    ui: { notify: (message, level) => notifications.push({ message, level }) },
    sessionManager: { getSessionFile: () => "/sessions/old.jsonl" },
    compact: (options) => {
      compactOptions = options;
      options.onComplete();
    },
  };

  const result = await launchPiSessionBoundary(ctx, state, plan, {
    sendFallbackPrompt: async (content, options) => {
      fallbackPrompts.push({ content, options });
    },
  });

  assert.equal(result.status, "fallback_compaction");
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.freshSessionCreated, false);
  assert.ok(compactOptions.customInstructions.includes("completed T002"));
  assert.deepEqual(fallbackPrompts, [
    {
      content: "Continue TDD with T003.",
      options: { deliverAs: "followUp" },
    },
  ]);
  assert.match(notifications[0].message, /fallback compaction.*boundary-1/i);
  assert.match(notifications[0].message, /reason: completed T002/i);
  const event = findSessionBoundaryEvent(result.state, "boundary-1");
  assert.equal(event.status, "fallback_compaction");
  assert.equal(event.freshSessionAttempted, false);
  assert.equal(event.fallbackUsed, true);
  assert.equal(result.state.compactionEvents.length, 1);
  assert.equal(result.state.compactionEvents[0].boundary, "task");
  assert.equal(result.state.compactionEvents[0].reason, "completed T002");
});

test("launchPiSessionBoundary falls back to compaction when newSession throws before replacement", async () => {
  const state = createBoundaryState();
  const plan = createPlan(state);
  let compactCalled = false;
  const ctx = {
    ui: { notify: () => {} },
    sessionManager: { getSessionFile: () => "/sessions/old.jsonl" },
    waitForIdle: async () => {},
    compact: (options) => {
      compactCalled = true;
      options.onComplete();
    },
    newSession: async () => {
      throw new Error("session API failed");
    },
  };

  const result = await launchPiSessionBoundary(ctx, state, plan, {
    sendFallbackPrompt: async () => {},
  });

  assert.equal(compactCalled, true);
  assert.equal(result.status, "fallback_compaction");
  assert.equal(
    findSessionBoundaryEvent(result.state, "boundary-1").freshSessionAttempted,
    true,
  );
});

test("launchPiSessionBoundary reports degraded behavior when both newSession and compaction fallback are unavailable", async () => {
  const state = createBoundaryState();
  const plan = createPlan(state);
  const notifications = [];
  const ctx = {
    ui: { notify: (message, level) => notifications.push({ message, level }) },
    sessionManager: { getSessionFile: () => "/sessions/old.jsonl" },
  };

  const result = await launchPiSessionBoundary(ctx, state, plan);

  assert.equal(result.status, "fallback_unavailable");
  assert.equal(result.fallbackUsed, false);
  assert.match(notifications[0].message, /unable.*boundary-1/i);
  assert.match(notifications[0].message, /reason: completed T002/i);
  assert.deepEqual(result.state.compactionEvents, []);
  assert.equal(
    findSessionBoundaryEvent(result.state, "boundary-1").status,
    "fallback_unavailable",
  );
});

test("launchPiSessionBoundary records followup_failed after replacement without using old-session prompt or compaction", async () => {
  const state = createBoundaryState();
  const plan = createPlan(state);
  const oldPrompts = [];
  let compactCalled = false;
  const replacementNotifications = [];
  const replacementSessionManager = createWritableSessionManager(
    "/sessions/replacement.jsonl",
  );
  const ctx = {
    ui: { notify: () => {} },
    sessionManager: { getSessionFile: () => "/sessions/old.jsonl" },
    waitForIdle: async () => {},
    sendUserMessage: async (content) => oldPrompts.push(content),
    compact: () => {
      compactCalled = true;
    },
    newSession: async (options) => {
      await options.setup(createWritableSessionManager());
      await options.withSession({
        ui: {
          notify: (message, level) =>
            replacementNotifications.push({ message, level }),
        },
        sessionManager: replacementSessionManager,
        sendUserMessage: async () => {
          throw new Error(
            "replacement prompt failed SECRET_TOKEN=do-not-copy RAW_GATE_OUTPUT:abcdef",
          );
        },
      });
      return { cancelled: false };
    },
  };

  const result = await launchPiSessionBoundary(ctx, state, plan);

  assert.equal(result.status, "followup_failed");
  assert.equal(result.freshSessionCreated, true);
  assert.equal(result.fallbackUsed, false);
  assert.equal(compactCalled, false);
  assert.deepEqual(oldPrompts, []);
  assert.match(
    replacementNotifications[0].message,
    /follow-up failed.*boundary-1/i,
  );
  assert.match(replacementNotifications[0].message, /reason: completed T002/i);
  assert.doesNotMatch(
    replacementNotifications[0].message,
    /do-not-copy|SECRET_TOKEN|RAW_GATE_OUTPUT|Continue TDD/,
  );
  assert.equal(
    findSessionBoundaryEvent(result.state, "boundary-1").status,
    "followup_failed",
  );

  const replacementStateEntries = replacementSessionManager.entries.filter(
    (entry) =>
      entry.type === "custom" &&
      entry.customType === RALPH_WORKS_STATE_ENTRY_TYPE,
  );
  assert.equal(replacementStateEntries.length, 1);
  assert.equal(
    findSessionBoundaryEvent(replacementStateEntries[0].data, "boundary-1")
      .status,
    "followup_failed",
  );
});
