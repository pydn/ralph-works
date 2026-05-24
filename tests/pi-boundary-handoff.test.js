import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { registerRalphWorksExtension } from "../src/harness/pi-harness-adapter.js";
import { RALPH_WORKS_STATE_ENTRY_TYPE } from "../src/harness/pi-state-persistence.js";
import { createPhaseState } from "../src/state/phase-state.js";
import {
  createSessionBoundaryEvent,
  findSessionBoundaryEvent,
} from "../src/state/session-boundaries.js";

function createFakePi({
  exec = async () => ({ code: 0, stdout: "ok", stderr: "" }),
} = {}) {
  const calls = {
    commands: new Map(),
    events: new Map(),
    tools: [],
    appended: [],
    models: [],
    userMessages: [],
  };

  return {
    calls,
    pi: {
      on(eventName, handler) {
        calls.events.set(eventName, handler);
      },
      registerCommand(name, options) {
        calls.commands.set(name, options);
      },
      registerTool(definition) {
        calls.tools.push(definition);
      },
      appendEntry(customType, data) {
        calls.appended.push({ customType, data });
      },
      async setModel(model) {
        calls.models.push(model);
        return true;
      },
      async exec(command, args) {
        return exec(command, args);
      },
      sendUserMessage(content, options) {
        calls.userMessages.push({ content, options });
      },
    },
  };
}

function createWritableSessionManager(
  sessionFile = "/sessions/replacement.jsonl",
) {
  const entries = [];
  return {
    entries,
    getSessionFile() {
      return sessionFile;
    },
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
    appendModelChange(provider, modelId) {
      entries.push({ type: "model", provider, modelId });
    },
  };
}

function createFakeContext(cwd, { entries = [] } = {}) {
  const calls = {
    statuses: [],
    widgets: [],
    notifications: [],
    compactions: [],
    newSessions: [],
    waits: 0,
    replacementUserMessages: [],
    setupEntries: [],
  };

  return {
    calls,
    ctx: {
      cwd,
      hasUI: true,
      ui: {
        setStatus(key, value) {
          calls.statuses.push({ key, value });
        },
        setWidget(key, value) {
          calls.widgets.push({ key, value });
        },
        notify(message, level) {
          calls.notifications.push({ message, level });
        },
      },
      sessionManager: {
        getEntries() {
          return entries;
        },
        getSessionFile() {
          return "/sessions/original.jsonl";
        },
      },
      modelRegistry: {
        find(provider, id) {
          return { provider, id };
        },
      },
      async compact(options) {
        calls.compactions.push(options);
      },
      async waitForIdle() {
        calls.waits += 1;
      },
      async newSession(options) {
        calls.newSessions.push(options);
        const setupSessionManager = createWritableSessionManager();
        await options.setup?.(setupSessionManager);
        calls.setupEntries.push(...setupSessionManager.entries);
        await options.withSession?.({
          ui: {
            notify(message, level) {
              calls.notifications.push({ message, level, replacement: true });
            },
          },
          sessionManager: createWritableSessionManager(
            "/sessions/replacement.jsonl",
          ),
          sendUserMessage(content, options) {
            calls.replacementUserMessages.push({ content, options });
          },
        });
        return { cancelled: false };
      },
    },
  };
}

function latestState(piCalls) {
  return piCalls.appended.at(-1)?.data;
}

function latestBoundary(piCalls) {
  return latestState(piCalls).sessionBoundaryEvents.at(-1);
}

function latestSetupState(ctxCalls) {
  return ctxCalls.setupEntries
    .filter(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === RALPH_WORKS_STATE_ENTRY_TYPE,
    )
    .at(-1)?.data;
}

function createRestoredBoundaryState(status) {
  const boundaryId = `boundary-${status}`;
  return {
    ...createPhaseState({
      feature: "feature-a",
      promptText: "Build feature A",
      now: () => "2026-05-24T00:00:00.000Z",
    }),
    sessionBoundaryEvents: [
      createSessionBoundaryEvent({
        id: boundaryId,
        boundaryType: "phase",
        reason: `retry ${status}`,
        fromPhase: "start",
        toPhase: "generate_spec",
        status,
        freshSessionAttempted: status !== "pending",
        freshSessionCreated: status === "followup_failed",
        now: () => "2026-05-24T00:00:00.000Z",
      }),
    ],
  };
}

function stateEntry(state) {
  return {
    type: "custom",
    customType: RALPH_WORKS_STATE_ENTRY_TYPE,
    data: state,
  };
}

async function startPipeline(piCalls, ctx) {
  await piCalls.commands
    .get("ralph-works")
    .handler("start feature-a Build feature A", ctx);
}

async function finishAssistantTurn(piCalls, ctx, text) {
  await piCalls.events.get("agent_end")(
    {
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text }],
        },
      ],
    },
    ctx,
  );
}

async function advanceWithCommand(piCalls, ctx, _ctxCalls, command = "next") {
  await piCalls.commands.get("ralph-works").handler(command, ctx);
}

async function advanceToTdd(piCalls, ctx, ctxCalls) {
  await startPipeline(piCalls, ctx);
  await advanceWithCommand(piCalls, ctx, ctxCalls);
  await advanceWithCommand(piCalls, ctx, ctxCalls);
  await piCalls.commands.get("ralph-works").handler("next", ctx);
  assert.equal(latestState(piCalls).phaseStatus, "awaiting_harden_approval");
  await piCalls.commands.get("ralph-works").handler("approve", ctx);
  await advanceWithCommand(piCalls, ctx, ctxCalls);
  assert.equal(latestState(piCalls).currentPhase, "tdd_implement");
}

async function advanceToReview(piCalls, ctx, ctxCalls) {
  await advanceToTdd(piCalls, ctx, ctxCalls);
  await advanceWithCommand(piCalls, ctx, ctxCalls);
  assert.equal(latestState(piCalls).currentPhase, "review");
}

async function continueBoundary(piCalls, ctx, boundaryId) {
  await piCalls.commands
    .get("ralph-works")
    .handler(`continue-boundary ${boundaryId}`, ctx);
}

test("assistant phase markers enqueue an internal boundary command before command-context launch", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-handoff-"));
  try {
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await startPipeline(piCalls, ctx);
    const messagesBeforeMarker = piCalls.userMessages.length;

    await finishAssistantTurn(
      piCalls,
      ctx,
      "Spec complete.\nRALPH_PHASE_COMPLETE",
    );

    const boundary = latestBoundary(piCalls);
    assert.equal(latestState(piCalls).currentPhase, "red_team");
    assert.equal(boundary.boundaryType, "phase");
    assert.equal(boundary.status, "pending");
    assert.equal(ctxCalls.compactions.length, 0);
    assert.equal(ctxCalls.newSessions.length, 1);
    assert.deepEqual(piCalls.userMessages.at(-1), {
      content: `/ralph-works continue-boundary ${boundary.id}`,
      options: { deliverAs: "followUp" },
    });
    assert.equal(piCalls.userMessages.length, messagesBeforeMarker + 1);

    const replacementPromptsBeforeBoundary =
      ctxCalls.replacementUserMessages.length;
    await continueBoundary(piCalls, ctx, boundary.id);

    assert.equal(ctxCalls.waits, 2);
    assert.equal(ctxCalls.newSessions.length, 2);
    assert.equal(ctxCalls.compactions.length, 0);
    assert.equal(
      ctxCalls.newSessions.at(-1).parentSession,
      "/sessions/original.jsonl",
    );
    assert.equal(
      ctxCalls.replacementUserMessages.length,
      replacementPromptsBeforeBoundary + 1,
    );
    assert.match(
      String(ctxCalls.replacementUserMessages.at(-1).content),
      /# ralph-works Phase: Red Team Pass/,
    );
    assert.equal(
      findSessionBoundaryEvent(latestSetupState(ctxCalls), boundary.id).status,
      "created",
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("assistant TDD markers enqueue a task boundary and retries do not duplicate kickoff", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-handoff-"));
  try {
    await mkdir(path.join(tempDir, "docs"));
    await writeFile(
      path.join(tempDir, "docs/feature-a-task-list.md"),
      [
        "- [ ] T001 P0 Build phase state",
        "- [ ] T002 P1 Render task progress",
      ].join("\n"),
    );

    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });
    await advanceToTdd(piCalls, ctx, ctxCalls);

    const compactionsBeforeMarker = ctxCalls.compactions.length;
    const newSessionsBeforeMarker = ctxCalls.newSessions.length;

    await finishAssistantTurn(
      piCalls,
      ctx,
      "T001 done.\nRALPH_TDD_TASK_COMPLETE T001",
    );

    const boundary = latestBoundary(piCalls);
    assert.equal(latestState(piCalls).currentPhase, "tdd_implement");
    assert.equal(latestState(piCalls).tddCompletedTasks, 1);
    assert.equal(boundary.boundaryType, "task");
    assert.equal(boundary.taskId, "T001");
    assert.equal(boundary.nextTaskId, "T002");
    assert.equal(boundary.status, "pending");
    assert.equal(ctxCalls.compactions.length, compactionsBeforeMarker);
    assert.equal(ctxCalls.newSessions.length, newSessionsBeforeMarker);
    assert.deepEqual(piCalls.userMessages.at(-1), {
      content: `/ralph-works continue-boundary ${boundary.id}`,
      options: { deliverAs: "followUp" },
    });

    const replacementPromptsBeforeContinue =
      ctxCalls.replacementUserMessages.length;
    await continueBoundary(piCalls, ctx, boundary.id);

    assert.equal(ctxCalls.newSessions.length, newSessionsBeforeMarker + 1);
    assert.equal(
      ctxCalls.replacementUserMessages.length,
      replacementPromptsBeforeContinue + 1,
    );
    assert.match(
      String(ctxCalls.replacementUserMessages.at(-1).content),
      /Continue TDD implementation with the next incomplete task/,
    );
    assert.match(
      String(ctxCalls.replacementUserMessages.at(-1).content),
      /# ralph-works Phase: Red-Green TDD Implement/,
    );

    await continueBoundary(piCalls, ctx, boundary.id);

    assert.equal(ctxCalls.newSessions.length, newSessionsBeforeMarker + 1);
    assert.equal(
      ctxCalls.replacementUserMessages.length,
      replacementPromptsBeforeContinue + 1,
    );
    assert.match(ctxCalls.notifications.at(-1).message, /boundary/i);
    assert.match(ctxCalls.notifications.at(-1).message, /handled|stale/i);
    assert.match(
      ctxCalls.notifications.at(-1).message,
      /reason: completed T001/i,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("stale boundary launcher commands are ignored with a notification", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-handoff-"));
  try {
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });
    await startPipeline(piCalls, ctx);

    await continueBoundary(piCalls, ctx, "missing-boundary");

    assert.equal(ctxCalls.newSessions.length, 1);
    assert.match(ctxCalls.notifications.at(-1).message, /missing-boundary/);
    assert.match(ctxCalls.notifications.at(-1).message, /stale|pending/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("retryable boundary states can be continued after restore", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-handoff-"));
  try {
    for (const status of [
      "launching",
      "cancelled",
      "fallback_unavailable",
      "followup_failed",
    ]) {
      const restoredState = createRestoredBoundaryState(status);
      const boundaryId = restoredState.sessionBoundaryEvents[0].id;
      const { pi, calls: piCalls } = createFakePi();
      const { ctx, calls: ctxCalls } = createFakeContext(tempDir, {
        entries: [stateEntry(restoredState)],
      });
      registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

      await piCalls.events.get("session_start")({}, ctx);
      await continueBoundary(piCalls, ctx, boundaryId);

      assert.equal(ctxCalls.compactions.length, 0, status);
      assert.equal(ctxCalls.newSessions.length, 1, status);
      assert.equal(ctxCalls.replacementUserMessages.length, 1, status);
      assert.match(
        String(ctxCalls.replacementUserMessages[0].content),
        /# ralph-works Phase: Generate Spec/,
        status,
      );
      assert.equal(
        findSessionBoundaryEvent(latestSetupState(ctxCalls), boundaryId)
          ?.status,
        "created",
        status,
      );
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("completed boundary states stay stale and do not duplicate prompts", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-handoff-"));
  try {
    for (const status of ["created", "fallback_compaction", "complete"]) {
      const restoredState = createRestoredBoundaryState(status);
      const boundaryId = restoredState.sessionBoundaryEvents[0].id;
      const { pi, calls: piCalls } = createFakePi();
      const { ctx, calls: ctxCalls } = createFakeContext(tempDir, {
        entries: [stateEntry(restoredState)],
      });
      registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

      await piCalls.events.get("session_start")({}, ctx);
      await continueBoundary(piCalls, ctx, boundaryId);

      assert.equal(ctxCalls.newSessions.length, 0, status);
      assert.equal(ctxCalls.replacementUserMessages.length, 0, status);
      assert.match(ctxCalls.notifications.at(-1).message, /stale|handled/i);
      assert.match(ctxCalls.notifications.at(-1).message, new RegExp(status));
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("review loopback and LGTM boundaries use command handoff", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-handoff-"));
  try {
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });
    await advanceToReview(piCalls, ctx, ctxCalls);

    const compactionsBeforeLoopback = ctxCalls.compactions.length;
    await finishAssistantTurn(
      piCalls,
      ctx,
      "[CRITICAL] Missing regression test.",
    );
    const loopbackBoundary = latestBoundary(piCalls);

    assert.equal(latestState(piCalls).currentPhase, "tdd_implement");
    assert.equal(latestState(piCalls).loopbackCount, 1);
    assert.equal(ctxCalls.compactions.length, compactionsBeforeLoopback);
    assert.deepEqual(piCalls.userMessages.at(-1), {
      content: `/ralph-works continue-boundary ${loopbackBoundary.id}`,
      options: { deliverAs: "followUp" },
    });

    await continueBoundary(piCalls, ctx, loopbackBoundary.id);

    assert.match(
      String(ctxCalls.replacementUserMessages.at(-1).content),
      /Review requested changes/,
    );
    assert.match(
      String(ctxCalls.replacementUserMessages.at(-1).content),
      /# ralph-works Phase: Red-Green TDD Implement/,
    );

    await advanceWithCommand(piCalls, ctx, ctxCalls);
    const replacementPromptsBeforeLgtm =
      ctxCalls.replacementUserMessages.length;
    const compactionsBeforeLgtm = ctxCalls.compactions.length;

    await finishAssistantTurn(piCalls, ctx, "LGTM. No critical bugs found.");
    const completeBoundary = latestBoundary(piCalls);

    assert.equal(latestState(piCalls).currentPhase, "complete");
    assert.equal(latestState(piCalls).pipelineStatus, "completed");
    assert.equal(ctxCalls.compactions.length, compactionsBeforeLgtm);
    assert.deepEqual(piCalls.userMessages.at(-1), {
      content: `/ralph-works continue-boundary ${completeBoundary.id}`,
      options: { deliverAs: "followUp" },
    });

    await continueBoundary(piCalls, ctx, completeBoundary.id);

    assert.equal(
      ctxCalls.replacementUserMessages.length,
      replacementPromptsBeforeLgtm,
    );
    assert.equal(
      findSessionBoundaryEvent(latestSetupState(ctxCalls), completeBoundary.id)
        .status,
      "created",
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
