import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { registerRalphWorksExtension } from "../src/harness/pi-harness-adapter.js";
import { RALPH_WORKS_NEW_SESSION_NOTICE } from "../src/harness/pi-session-handoff.js";
import { RALPH_WORKS_STATE_ENTRY_TYPE } from "../src/harness/pi-state-persistence.js";
import { createPhaseState } from "../src/state/phase-state.js";
import { transitionToPhase } from "../src/state/phase-transitions.js";
import {
  createPendingSessionHandoff,
  failSessionHandoff,
  markSessionHandoffReadyInNewSession,
} from "../src/state/session-handoff-state.js";

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
    operations: [],
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
        calls.operations.push({ type: "setModel", model });
        return true;
      },
      async exec(command, args) {
        return exec(command, args);
      },
      sendUserMessage(content, options) {
        calls.userMessages.push({ content, options });
        calls.operations.push({ type: "sendUserMessage", content, options });
      },
    },
  };
}

function createFakeContext(
  cwd,
  { entries = [], newSession, parentSession = "sessions/source.jsonl" } = {},
) {
  const calls = {
    statuses: [],
    widgets: [],
    notifications: [],
    newSessions: [],
    replacementContexts: [],
  };

  const ctx = {
    calls,
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
        return parentSession;
      },
    },
    modelRegistry: {
      find(provider, id) {
        return { provider, id };
      },
    },
  };

  ctx.newSession = async (options) => {
    calls.newSessions.push(options);
    if (newSession) {
      return newSession(options);
    }

    const replacementEntries = [];
    const replacementSessionManager = {
      appendCustomEntry(customType, data) {
        replacementEntries.push({ type: "custom", customType, data });
      },
      appendCustomMessageEntry(customType, content, display, details) {
        replacementEntries.push({
          type: "custom_message",
          customType,
          content,
          display,
          details,
        });
      },
      getEntries() {
        return replacementEntries;
      },
      getSessionFile() {
        return `sessions/replacement-${calls.newSessions.length}.jsonl`;
      },
    };
    const replacementCtx = {
      ...ctx,
      sessionManager: replacementSessionManager,
    };
    calls.replacementContexts.push(replacementCtx);
    await options.setup(replacementSessionManager);
    await options.withSession(replacementCtx);
    return { cancelled: false };
  };

  return { calls, ctx };
}

function latestState(piCalls) {
  return piCalls.appended.at(-1)?.data;
}

async function startPipeline(
  piCalls,
  ctx,
  args = "start feature-a Build feature A",
) {
  await piCalls.commands.get("ralph-works").handler(args, ctx);
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

async function completeLatestHandoff(_ctxCalls, piCalls, ctx) {
  const queuedHandoff = piCalls.userMessages.at(-1);
  if (/^\/ralph-works handoff \S+$/.test(queuedHandoff?.content ?? "")) {
    await runQueuedHandoffThroughReplacement(piCalls, ctx);
  }
}

async function advanceToHardenSpecWithNext(piCalls, ctx) {
  await startPipeline(piCalls, ctx);
  await piCalls.commands.get("ralph-works").handler("next", ctx);
  await completeLatestHandoff(ctx.calls, piCalls, ctx);
  await piCalls.commands.get("ralph-works").handler("next", ctx);
  await completeLatestHandoff(ctx.calls, piCalls, ctx);
  assert.equal(latestState(piCalls).currentPhase, "harden_spec");
}

async function requestAndApproveHardenSpec(piCalls, ctx) {
  await piCalls.commands.get("ralph-works").handler("next", ctx);
  assert.equal(latestState(piCalls).currentPhase, "harden_spec");
  assert.equal(latestState(piCalls).phaseStatus, "awaiting_harden_approval");
  await completeLatestHandoff(ctx.calls, piCalls, ctx);

  await piCalls.commands.get("ralph-works").handler("approve", ctx);
  assert.equal(latestState(piCalls).currentPhase, "create_tasks");
  assert.equal(latestState(piCalls).phaseStatus, "executing");
  await completeLatestHandoff(ctx.calls, piCalls, ctx);
  assert.equal(latestState(piCalls).phaseStatus, "executing");
}

async function advanceToTddWithApproval(piCalls, ctx) {
  await advanceToHardenSpecWithNext(piCalls, ctx);
  await requestAndApproveHardenSpec(piCalls, ctx);
  await piCalls.commands.get("ralph-works").handler("next", ctx);
  await completeLatestHandoff(ctx.calls, piCalls, ctx);
  assert.equal(latestState(piCalls).currentPhase, "tdd_implement");
}

async function advanceToReviewWithApproval(piCalls, ctx) {
  await advanceToTddWithApproval(piCalls, ctx);
  await finishAssistantTurn(
    piCalls,
    ctx,
    "Implementation complete.\nRALPH_PHASE_COMPLETE",
  );
  await completeLatestHandoff(ctx.calls, piCalls, ctx);
  assert.equal(latestState(piCalls).currentPhase, "review");
}

function createWorkflowStateAtPhase(
  phaseId,
  { feature = "feature-a", promptText = "Build feature A" } = {},
) {
  let workflowState = createPhaseState({ feature, promptText });
  if (phaseId === "generate_spec") {
    return workflowState;
  }

  workflowState = transitionToPhase(workflowState, "red_team", {
    reason: "completed generate_spec",
  });
  if (phaseId === "red_team") {
    return workflowState;
  }

  workflowState = transitionToPhase(workflowState, "harden_spec", {
    reason: "completed red_team",
  });
  if (phaseId === "harden_spec") {
    return workflowState;
  }

  if (phaseId === "render_html_optional") {
    return transitionToPhase(workflowState, "render_html_optional", {
      reason: "hardened spec approved",
    });
  }

  workflowState = transitionToPhase(workflowState, "create_tasks", {
    reason: "hardened spec approved",
  });
  if (phaseId === "create_tasks") {
    return workflowState;
  }

  workflowState = transitionToPhase(workflowState, "tdd_implement", {
    reason: "completed create_tasks",
  });
  if (phaseId === "tdd_implement") {
    return workflowState;
  }

  workflowState = transitionToPhase(workflowState, "review", {
    reason: "completed tdd_implement",
  });
  if (phaseId === "review") {
    return workflowState;
  }

  throw new Error(`Unsupported test phase: ${phaseId}`);
}

function createReadyPhaseHandoffState({
  feature = "feature-a",
  id = "handoff-1",
  sourcePhase = "generate_spec",
  targetPhase = "red_team",
  reason = "completed generate_spec",
} = {}) {
  const workflowState = createWorkflowStateAtPhase(targetPhase, { feature });

  return markSessionHandoffReadyInNewSession(
    createPendingSessionHandoff(workflowState, {
      id,
      boundary: "phase",
      reason,
      sourcePhase,
      targetPhase,
    }),
    id,
    { replacementSessionFile: "sessions/replacement.jsonl" },
  );
}

function createHandoffContexts(tempDir, sourceState) {
  const sourceEntries = [
    {
      type: "custom",
      customType: RALPH_WORKS_STATE_ENTRY_TYPE,
      data: sourceState,
    },
  ];
  const replacementEntries = [];
  const replacementSessionManager = {
    appendCustomEntry(customType, data) {
      replacementEntries.push({ type: "custom", customType, data });
    },
    appendCustomMessageEntry(customType, content, display, details) {
      replacementEntries.push({
        type: "custom_message",
        customType,
        content,
        display,
        details,
      });
    },
    getEntries() {
      return replacementEntries;
    },
    getSessionFile() {
      return "sessions/replacement.jsonl";
    },
  };
  const { ctx: replacementCtx, calls: replacementCalls } = createFakeContext(
    tempDir,
    {
      entries: replacementEntries,
      parentSession: "sessions/replacement.jsonl",
    },
  );
  replacementCtx.sessionManager = replacementSessionManager;

  const { ctx: sourceCtx, calls: sourceCalls } = createFakeContext(tempDir, {
    entries: sourceEntries,
    newSession: async (options) => {
      await options.setup(replacementSessionManager);
      await options.withSession(replacementCtx);
      return { cancelled: false };
    },
  });

  return {
    replacementCtx,
    replacementCalls,
    replacementEntries,
    sourceCtx,
    sourceCalls,
  };
}

async function runQueuedHandoffThroughReplacement(
  piCalls,
  sourceCtx,
  replacementCtx,
) {
  const queuedHandoff = piCalls.userMessages.at(-1);
  const match = /^\/ralph-works handoff (\S+)$/.exec(queuedHandoff?.content);
  assert.ok(match, "expected queued internal handoff command");
  const handoffId = match[1];

  await piCalls.commands
    .get("ralph-works")
    .handler(`handoff ${handoffId}`, sourceCtx);
  const activeReplacementCtx =
    replacementCtx ?? sourceCtx.calls.replacementContexts.at(-1);
  assert.ok(activeReplacementCtx, "expected replacement session context");

  await piCalls.events.get("session_start")(
    { reason: "new", previousSessionFile: "sessions/source.jsonl" },
    activeReplacementCtx,
  );

  assert.equal(
    piCalls.userMessages.at(-1).content,
    `/ralph-works resume-handoff ${handoffId}`,
  );
  await piCalls.commands
    .get("ralph-works")
    .handler(`resume-handoff ${handoffId}`, activeReplacementCtx);

  return handoffId;
}

async function writeFeatureTaskList(tempDir, markdown) {
  await mkdir(path.join(tempDir, "docs"), { recursive: true });
  await writeFile(path.join(tempDir, "docs/feature-a-task-list.md"), markdown);
}

function createLifecycleHarness(tempDir, { exec } = {}) {
  const runtimes = [];
  let activeRuntime;
  let nextSessionNumber = 1;

  function createRuntime({ entries = [], sessionFile } = {}) {
    const runtimeSessionFile =
      sessionFile ?? `sessions/lifecycle-${nextSessionNumber}.jsonl`;
    nextSessionNumber += 1;

    const { pi, calls: piCalls } = createFakePi({ exec });
    let ctx;
    const { ctx: runtimeCtx, calls: ctxCalls } = createFakeContext(tempDir, {
      entries,
      parentSession: runtimeSessionFile,
      newSession: async (options) => {
        const replacementSessionFile = `sessions/lifecycle-${nextSessionNumber}.jsonl`;
        const replacementEntries = [];
        const replacementSessionManager = {
          appendCustomEntry(customType, data) {
            replacementEntries.push({ type: "custom", customType, data });
          },
          appendCustomMessageEntry(customType, content, display, details) {
            replacementEntries.push({
              type: "custom_message",
              customType,
              content,
              display,
              details,
            });
          },
          getEntries() {
            return replacementEntries;
          },
          getSessionFile() {
            return replacementSessionFile;
          },
        };

        await options.setup(replacementSessionManager);
        const replacementRuntime = createRuntime({
          entries: replacementEntries,
          sessionFile: replacementSessionFile,
        });
        replacementRuntime.ctx.sessionManager = replacementSessionManager;
        await replacementRuntime.piCalls.events.get("session_start")(
          {
            reason: "new",
            previousSessionFile: ctx.sessionManager.getSessionFile(),
          },
          replacementRuntime.ctx,
        );
        await options.withSession(replacementRuntime.ctx);
        activeRuntime = replacementRuntime;
        return { cancelled: false };
      },
    });
    ctx = runtimeCtx;
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    const runtime = {
      ctx,
      ctxCalls,
      pi,
      piCalls,
      sessionFile: runtimeSessionFile,
    };
    runtimes.push(runtime);
    activeRuntime = activeRuntime ?? runtime;
    return runtime;
  }

  const firstRuntime = createRuntime();

  return {
    firstRuntime,
    get activeRuntime() {
      return activeRuntime;
    },
    get runtimes() {
      return runtimes;
    },
  };
}

async function runActiveLifecycleHandoff(harness) {
  const sourceRuntime = harness.activeRuntime;
  const queuedHandoff = sourceRuntime.piCalls.userMessages.at(-1);
  const match = /^\/ralph-works handoff (\S+)$/.exec(queuedHandoff?.content);
  if (!match) {
    return harness.activeRuntime;
  }
  const handoffId = match[1];
  const sourceMessageCount = sourceRuntime.piCalls.userMessages.length;

  await sourceRuntime.piCalls.commands
    .get("ralph-works")
    .handler(`handoff ${handoffId}`, sourceRuntime.ctx);

  assert.equal(sourceRuntime.ctxCalls.newSessions.length, 1);
  assert.equal(sourceRuntime.piCalls.userMessages.length, sourceMessageCount);

  const replacementRuntime = harness.activeRuntime;
  assert.notEqual(replacementRuntime, sourceRuntime);
  assert.equal(
    replacementRuntime.piCalls.userMessages.at(-1).content,
    `/ralph-works resume-handoff ${handoffId}`,
  );

  await replacementRuntime.piCalls.commands
    .get("ralph-works")
    .handler(`resume-handoff ${handoffId}`, replacementRuntime.ctx);

  return replacementRuntime;
}

test("extension registers ralph-works command, tools, and skill discovery", async () => {
  const { pi, calls } = createFakePi();

  registerRalphWorksExtension(pi, {
    extensionRoot: path.resolve("."),
  });

  assert.equal(calls.commands.has("ralph-works"), true);
  assert.equal(
    calls.tools.some((tool) => tool.name === "ralph_works_status"),
    true,
  );

  const resources = await calls.events.get("resources_discover")(
    { reason: "startup" },
    {},
  );
  assert.deepEqual(resources.skillPaths, [path.resolve("skills")]);
});

test("ralph-works does not render TUI before the pipeline starts", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
  try {
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await piCalls.events.get("session_start")({ reason: "startup" }, ctx);
    await piCalls.commands.get("ralph-works").handler("status", ctx);

    assert.equal(ctxCalls.statuses.length, 0);
    assert.equal(ctxCalls.widgets.length, 0);
    assert.deepEqual(ctxCalls.notifications.at(-1), {
      message:
        "No active ralph-works pipeline. Start one with /ralph-works start <feature> [prompt].",
      level: "info",
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("/ralph-works help lists commands without requiring an active pipeline", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
  try {
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await piCalls.commands.get("ralph-works").handler("help", ctx);

    assert.equal(ctxCalls.statuses.length, 0);
    assert.equal(ctxCalls.widgets.length, 0);
    assert.equal(ctxCalls.notifications.length, 1);
    assert.equal(ctxCalls.notifications[0].level, "info");
    assert.match(
      ctxCalls.notifications[0].message,
      /\/ralph-works start <feature> \[prompt\]/,
    );
    assert.match(ctxCalls.notifications[0].message, /\/ralph-works help/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("internal handoff command creates a replacement session without old-session continuation", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
  try {
    const pendingState = createPendingSessionHandoff(
      createPhaseState({ feature: "feature-a" }),
      {
        id: "handoff-1",
        boundary: "phase",
        reason: "completed generate_spec",
        targetPhase: "red_team",
      },
    );
    const sourceEntries = [
      {
        type: "custom",
        customType: RALPH_WORKS_STATE_ENTRY_TYPE,
        data: pendingState,
      },
    ];
    const replacementEntries = [];
    const replacementSessionManager = {
      appendCustomEntry(customType, data) {
        replacementEntries.push({ type: "custom", customType, data });
      },
      appendCustomMessageEntry(customType, content, display, details) {
        replacementEntries.push({
          type: "custom_message",
          customType,
          content,
          display,
          details,
        });
      },
      getSessionFile() {
        return "sessions/replacement.jsonl";
      },
    };
    const replacementCtx = {
      cwd: tempDir,
      sessionManager: replacementSessionManager,
      ui: { notify() {} },
    };
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir, {
      entries: sourceEntries,
      newSession: async (options) => {
        await options.setup(replacementSessionManager);
        await options.withSession(replacementCtx);
        return { cancelled: false };
      },
    });
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await piCalls.events.get("session_start")({ reason: "startup" }, ctx);
    await piCalls.commands.get("ralph-works").handler("handoff handoff-1", ctx);

    assert.equal(ctxCalls.newSessions.length, 1);
    assert.equal(
      ctxCalls.newSessions[0].parentSession,
      "sessions/source.jsonl",
    );
    assert.equal(piCalls.userMessages.length, 0);
    assert.equal(
      ctxCalls.notifications.at(-1).message,
      RALPH_WORKS_NEW_SESSION_NOTICE,
    );
    assert.equal(latestState(piCalls).pendingHandoff.status, "in_progress");
    assert.equal(
      replacementEntries[0].customType,
      RALPH_WORKS_STATE_ENTRY_TYPE,
    );
    assert.equal(
      replacementEntries[0].data.pendingHandoff.status,
      "ready_in_new_session",
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("internal handoff command persists failed state when new session creation is cancelled", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
  try {
    const pendingState = createPendingSessionHandoff(
      createPhaseState({ feature: "feature-a" }),
      {
        id: "handoff-1",
        boundary: "phase",
        reason: "completed generate_spec",
        targetPhase: "red_team",
      },
    );
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir, {
      entries: [
        {
          type: "custom",
          customType: RALPH_WORKS_STATE_ENTRY_TYPE,
          data: pendingState,
        },
      ],
      newSession: async () => ({ cancelled: true }),
    });
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await piCalls.events.get("session_start")({ reason: "startup" }, ctx);
    await piCalls.commands.get("ralph-works").handler("handoff handoff-1", ctx);

    assert.equal(ctxCalls.newSessions.length, 1);
    assert.equal(latestState(piCalls).phaseStatus, "handoff_failed");
    assert.equal(latestState(piCalls).pipelineStatus, "blocked");
    assert.equal(latestState(piCalls).pendingHandoff.status, "failed");
    assert.match(
      latestState(piCalls).pendingHandoff.errorMessage,
      /cancelled/i,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("internal handoff command persists failed state when replacement setup fails", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
  try {
    const pendingState = createPendingSessionHandoff(
      createPhaseState({ feature: "feature-a" }),
      {
        id: "handoff-1",
        boundary: "phase",
        reason: "completed generate_spec",
        targetPhase: "red_team",
      },
    );
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir, {
      entries: [
        {
          type: "custom",
          customType: RALPH_WORKS_STATE_ENTRY_TYPE,
          data: pendingState,
        },
      ],
      newSession: async (options) => {
        await options.setup({
          appendCustomEntry() {},
          getSessionFile() {
            return "sessions/replacement.jsonl";
          },
        });
        throw new Error("setup should fail before replacement");
      },
    });
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await piCalls.events.get("session_start")({ reason: "startup" }, ctx);
    await piCalls.commands.get("ralph-works").handler("handoff handoff-1", ctx);

    assert.equal(ctxCalls.newSessions.length, 1);
    assert.equal(latestState(piCalls).phaseStatus, "handoff_failed");
    assert.equal(latestState(piCalls).pipelineStatus, "blocked");
    assert.match(
      latestState(piCalls).pendingHandoff.errorMessage,
      /append handoff context/i,
    );
    assert.match(
      ctxCalls.notifications.at(-1).message,
      /append handoff context/i,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("public commands are blocked while a handoff is pending but status and reset remain available", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
  try {
    const pendingState = createPendingSessionHandoff(
      createWorkflowStateAtPhase("red_team"),
      {
        id: "handoff-1",
        boundary: "phase",
        reason: "completed generate_spec",
        sourcePhase: "generate_spec",
        targetPhase: "red_team",
      },
    );
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir, {
      entries: [
        {
          type: "custom",
          customType: RALPH_WORKS_STATE_ENTRY_TYPE,
          data: pendingState,
        },
      ],
    });
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await piCalls.events.get("session_start")({ reason: "startup" }, ctx);
    const queuedMessages = piCalls.userMessages.length;
    const appendedEntries = piCalls.appended.length;

    for (const command of [
      "next",
      "approve",
      "loopback critical bugs",
      "tdd-complete T001",
      "gates",
      "artifact extra docs/extra.md",
      "start other-feature",
    ]) {
      await assert.doesNotReject(() =>
        piCalls.commands.get("ralph-works").handler(command, ctx),
      );
      assert.match(ctxCalls.notifications.at(-1).message, /handoff/i);
    }

    assert.equal(piCalls.userMessages.length, queuedMessages);
    assert.equal(piCalls.appended.length, appendedEntries);
    assert.equal(ctxCalls.newSessions.length, 0);

    await piCalls.commands.get("ralph-works").handler("status", ctx);
    assert.ok(ctxCalls.widgets.length > 0);

    await piCalls.commands.get("ralph-works").handler("reset", ctx);
    assert.deepEqual(ctxCalls.widgets.at(-1), {
      key: "ralph-works",
      value: [],
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("failed handoffs block advancement and internal execution until reset", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
  try {
    const pendingState = createPendingSessionHandoff(
      createWorkflowStateAtPhase("red_team"),
      {
        id: "handoff-1",
        boundary: "phase",
        reason: "completed generate_spec",
        sourcePhase: "generate_spec",
        targetPhase: "red_team",
      },
    );
    const failedState = failSessionHandoff(pendingState, "handoff-1", {
      error: new Error("new session cancelled"),
    });
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir, {
      entries: [
        {
          type: "custom",
          customType: RALPH_WORKS_STATE_ENTRY_TYPE,
          data: failedState,
        },
      ],
    });
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await piCalls.events.get("session_start")({ reason: "startup" }, ctx);
    const appendedEntries = piCalls.appended.length;

    for (const command of [
      "next",
      "start other-feature",
      "handoff handoff-1",
    ]) {
      await assert.doesNotReject(() =>
        piCalls.commands.get("ralph-works").handler(command, ctx),
      );
      assert.match(ctxCalls.notifications.at(-1).message, /handoff/i);
      assert.match(ctxCalls.notifications.at(-1).message, /failed/i);
    }

    const tool = piCalls.tools.find(
      (definition) => definition.name === "ralph_works_transition",
    );
    const result = await tool.execute("tool-1", {}, undefined, undefined, ctx);

    assert.match(result.content[0].text, /handoff_failed/);
    assert.equal(ctxCalls.newSessions.length, 0);
    assert.equal(piCalls.appended.length, appendedEntries);
    assert.equal(latestState(piCalls)?.currentPhase, undefined);

    await piCalls.commands.get("ralph-works").handler("status", ctx);
    assert.ok(ctxCalls.widgets.length > 0);

    await piCalls.commands.get("ralph-works").handler("reset", ctx);
    assert.deepEqual(ctxCalls.widgets.at(-1), {
      key: "ralph-works",
      value: [],
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ralph_works_transition reports existing pending handoffs without queuing duplicates", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
  try {
    const pendingState = createPendingSessionHandoff(
      createWorkflowStateAtPhase("red_team"),
      {
        id: "handoff-1",
        boundary: "phase",
        reason: "completed generate_spec",
        sourcePhase: "generate_spec",
        targetPhase: "red_team",
      },
    );
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir, {
      entries: [
        {
          type: "custom",
          customType: RALPH_WORKS_STATE_ENTRY_TYPE,
          data: pendingState,
        },
      ],
    });
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });
    await piCalls.events.get("session_start")({ reason: "startup" }, ctx);

    const tool = piCalls.tools.find(
      (definition) => definition.name === "ralph_works_transition",
    );
    const firstResult = await tool.execute(
      "tool-1",
      {},
      undefined,
      undefined,
      ctx,
    );
    const pendingHandoffId = firstResult.details.state.pendingHandoff.id;
    const queuedMessages = piCalls.userMessages.length;
    const appendedEntries = piCalls.appended.length;

    const secondResult = await tool.execute(
      "tool-2",
      {},
      undefined,
      undefined,
      ctx,
    );

    assert.match(secondResult.content[0].text, /handoff_pending/);
    assert.equal(
      secondResult.details.state.pendingHandoff.id,
      pendingHandoffId,
    );
    assert.equal(piCalls.userMessages.length, queuedMessages);
    assert.equal(piCalls.appended.length, appendedEntries);
    assert.equal(ctxCalls.newSessions.length, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ralph_works_transition creates a replacement session without queueing a slash command", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
  try {
    const { pi, calls: piCalls } = createFakePi();
    const { ctx } = createFakeContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });
    await startPipeline(piCalls, ctx);

    const contextMessages = [];
    ctx.sendUserMessage = async (content, options) => {
      contextMessages.push({ content, options });
      piCalls.operations.push({
        type: "ctx.sendUserMessage",
        content,
        options,
      });
    };
    const messagesBeforeTransition = piCalls.userMessages.length;

    const tool = piCalls.tools.find(
      (definition) => definition.name === "ralph_works_transition",
    );
    const result = await tool.execute("tool-1", {}, undefined, undefined, ctx);

    assert.match(result.content[0].text, /red_team/);
    assert.equal(result.details.state.currentPhase, "red_team");
    assert.equal(result.details.state.phaseStatus, "executing");
    assert.equal(piCalls.userMessages.length, messagesBeforeTransition);
    assert.equal(contextMessages.length, 1);
    assert.match(contextMessages[0].content, /# ralph-works Phase: Red Team/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("replacement session_start resumes a ready handoff and uses replacement runtime", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
  try {
    await writeFile(
      path.join(tempDir, "model.config.json"),
      JSON.stringify({
        phase_models: {
          red_team: "openai/red-team-model",
        },
      }),
    );

    const readyState = createReadyPhaseHandoffState();
    const oldRuntime = createFakePi();
    const { pi, calls: piCalls } = createFakePi();
    const { ctx } = createFakeContext(tempDir, {
      entries: [
        {
          type: "custom",
          customType: RALPH_WORKS_STATE_ENTRY_TYPE,
          data: readyState,
        },
      ],
      parentSession: "sessions/replacement.jsonl",
    });
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await piCalls.events.get("session_start")(
      { reason: "new", previousSessionFile: "old" },
      ctx,
    );

    assert.equal(latestState(piCalls).currentPhase, "red_team");
    assert.equal(latestState(piCalls).phaseStatus, "executing");
    assert.equal(latestState(piCalls).pendingHandoff, undefined);
    assert.equal(piCalls.models.at(-1).provider, "openai");
    assert.equal(piCalls.models.at(-1).id, "red-team-model");
    assert.equal(piCalls.userMessages.length, 1);
    assert.match(
      piCalls.userMessages[0].content,
      /# ralph-works Phase: Red Team/,
    );
    assert.equal(piCalls.userMessages[0].options.deliverAs, "followUp");
    assert.equal(oldRuntime.calls.models.length, 0);
    assert.equal(oldRuntime.calls.userMessages.length, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("replacement session_start sends the resumed prompt through context when available", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
  try {
    const readyState = createReadyPhaseHandoffState();
    const { pi, calls: piCalls } = createFakePi();
    const { ctx } = createFakeContext(tempDir, {
      entries: [
        {
          type: "custom",
          customType: RALPH_WORKS_STATE_ENTRY_TYPE,
          data: readyState,
        },
      ],
      parentSession: "sessions/replacement.jsonl",
    });
    const contextMessages = [];
    ctx.sendUserMessage = async (content, options) => {
      contextMessages.push({ content, options });
      piCalls.operations.push({
        type: "ctx.sendUserMessage",
        content,
        options,
      });
    };
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await piCalls.events.get("session_start")(
      { reason: "new", previousSessionFile: "old" },
      ctx,
    );

    assert.equal(piCalls.userMessages.length, 0);
    assert.equal(contextMessages.length, 1);
    assert.match(contextMessages[0].content, /# ralph-works Phase: Red Team/);
    assert.equal(contextMessages[0].options.deliverAs, "followUp");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("replacement handoff routes model before sending the replacement prompt without old runtime sends", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
  try {
    await writeFile(
      path.join(tempDir, "model.config.json"),
      JSON.stringify({
        phase_models: {
          red_team: "openai/red-team-model",
        },
      }),
    );

    const { pi: sourcePi, calls: sourceCalls } = createFakePi();
    const { pi: replacementPi, calls: replacementCalls } = createFakePi();
    const replacementEntries = [];
    const replacementSessionManager = {
      appendCustomEntry(customType, data) {
        replacementEntries.push({ type: "custom", customType, data });
      },
      appendCustomMessageEntry(customType, content, display, details) {
        replacementEntries.push({
          type: "custom_message",
          customType,
          content,
          display,
          details,
        });
      },
      getEntries() {
        return replacementEntries;
      },
      getSessionFile() {
        return "sessions/replacement.jsonl";
      },
    };
    const { ctx: replacementCtx } = createFakeContext(tempDir, {
      entries: replacementEntries,
      parentSession: "sessions/replacement.jsonl",
    });
    replacementCtx.sessionManager = replacementSessionManager;
    const replacementContextMessages = [];
    replacementCtx.sendUserMessage = async (content, options) => {
      replacementContextMessages.push({ content, options });
      replacementCalls.operations.push({
        type: "ctx.sendUserMessage",
        content,
        options,
      });
    };

    const { ctx: sourceCtx, calls: sourceCtxCalls } = createFakeContext(
      tempDir,
      {
        newSession: async (options) => {
          await options.setup(replacementSessionManager);
          registerRalphWorksExtension(replacementPi, {
            extensionRoot: path.resolve("."),
          });
          await replacementCalls.events.get("session_start")(
            { reason: "new", previousSessionFile: "sessions/source.jsonl" },
            replacementCtx,
          );
          await options.withSession(replacementCtx);
          return { cancelled: false };
        },
      },
    );
    registerRalphWorksExtension(sourcePi, { extensionRoot: path.resolve(".") });

    await startPipeline(sourceCalls, sourceCtx);
    await sourceCalls.commands.get("ralph-works").handler("next", sourceCtx);
    const sourceMessagesBeforeHandoff = sourceCalls.userMessages.length;
    const sourceOperationsBeforeHandoff = sourceCalls.operations.length;

    assert.equal(sourceCtxCalls.newSessions.length, 1);
    assert.equal(sourceCalls.userMessages.length, sourceMessagesBeforeHandoff);
    assert.deepEqual(
      sourceCalls.operations.slice(sourceOperationsBeforeHandoff),
      [],
    );
    assert.equal(replacementCalls.userMessages.length, 0);
    assert.equal(replacementCalls.models.at(-1).provider, "openai");
    assert.equal(replacementCalls.models.at(-1).id, "red-team-model");
    assert.ok(replacementContextMessages.length >= 1);
    assert.match(
      replacementContextMessages[0].content,
      /# ralph-works Phase: Red Team/,
    );
    const modelIndex = replacementCalls.operations.findIndex(
      (operation) => operation.type === "setModel",
    );
    const promptIndex = replacementCalls.operations.findIndex(
      (operation) =>
        operation.type === "ctx.sendUserMessage" &&
        /# ralph-works Phase: Red Team/.test(operation.content),
    );
    assert.ok(modelIndex >= 0, "expected replacement model routing");
    assert.ok(promptIndex > modelIndex, "expected model routing before prompt");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("resume handoff for harden approval waits without sending an agent prompt", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
  try {
    const readyState = createReadyPhaseHandoffState({
      sourcePhase: "harden_spec",
      targetPhase: "harden_spec",
      reason: "hardened spec awaiting approval",
    });
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir, {
      entries: [
        {
          type: "custom",
          customType: RALPH_WORKS_STATE_ENTRY_TYPE,
          data: readyState,
        },
      ],
      parentSession: "sessions/replacement.jsonl",
    });
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await piCalls.events.get("session_start")(
      { reason: "new", previousSessionFile: "old" },
      ctx,
    );

    assert.equal(latestState(piCalls).currentPhase, "harden_spec");
    assert.equal(latestState(piCalls).phaseStatus, "awaiting_harden_approval");
    assert.equal(latestState(piCalls).pendingHandoff, undefined);
    assert.equal(piCalls.userMessages.length, 0);
    assert.equal(piCalls.models.length, 0);
    assert.match(
      ctxCalls.notifications.at(-1).message,
      /Approve the hardened spec/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("resume handoff validates target phase before routing or prompting", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
  try {
    const mismatchedState = markSessionHandoffReadyInNewSession(
      createPendingSessionHandoff(createPhaseState({ feature: "feature-a" }), {
        id: "handoff-1",
        boundary: "phase",
        reason: "completed generate_spec",
        targetPhase: "red_team",
      }),
      "handoff-1",
      { replacementSessionFile: "sessions/replacement.jsonl" },
    );
    const { pi, calls: piCalls } = createFakePi();
    const { ctx } = createFakeContext(tempDir, {
      entries: [
        {
          type: "custom",
          customType: RALPH_WORKS_STATE_ENTRY_TYPE,
          data: mismatchedState,
        },
      ],
    });
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await piCalls.events.get("session_start")(
      { reason: "new", previousSessionFile: "old" },
      ctx,
    );
    piCalls.userMessages.length = 0;

    await piCalls.commands
      .get("ralph-works")
      .handler("resume-handoff handoff-1", ctx);

    assert.equal(latestState(piCalls).phaseStatus, "handoff_failed");
    assert.equal(latestState(piCalls).pipelineStatus, "blocked");
    assert.match(
      latestState(piCalls).pendingHandoff.errorMessage,
      /target phase/i,
    );
    assert.equal(piCalls.models.length, 0);
    assert.equal(piCalls.userMessages.length, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("/ralph-works start launches the first phase with skill and artifact context", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
  try {
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await startPipeline(piCalls, ctx, "start feature-a Build feature A");

    const state = latestState(piCalls);
    assert.equal(state.pipelineStatus, "running");
    assert.equal(state.phaseStatus, "executing");
    assert.equal(state.feature, "feature-a");
    assert.equal(state.promptText, "Build feature A");
    assert.equal(state.currentPhase, "generate_spec");
    assert.equal(ctxCalls.widgets.length, 1);
    assert.equal(piCalls.userMessages.length, 1);
    assert.match(
      String(piCalls.userMessages[0].content),
      /# ralph-works Phase: Generate Spec/,
    );
    assert.match(
      String(piCalls.userMessages[0].content),
      /<ralph-skill-instructions>/,
    );
    assert.match(
      String(piCalls.userMessages[0].content),
      /docs\/feature-a-generated-spec\.md/,
    );
    assert.match(
      String(piCalls.userMessages[0].content),
      /RALPH_PHASE_COMPLETE/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("phase completion creates a replacement session before launching the replacement prompt", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
  try {
    const { pi, calls: piCalls } = createFakePi();
    const sourceState = createWorkflowStateAtPhase("generate_spec");
    const { sourceCtx, sourceCalls } = createHandoffContexts(
      tempDir,
      sourceState,
    );
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await piCalls.events.get("session_start")({ reason: "startup" }, sourceCtx);
    await finishAssistantTurn(
      piCalls,
      sourceCtx,
      "Spec complete.\nRALPH_PHASE_COMPLETE",
    );

    assert.equal(latestState(piCalls).currentPhase, "red_team");
    assert.equal(latestState(piCalls).phaseStatus, "executing");
    assert.equal(sourceCalls.newSessions.length, 1);
    assert.equal(
      latestState(piCalls).sessionHandoffEvents.at(-1).boundary,
      "phase",
    );
    assert.equal(
      latestState(piCalls).sessionHandoffEvents.at(-1).sourcePhase,
      "generate_spec",
    );
    assert.equal(
      latestState(piCalls).sessionHandoffEvents.at(-1).targetPhase,
      "red_team",
    );
    assert.equal(latestState(piCalls).currentPhase, "red_team");
    assert.equal(latestState(piCalls).pendingHandoff, undefined);
    assert.match(
      String(piCalls.userMessages.at(-1).content),
      /# ralph-works Phase: Red Team Pass/,
    );
    assert.match(
      String(piCalls.userMessages.at(-1).content),
      /docs\/feature-a-generated-spec\.md/,
    );
    assert.match(
      String(piCalls.userMessages.at(-1).content),
      /docs\/feature-a-red-team-findings\.md/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("duplicate phase marker is ignored while a handoff is pending", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
  try {
    const pendingState = createPendingSessionHandoff(
      createWorkflowStateAtPhase("red_team"),
      {
        id: "handoff-1",
        boundary: "phase",
        reason: "completed generate_spec",
        sourcePhase: "generate_spec",
        targetPhase: "red_team",
      },
    );
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir, {
      entries: [
        {
          type: "custom",
          customType: RALPH_WORKS_STATE_ENTRY_TYPE,
          data: pendingState,
        },
      ],
    });
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await piCalls.events.get("session_start")({ reason: "startup" }, ctx);
    const queuedMessages = piCalls.userMessages.length;
    const appendedEntries = piCalls.appended.length;

    await finishAssistantTurn(
      piCalls,
      ctx,
      "Spec complete again.\nRALPH_PHASE_COMPLETE",
    );

    assert.equal(piCalls.userMessages.length, queuedMessages);
    assert.equal(piCalls.appended.length, appendedEntries);
    assert.equal(ctxCalls.newSessions.length, 0);
    assert.match(ctxCalls.notifications.at(-1).message, /handoff/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("non-review phase markers hand off through fresh sessions for each target phase", async () => {
  const cases = [
    {
      sourcePhase: "generate_spec",
      targetPhase: "red_team",
      prompt: /# ralph-works Phase: Red Team Pass/,
      artifact: /docs\/feature-a-red-team-findings\.md/,
    },
    {
      sourcePhase: "red_team",
      targetPhase: "harden_spec",
      prompt: /# ralph-works Phase: Harden Spec/,
      artifact: /docs\/feature-a-hardened-spec\.md/,
    },
    {
      sourcePhase: "render_html_optional",
      targetPhase: "create_tasks",
      prompt: /# ralph-works Phase: Task Creation/,
      artifact: /docs\/feature-a-task-list\.md/,
    },
    {
      sourcePhase: "create_tasks",
      targetPhase: "tdd_implement",
      prompt: /# ralph-works Phase: Red-Green TDD Implement/,
      artifact: /docs\/feature-a-implementation-status\.json/,
    },
  ];

  for (const testCase of cases) {
    const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
    try {
      const { pi, calls: piCalls } = createFakePi();
      const sourceState = createWorkflowStateAtPhase(testCase.sourcePhase);
      const { sourceCtx, sourceCalls } = createHandoffContexts(
        tempDir,
        sourceState,
      );
      registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

      await piCalls.events.get("session_start")(
        { reason: "startup" },
        sourceCtx,
      );
      await finishAssistantTurn(
        piCalls,
        sourceCtx,
        `${testCase.sourcePhase} complete.\nRALPH_PHASE_COMPLETE`,
      );

      const pendingState = latestState(piCalls);
      assert.equal(pendingState.currentPhase, testCase.targetPhase);
      assert.equal(pendingState.phaseStatus, "executing");
      assert.equal(pendingState.sessionHandoffEvents.at(-1).boundary, "phase");
      assert.equal(
        pendingState.sessionHandoffEvents.at(-1).sourcePhase,
        testCase.sourcePhase,
      );
      assert.equal(
        pendingState.sessionHandoffEvents.at(-1).targetPhase,
        testCase.targetPhase,
      );
      assert.equal(sourceCalls.newSessions.length, 1);
      assert.equal(latestState(piCalls).currentPhase, testCase.targetPhase);
      assert.equal(latestState(piCalls).phaseStatus, "executing");
      assert.match(
        String(piCalls.userMessages.at(-1).content),
        testCase.prompt,
      );
      assert.match(
        String(piCalls.userMessages.at(-1).content),
        testCase.artifact,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
});

test("harden spec completion hands off to a fresh approval session", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
  try {
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await startPipeline(piCalls, ctx);
    await finishAssistantTurn(
      piCalls,
      ctx,
      "Spec complete.\nRALPH_PHASE_COMPLETE",
    );
    await completeLatestHandoff(ctxCalls, piCalls, ctx);
    await finishAssistantTurn(
      piCalls,
      ctx,
      "Red team complete.\nRALPH_PHASE_COMPLETE",
    );
    await completeLatestHandoff(ctxCalls, piCalls, ctx);
    const messagesBeforeHardenCompletion = piCalls.userMessages.length;
    const newSessionsBeforeHardenCompletion = ctxCalls.newSessions.length;
    await finishAssistantTurn(
      piCalls,
      ctx,
      "Hardened spec complete.\nRALPH_PHASE_COMPLETE",
    );

    assert.equal(latestState(piCalls).currentPhase, "harden_spec");
    assert.equal(latestState(piCalls).phaseStatus, "awaiting_harden_approval");
    assert.equal(latestState(piCalls).pendingHandoff, undefined);
    assert.equal(piCalls.userMessages.length, messagesBeforeHardenCompletion);
    assert.equal(
      ctxCalls.newSessions.length,
      newSessionsBeforeHardenCompletion + 1,
    );
    assert.match(
      ctxCalls.notifications.at(-1).message,
      /Approve the hardened spec/,
    );
    assert.match(
      ctxCalls.notifications.at(-1).message,
      /approve --render-html/,
    );
    await piCalls.commands.get("ralph-works").handler("approve", ctx);

    assert.equal(latestState(piCalls).currentPhase, "create_tasks");
    assert.equal(latestState(piCalls).phaseStatus, "executing");
    assert.equal(latestState(piCalls).pendingHandoff, undefined);
    assert.equal(
      latestState(piCalls).sessionHandoffEvents.at(-1).sourcePhase,
      "harden_spec",
    );
    assert.equal(
      latestState(piCalls).sessionHandoffEvents.at(-1).targetPhase,
      "create_tasks",
    );
    assert.match(
      String(piCalls.userMessages.at(-1).content),
      /# ralph-works Phase: Task Creation/,
    );
    assert.match(
      String(piCalls.userMessages.at(-1).content),
      /docs\/feature-a-hardened-spec\.md/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ralph-works approve is the only command that advances from harden spec", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
  try {
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await advanceToHardenSpecWithNext(piCalls, ctx);
    await piCalls.commands.get("ralph-works").handler("next", ctx);
    await completeLatestHandoff(ctxCalls, piCalls, ctx);
    assert.equal(latestState(piCalls).phaseStatus, "awaiting_harden_approval");
    const messagesBeforeApprove = piCalls.userMessages.length;

    await piCalls.commands.get("ralph-works").handler("approve", ctx);

    assert.equal(latestState(piCalls).currentPhase, "create_tasks");
    assert.equal(latestState(piCalls).phaseStatus, "executing");
    assert.equal(piCalls.userMessages.length, messagesBeforeApprove + 1);
    assert.match(
      String(piCalls.userMessages.at(-1).content),
      /# ralph-works Phase: Task Creation/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ralph-works approve can enter optional HTML render before task creation", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
  try {
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await startPipeline(piCalls, ctx);
    await finishAssistantTurn(
      piCalls,
      ctx,
      "Spec complete.\nRALPH_PHASE_COMPLETE",
    );
    await completeLatestHandoff(ctxCalls, piCalls, ctx);
    await finishAssistantTurn(
      piCalls,
      ctx,
      "Red team complete.\nRALPH_PHASE_COMPLETE",
    );
    await completeLatestHandoff(ctxCalls, piCalls, ctx);
    await finishAssistantTurn(
      piCalls,
      ctx,
      "Hardened spec complete.\nRALPH_PHASE_COMPLETE",
    );
    await completeLatestHandoff(ctxCalls, piCalls, ctx);
    assert.equal(latestState(piCalls).phaseStatus, "awaiting_harden_approval");

    const messagesBeforeApprove = piCalls.userMessages.length;

    await piCalls.commands
      .get("ralph-works")
      .handler("approve --render-html", ctx);

    assert.equal(latestState(piCalls).currentPhase, "render_html_optional");
    assert.equal(latestState(piCalls).phaseStatus, "executing");
    assert.equal(latestState(piCalls).pendingHandoff, undefined);
    assert.equal(piCalls.userMessages.length, messagesBeforeApprove + 1);
    assert.match(
      String(piCalls.userMessages.at(-1).content),
      /# ralph-works Phase: Optional HTML Render/,
    );
    assert.match(
      String(piCalls.userMessages.at(-1).content),
      /docs\/feature-a-hardened-spec\.html/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ralph-works next from harden spec pauses for explicit approval", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
  try {
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await advanceToHardenSpecWithNext(piCalls, ctx);
    const messagesBeforeNext = piCalls.userMessages.length;

    await piCalls.commands.get("ralph-works").handler("next", ctx);

    assert.equal(latestState(piCalls).currentPhase, "harden_spec");
    assert.equal(latestState(piCalls).phaseStatus, "awaiting_harden_approval");
    assert.equal(piCalls.userMessages.length, messagesBeforeNext);
    assert.match(
      ctxCalls.notifications.at(-1).message,
      /Approve the hardened spec/,
    );
    assert.match(
      ctxCalls.notifications.at(-1).message,
      /approve --render-html/,
    );

    const messagesBeforeSecondNext = piCalls.userMessages.length;
    await piCalls.commands.get("ralph-works").handler("next", ctx);

    assert.equal(latestState(piCalls).currentPhase, "harden_spec");
    assert.equal(latestState(piCalls).phaseStatus, "awaiting_harden_approval");
    assert.equal(piCalls.userMessages.length, messagesBeforeSecondNext);
    assert.match(ctxCalls.notifications.at(-1).message, /approve/i);
    assert.match(
      ctxCalls.notifications.at(-1).message,
      /approve --render-html/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ralph_works_transition from harden spec requests approval-session handoff", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
  try {
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await advanceToHardenSpecWithNext(piCalls, ctx);
    const messagesBeforeTransition = piCalls.userMessages.length;
    const newSessionsBeforeTransition = ctxCalls.newSessions.length;
    const tool = piCalls.tools.find(
      (definition) => definition.name === "ralph_works_transition",
    );

    const result = await tool.execute("tool-1", {}, undefined, undefined, ctx);

    assert.equal(result.details.state.currentPhase, "harden_spec");
    assert.equal(result.details.state.phaseStatus, "awaiting_harden_approval");
    assert.equal(result.details.state.pendingHandoff, undefined);
    assert.equal(latestState(piCalls).currentPhase, "harden_spec");
    assert.equal(piCalls.userMessages.length, messagesBeforeTransition);
    assert.equal(ctxCalls.newSessions.length, newSessionsBeforeTransition + 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("TDD and review automatically loop until review is LGTM", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
  try {
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await startPipeline(piCalls, ctx);
    await finishAssistantTurn(
      piCalls,
      ctx,
      "Spec complete.\nRALPH_PHASE_COMPLETE",
    );
    await completeLatestHandoff(ctxCalls, piCalls, ctx);
    await finishAssistantTurn(
      piCalls,
      ctx,
      "Red team complete.\nRALPH_PHASE_COMPLETE",
    );
    await completeLatestHandoff(ctxCalls, piCalls, ctx);
    await finishAssistantTurn(
      piCalls,
      ctx,
      "Hardened spec complete.\nRALPH_PHASE_COMPLETE",
    );
    await completeLatestHandoff(ctxCalls, piCalls, ctx);
    await piCalls.commands.get("ralph-works").handler("approve", ctx);
    await completeLatestHandoff(ctxCalls, piCalls, ctx);
    await finishAssistantTurn(
      piCalls,
      ctx,
      "Tasks complete.\nRALPH_PHASE_COMPLETE",
    );
    await completeLatestHandoff(ctxCalls, piCalls, ctx);
    assert.equal(latestState(piCalls).currentPhase, "tdd_implement");
    await writeFeatureTaskList(tempDir, "- [x] T001 P0 Build phase state\n");

    await finishAssistantTurn(
      piCalls,
      ctx,
      "Implementation complete.\nRALPH_PHASE_COMPLETE",
    );
    await completeLatestHandoff(ctxCalls, piCalls, ctx);
    assert.equal(latestState(piCalls).currentPhase, "review");
    assert.match(
      String(piCalls.userMessages.at(-1).content),
      /# ralph-works Phase: Review/,
    );

    await finishAssistantTurn(
      piCalls,
      ctx,
      "[CRITICAL] Missing regression test.",
    );
    await completeLatestHandoff(ctxCalls, piCalls, ctx);
    assert.equal(latestState(piCalls).currentPhase, "tdd_implement");
    assert.equal(latestState(piCalls).loopbackCount, 1);
    assert.match(
      String(piCalls.userMessages.at(-1).content),
      /Review requested changes/,
    );
    assert.match(
      String(piCalls.userMessages.at(-1).content),
      /# ralph-works Phase: Red-Green TDD Implement/,
    );

    await finishAssistantTurn(piCalls, ctx, "Fixed.\nRALPH_PHASE_COMPLETE");
    await completeLatestHandoff(ctxCalls, piCalls, ctx);
    assert.equal(latestState(piCalls).currentPhase, "review");
    await finishAssistantTurn(piCalls, ctx, "LGTM. No critical bugs found.");

    assert.equal(latestState(piCalls).currentPhase, "complete");
    assert.equal(latestState(piCalls).pipelineStatus, "completed");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("end-to-end lifecycle restores replacement state across fresh sessions through review completion", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
  try {
    const harness = createLifecycleHarness(tempDir);
    let runtime = harness.activeRuntime;

    await startPipeline(
      runtime.piCalls,
      runtime.ctx,
      "start feature-a Build feature A",
    );
    assert.equal(latestState(runtime.piCalls).currentPhase, "generate_spec");
    assert.equal(
      Object.hasOwn(latestState(runtime.piCalls), "compactionEvents"),
      false,
    );

    await finishAssistantTurn(
      runtime.piCalls,
      runtime.ctx,
      "Spec complete.\nRALPH_PHASE_COMPLETE",
    );
    runtime = await runActiveLifecycleHandoff(harness);
    assert.equal(latestState(runtime.piCalls).currentPhase, "red_team");
    assert.equal(latestState(runtime.piCalls).phaseStatus, "executing");
    assert.match(
      String(runtime.piCalls.userMessages.at(-1).content),
      /# ralph-works Phase: Red Team Pass/,
    );
    assert.equal(latestState(runtime.piCalls).sessionHandoffEvents.length, 1);

    await finishAssistantTurn(
      runtime.piCalls,
      runtime.ctx,
      "Red team complete.\nRALPH_PHASE_COMPLETE",
    );
    runtime = await runActiveLifecycleHandoff(harness);
    assert.match(
      String(runtime.piCalls.userMessages.at(-1).content),
      /# ralph-works Phase: Harden Spec/,
    );
    assert.equal(latestState(runtime.piCalls).sessionHandoffEvents.length, 2);

    await finishAssistantTurn(
      runtime.piCalls,
      runtime.ctx,
      "Hardened spec complete.\nRALPH_PHASE_COMPLETE",
    );
    runtime = await runActiveLifecycleHandoff(harness);
    assert.equal(latestState(runtime.piCalls).currentPhase, "harden_spec");
    assert.equal(
      latestState(runtime.piCalls).phaseStatus,
      "awaiting_harden_approval",
    );
    await runtime.piCalls.commands
      .get("ralph-works")
      .handler("approve", runtime.ctx);
    runtime = await runActiveLifecycleHandoff(harness);
    assert.match(
      String(runtime.piCalls.userMessages.at(-1).content),
      /# ralph-works Phase: Task Creation/,
    );

    await finishAssistantTurn(
      runtime.piCalls,
      runtime.ctx,
      "Tasks complete.\nRALPH_PHASE_COMPLETE",
    );
    runtime = await runActiveLifecycleHandoff(harness);
    assert.match(
      String(runtime.piCalls.userMessages.at(-1).content),
      /# ralph-works Phase: Red-Green TDD Implement/,
    );

    await writeFeatureTaskList(tempDir, "- [ ] T001 P0 Build phase state\n");
    await finishAssistantTurn(
      runtime.piCalls,
      runtime.ctx,
      "T001 done.\nRALPH_TDD_TASK_COMPLETE T001",
    );
    runtime = await runActiveLifecycleHandoff(harness);
    assert.equal(latestState(runtime.piCalls).currentPhase, "tdd_implement");
    assert.equal(latestState(runtime.piCalls).phaseStatus, "executing");
    assert.equal(
      latestState(runtime.piCalls).sessionHandoffEvents.at(-1).boundary,
      "task",
    );
    assert.match(
      String(runtime.piCalls.userMessages.at(-1).content),
      /# ralph-works Phase: Red-Green TDD Implement/,
    );

    await finishAssistantTurn(
      runtime.piCalls,
      runtime.ctx,
      "Implementation complete.\nRALPH_PHASE_COMPLETE",
    );
    runtime = await runActiveLifecycleHandoff(harness);
    assert.equal(latestState(runtime.piCalls).currentPhase, "review");
    assert.equal(latestState(runtime.piCalls).phaseStatus, "executing");
    assert.equal(
      latestState(runtime.piCalls).sessionHandoffEvents.at(-1).boundary,
      "phase",
    );
    assert.match(
      String(runtime.piCalls.userMessages.at(-1).content),
      /# ralph-works Phase: Review/,
    );

    const newSessionsBeforeLgtm = runtime.ctxCalls.newSessions.length;
    await finishAssistantTurn(runtime.piCalls, runtime.ctx, "LGTM");

    const completedState = latestState(runtime.piCalls);
    assert.equal(completedState.currentPhase, "complete");
    assert.equal(completedState.pipelineStatus, "completed");
    assert.equal(runtime.ctxCalls.newSessions.length, newSessionsBeforeLgtm);
    assert.deepEqual(
      completedState.sessionHandoffEvents.map((event) => event.boundary),
      ["phase", "phase", "approval", "approval", "phase", "task", "phase"],
    );
    assert.equal(harness.runtimes.length, 8);
    assert.equal(
      harness.runtimes
        .slice(0, -1)
        .every((entry) => entry.ctxCalls.newSessions.length === 1),
      true,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("replacement prompt dispatch failure marks the handoff failed instead of silently proceeding", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
  try {
    const readyState = createReadyPhaseHandoffState();
    const replacementContextMessages = [];
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir, {
      entries: [
        {
          type: "custom",
          customType: RALPH_WORKS_STATE_ENTRY_TYPE,
          data: readyState,
        },
      ],
      parentSession: "sessions/replacement.jsonl",
    });
    ctx.sendUserMessage = async (content, options) => {
      replacementContextMessages.push({ content, options });
      if (String(content).includes("# ralph-works Phase:")) {
        throw new Error("prompt dispatch exploded");
      }
    };
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await piCalls.events.get("session_start")(
      { reason: "new", previousSessionFile: "old" },
      ctx,
    );
    assert.equal(piCalls.userMessages.length, 0);
    assert.equal(replacementContextMessages.length, 1);

    const failedState = latestState(piCalls);
    assert.equal(failedState.currentPhase, "red_team");
    assert.equal(failedState.phaseStatus, "handoff_failed");
    assert.equal(failedState.pipelineStatus, "blocked");
    assert.equal(failedState.pendingHandoff.status, "failed");
    assert.match(
      failedState.pendingHandoff.errorMessage,
      /prompt dispatch exploded/,
    );
    assert.equal(failedState.sessionHandoffEvents.length, 0);
    assert.equal(piCalls.models.length, 0);
    assert.equal(piCalls.userMessages.length, 0);
    assert.equal(replacementContextMessages.length, 1);
    assert.match(
      replacementContextMessages[0].content,
      /# ralph-works Phase: Red Team/,
    );
    assert.match(
      ctxCalls.notifications.at(-1).message,
      /prompt dispatch exploded/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("review LGTM completes in the current session without handoff", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
  try {
    const reviewState = createWorkflowStateAtPhase("review");
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir, {
      entries: [
        {
          type: "custom",
          customType: RALPH_WORKS_STATE_ENTRY_TYPE,
          data: reviewState,
        },
      ],
    });
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });
    await piCalls.events.get("session_start")({ reason: "startup" }, ctx);

    const messagesBefore = piCalls.userMessages.length;
    const newSessionsBefore = ctxCalls.newSessions.length;

    await finishAssistantTurn(piCalls, ctx, "LGTM");

    assert.equal(latestState(piCalls).currentPhase, "complete");
    assert.equal(latestState(piCalls).pipelineStatus, "completed");
    assert.equal(piCalls.userMessages.length, messagesBefore);
    assert.equal(ctxCalls.newSessions.length, newSessionsBefore);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("review changes requested hands off to TDD with loopback context", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
  try {
    const reviewState = createWorkflowStateAtPhase("review");
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir, {
      entries: [
        {
          type: "custom",
          customType: RALPH_WORKS_STATE_ENTRY_TYPE,
          data: reviewState,
        },
      ],
    });
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });
    await piCalls.events.get("session_start")({ reason: "startup" }, ctx);

    const newSessionsBefore = ctxCalls.newSessions.length;

    await finishAssistantTurn(
      piCalls,
      ctx,
      "[CRITICAL] Missing regression test.",
    );

    assert.equal(latestState(piCalls).currentPhase, "tdd_implement");
    assert.equal(latestState(piCalls).phaseStatus, "executing");
    assert.equal(latestState(piCalls).loopbackCount, 1);
    assert.equal(
      latestState(piCalls).sessionHandoffEvents.at(-1).boundary,
      "review_loopback",
    );
    assert.equal(
      latestState(piCalls).sessionHandoffEvents.at(-1).targetPhase,
      "tdd_implement",
    );
    assert.equal(ctxCalls.newSessions.length, newSessionsBefore + 1);
    assert.match(
      String(piCalls.userMessages.at(-1).content),
      /# ralph-works Phase: Red-Green TDD Implement/,
    );
    assert.match(
      String(piCalls.userMessages.at(-1).content),
      /Review Loopback Context/,
    );
    assert.match(
      String(piCalls.userMessages.at(-1).content),
      /review requested changes/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("review loopback ignores duplicate findings while handoff is pending", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
  try {
    const reviewState = createPendingSessionHandoff(
      transitionToPhase(createWorkflowStateAtPhase("review"), "tdd_implement", {
        reason: "review requested changes",
      }),
      {
        id: "handoff-1",
        boundary: "review_loopback",
        reason: "review requested changes",
        sourcePhase: "review",
        targetPhase: "tdd_implement",
      },
    );
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir, {
      entries: [
        {
          type: "custom",
          customType: RALPH_WORKS_STATE_ENTRY_TYPE,
          data: reviewState,
        },
      ],
    });
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });
    await piCalls.events.get("session_start")({ reason: "startup" }, ctx);

    const queuedMessages = piCalls.userMessages.length;

    await finishAssistantTurn(piCalls, ctx, "RALPH_REVIEW_CHANGES_REQUESTED");

    assert.equal(piCalls.userMessages.length, queuedMessages);
    assert.equal(ctxCalls.newSessions.length, 0);
    assert.match(ctxCalls.notifications.at(-1).message, /handoff/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("review completion requires LGTM instead of the generic phase marker", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
  try {
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await startPipeline(piCalls, ctx);
    await finishAssistantTurn(
      piCalls,
      ctx,
      "Spec complete.\nRALPH_PHASE_COMPLETE",
    );
    await completeLatestHandoff(ctxCalls, piCalls, ctx);
    await finishAssistantTurn(
      piCalls,
      ctx,
      "Red team complete.\nRALPH_PHASE_COMPLETE",
    );
    await completeLatestHandoff(ctxCalls, piCalls, ctx);
    await finishAssistantTurn(
      piCalls,
      ctx,
      "Hardened spec complete.\nRALPH_PHASE_COMPLETE",
    );
    await completeLatestHandoff(ctxCalls, piCalls, ctx);
    await piCalls.commands.get("ralph-works").handler("approve", ctx);
    await completeLatestHandoff(ctxCalls, piCalls, ctx);
    await finishAssistantTurn(
      piCalls,
      ctx,
      "Tasks complete.\nRALPH_PHASE_COMPLETE",
    );
    await completeLatestHandoff(ctxCalls, piCalls, ctx);
    await writeFeatureTaskList(tempDir, "- [x] T001 P0 Build phase state\n");
    await finishAssistantTurn(
      piCalls,
      ctx,
      "Implementation complete.\nRALPH_PHASE_COMPLETE",
    );
    await completeLatestHandoff(ctxCalls, piCalls, ctx);

    await finishAssistantTurn(
      piCalls,
      ctx,
      "looks good to me\nRALPH_PHASE_COMPLETE",
    );

    assert.equal(latestState(piCalls).currentPhase, "review");
    assert.equal(latestState(piCalls).pipelineStatus, "running");
    assert.match(ctxCalls.notifications.at(-1).message, /LGTM/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ralph-works next creates a fresh session and routes the replacement model", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
  try {
    await writeFile(
      path.join(tempDir, "model.config.json"),
      JSON.stringify({
        default_model: "anthropic/default",
        phase_models: {
          red_team: "openai/red-team-model",
        },
      }),
    );

    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await startPipeline(piCalls, ctx);
    await piCalls.commands.get("ralph-works").handler("next", ctx);

    assert.equal(piCalls.appended.at(-1).customType, "ralph-works-state");
    assert.equal(piCalls.appended.at(-1).data.currentPhase, "red_team");
    assert.equal(piCalls.appended.at(-1).data.phaseStatus, "executing");
    assert.equal(ctxCalls.newSessions.length, 1);
    assert.equal(piCalls.models.at(-1).provider, "openai");
    assert.equal(piCalls.models.at(-1).id, "red-team-model");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ralph_works_transition tool creates a fresh session for phase handoff", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
  try {
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });
    await startPipeline(piCalls, ctx);

    const tool = piCalls.tools.find(
      (definition) => definition.name === "ralph_works_transition",
    );
    const result = await tool.execute("tool-1", {}, undefined, undefined, ctx);

    assert.equal(result.details.state.currentPhase, "red_team");
    assert.equal(result.details.state.phaseStatus, "executing");
    assert.equal(piCalls.appended.at(-1).data.currentPhase, "red_team");
    assert.equal(piCalls.appended.at(-1).data.phaseStatus, "executing");
    assert.equal(ctxCalls.newSessions.length, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ralph-works loopback routes the TDD model", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
  try {
    await writeFile(
      path.join(tempDir, "model.config.json"),
      JSON.stringify({
        phase_models: {
          tdd_implement: "openai/tdd-model",
        },
      }),
    );

    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await advanceToReviewWithApproval(piCalls, ctx);
    const modelSelectionsBeforeLoopback = piCalls.models.length;
    const newSessionsBeforeLoopback = ctxCalls.newSessions.length;
    await piCalls.commands
      .get("ralph-works")
      .handler("loopback critical bugs", ctx);

    assert.equal(latestState(piCalls).currentPhase, "tdd_implement");
    assert.equal(latestState(piCalls).phaseStatus, "executing");
    assert.equal(
      latestState(piCalls).sessionHandoffEvents.at(-1).boundary,
      "review_loopback",
    );
    assert.equal(ctxCalls.newSessions.length, newSessionsBeforeLoopback + 1);
    assert.equal(piCalls.models.length, modelSelectionsBeforeLoopback + 1);
    assert.equal(piCalls.models.at(-1).provider, "openai");
    assert.equal(piCalls.models.at(-1).id, "tdd-model");
    assert.equal(piCalls.appended.at(-1).data.currentPhase, "tdd_implement");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ralph-works tdd-complete records task completion without parsing the task list", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
  try {
    await writeFile(
      path.join(tempDir, "gate.config.json"),
      JSON.stringify({
        gates: [{ name: "unit_tests", command: "npm test", required: true }],
        run_after_phase: ["tdd_implement"],
        fail_behavior: "block_transition",
      }),
    );
    await mkdir(path.join(tempDir, "docs"));
    await writeFile(
      path.join(tempDir, "docs/feature-a-task-list.md"),
      [
        "### T001 [ ] Build phase state",
        "### T002 [ ] Render task progress",
      ].join("\n"),
    );

    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await advanceToTddWithApproval(piCalls, ctx);
    const newSessionsBefore = ctxCalls.newSessions.length;
    const userMessagesBefore = piCalls.userMessages.length;

    await piCalls.commands.get("ralph-works").handler("tdd-complete T001", ctx);

    assert.equal(latestState(piCalls).currentPhase, "tdd_implement");
    assert.equal(latestState(piCalls).phaseStatus, "executing");
    assert.equal(
      latestState(piCalls).sessionHandoffEvents.at(-1).boundary,
      "task",
    );
    assert.equal(
      latestState(piCalls).sessionHandoffEvents.at(-1).taskId,
      "T001",
    );
    assert.equal(
      latestState(piCalls).sessionHandoffEvents.at(-1).targetPhase,
      "tdd_implement",
    );
    assert.equal(latestState(piCalls).tddCompletedTasks, 1);
    assert.equal(
      latestState(piCalls).implementationStatus.completedTaskIds[0],
      "T001",
    );
    assert.equal(ctxCalls.newSessions.length, newSessionsBefore + 1);
    assert.equal(piCalls.userMessages.length, userMessagesBefore + 1);
    assert.match(ctxCalls.widgets.at(-1).value.join("\n"), /unit_tests/);
    assert.match(
      String(piCalls.userMessages.at(-1).content),
      /# ralph-works Phase: Red-Green TDD Implement/,
    );
    assert.match(
      String(piCalls.userMessages.at(-1).content),
      /Prior Task Creation: docs\/feature-a-task-list\.md/,
    );
    assert.match(
      String(piCalls.userMessages.at(-1).content),
      /Current output: docs\/feature-a-implementation-status\.json/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ralph-works tdd-complete blocks task completion when required gates fail", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
  try {
    await writeFile(
      path.join(tempDir, "gate.config.json"),
      JSON.stringify({
        gates: [{ name: "unit_tests", command: "npm test", required: true }],
        run_after_phase: ["tdd_implement"],
        fail_behavior: "block_transition",
      }),
    );
    await mkdir(path.join(tempDir, "docs"));
    await writeFile(
      path.join(tempDir, "docs/feature-a-task-list.md"),
      "- [ ] T001 P0 Build phase state\n",
    );

    const { pi, calls: piCalls } = createFakePi({
      exec: async () => ({ code: 1, stdout: "", stderr: "failed" }),
    });
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await advanceToTddWithApproval(piCalls, ctx);
    const newSessionsBefore = ctxCalls.newSessions.length;
    const userMessagesBefore = piCalls.userMessages.length;

    await piCalls.commands.get("ralph-works").handler("tdd-complete T001", ctx);

    assert.equal(latestState(piCalls).currentPhase, "tdd_implement");
    assert.equal(latestState(piCalls).tddCompletedTasks, 0);
    assert.equal(latestState(piCalls).pendingHandoff, undefined);
    assert.equal(ctxCalls.newSessions.length, newSessionsBefore);
    assert.equal(piCalls.userMessages.length, userMessagesBefore);
    assert.match(ctxCalls.notifications.at(-1).message, /gates failed/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ralph-works tdd-complete does not require a task list artifact to be present", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
  try {
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await advanceToTddWithApproval(piCalls, ctx);
    const newSessionsBefore = ctxCalls.newSessions.length;
    const userMessagesBefore = piCalls.userMessages.length;

    await piCalls.commands.get("ralph-works").handler("tdd-complete T001", ctx);

    assert.equal(latestState(piCalls).currentPhase, "tdd_implement");
    assert.equal(latestState(piCalls).tddCompletedTasks, 1);
    assert.equal(latestState(piCalls).pendingHandoff, undefined);
    assert.equal(ctxCalls.newSessions.length, newSessionsBefore + 1);
    assert.equal(piCalls.userMessages.length, userMessagesBefore + 1);
    assert.deepEqual(
      latestState(piCalls).implementationStatus.completedTaskIds,
      ["T001"],
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("TDD task marker runs gates, records completion, and hands off to the next TDD task", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
  try {
    await writeFile(
      path.join(tempDir, "gate.config.json"),
      JSON.stringify({
        gates: [{ name: "unit_tests", command: "npm test", required: true }],
        run_after_phase: ["tdd_implement"],
        fail_behavior: "block_transition",
      }),
    );
    await mkdir(path.join(tempDir, "docs"));
    await writeFile(
      path.join(tempDir, "docs/feature-a-task-list.md"),
      [
        "### T001 [ ] Build phase state",
        "### T002 [ ] Render task progress",
      ].join("\n"),
    );

    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await advanceToTddWithApproval(piCalls, ctx);
    const newSessionsBefore = ctxCalls.newSessions.length;
    const userMessagesBeforeMarker = piCalls.userMessages.length;

    await finishAssistantTurn(
      piCalls,
      ctx,
      "T001 done.\nRALPH_TDD_TASK_COMPLETE T001",
    );

    assert.equal(latestState(piCalls).currentPhase, "tdd_implement");
    assert.equal(latestState(piCalls).phaseStatus, "executing");
    assert.equal(
      latestState(piCalls).sessionHandoffEvents.at(-1).boundary,
      "task",
    );
    assert.equal(
      latestState(piCalls).sessionHandoffEvents.at(-1).taskId,
      "T001",
    );
    assert.equal(latestState(piCalls).tddCompletedTasks, 1);
    assert.equal(
      latestState(piCalls).implementationStatus.completedTaskIds[0],
      "T001",
    );
    assert.equal(ctxCalls.newSessions.length, newSessionsBefore + 1);
    assert.equal(piCalls.userMessages.length, userMessagesBeforeMarker + 1);
    assert.match(ctxCalls.widgets.at(-1).value.join("\n"), /unit_tests/);
    assert.match(
      String(piCalls.userMessages.at(-1).content),
      /# ralph-works Phase: Red-Green TDD Implement/,
    );
    assert.match(
      String(piCalls.userMessages.at(-1).content),
      /RALPH_TDD_TASK_COMPLETE <task-id>/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("TDD task marker ignores duplicate completion after task handoff completes", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
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

    await advanceToTddWithApproval(piCalls, ctx);
    await finishAssistantTurn(
      piCalls,
      ctx,
      "T001 done.\nRALPH_TDD_TASK_COMPLETE T001",
    );
    const userMessagesAfterFirstMarker = piCalls.userMessages.length;
    const newSessionsAfterFirstMarker = ctxCalls.newSessions.length;

    await finishAssistantTurn(
      piCalls,
      ctx,
      "T001 duplicated.\nRALPH_TDD_TASK_COMPLETE T001",
    );

    assert.equal(latestState(piCalls).currentPhase, "tdd_implement");
    assert.equal(latestState(piCalls).phaseStatus, "executing");
    assert.equal(latestState(piCalls).tddCompletedTasks, 1);
    assert.deepEqual(
      latestState(piCalls).implementationStatus.completedTaskIds,
      ["T001"],
    );
    assert.equal(piCalls.userMessages.length, userMessagesAfterFirstMarker);
    assert.equal(ctxCalls.newSessions.length, newSessionsAfterFirstMarker);
    assert.match(ctxCalls.notifications.at(-1).message, /already completed/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("TDD task marker blocks completion when required gates fail", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
  try {
    await writeFile(
      path.join(tempDir, "gate.config.json"),
      JSON.stringify({
        gates: [{ name: "unit_tests", command: "npm test", required: true }],
        run_after_phase: ["tdd_implement"],
        fail_behavior: "block_transition",
      }),
    );
    await mkdir(path.join(tempDir, "docs"));
    await writeFile(
      path.join(tempDir, "docs/feature-a-task-list.md"),
      "- [ ] T001 P0 Build phase state\n",
    );

    const { pi, calls: piCalls } = createFakePi({
      exec: async () => ({ code: 1, stdout: "", stderr: "failed" }),
    });
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await advanceToTddWithApproval(piCalls, ctx);
    const newSessionsBefore = ctxCalls.newSessions.length;
    const userMessagesBefore = piCalls.userMessages.length;

    await finishAssistantTurn(
      piCalls,
      ctx,
      "T001 done.\nRALPH_TDD_TASK_COMPLETE T001",
    );

    assert.equal(latestState(piCalls).currentPhase, "tdd_implement");
    assert.equal(latestState(piCalls).tddCompletedTasks, 0);
    assert.equal(latestState(piCalls).pendingHandoff, undefined);
    assert.equal(ctxCalls.newSessions.length, newSessionsBefore);
    assert.equal(piCalls.userMessages.length, userMessagesBefore);
    assert.match(ctxCalls.notifications.at(-1).message, /gates failed/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("TDD task marker keeps TDD active so the agent chooses the next task", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
  try {
    await mkdir(path.join(tempDir, "docs"));
    await writeFile(
      path.join(tempDir, "docs/feature-a-task-list.md"),
      "### T001 [ ] Build phase state\n",
    );

    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await advanceToTddWithApproval(piCalls, ctx);
    const newSessionsBefore = ctxCalls.newSessions.length;

    await finishAssistantTurn(
      piCalls,
      ctx,
      "T001 done.\nRALPH_TDD_TASK_COMPLETE T001",
    );

    assert.equal(latestState(piCalls).currentPhase, "tdd_implement");
    assert.equal(latestState(piCalls).phaseStatus, "executing");
    assert.equal(
      latestState(piCalls).sessionHandoffEvents.at(-1).boundary,
      "task",
    );
    assert.equal(
      latestState(piCalls).sessionHandoffEvents.at(-1).taskId,
      "T001",
    );
    assert.equal(
      latestState(piCalls).sessionHandoffEvents.at(-1).sourcePhase,
      "tdd_implement",
    );
    assert.equal(
      latestState(piCalls).sessionHandoffEvents.at(-1).targetPhase,
      "tdd_implement",
    );
    assert.deepEqual(
      latestState(piCalls).implementationStatus.completedTaskIds,
      ["T001"],
    );
    assert.equal(ctxCalls.newSessions.length, newSessionsBefore + 1);
    assert.match(
      String(piCalls.userMessages.at(-1).content),
      /# ralph-works Phase: Red-Green TDD Implement/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ralph-works next does not advance from TDD to review without the phase marker", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
  try {
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await advanceToTddWithApproval(piCalls, ctx);
    const newSessionsBefore = ctxCalls.newSessions.length;
    const userMessagesBefore = piCalls.userMessages.length;

    await piCalls.commands.get("ralph-works").handler("next", ctx);

    assert.equal(latestState(piCalls).currentPhase, "tdd_implement");
    assert.equal(latestState(piCalls).pendingHandoff, undefined);
    assert.equal(ctxCalls.newSessions.length, newSessionsBefore);
    assert.equal(piCalls.userMessages.length, userMessagesBefore);
    assert.match(ctxCalls.notifications.at(-1).message, /RALPH_PHASE_COMPLETE/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("TDD phase marker starts review when gates pass without requiring a task list", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
  try {
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await advanceToTddWithApproval(piCalls, ctx);
    const newSessionsBefore = ctxCalls.newSessions.length;
    const userMessagesBefore = piCalls.userMessages.length;

    await finishAssistantTurn(
      piCalls,
      ctx,
      "Implementation complete.\nRALPH_PHASE_COMPLETE",
    );

    assert.equal(latestState(piCalls).currentPhase, "review");
    assert.equal(latestState(piCalls).phaseStatus, "executing");
    assert.equal(ctxCalls.newSessions.length, newSessionsBefore + 1);
    assert.equal(piCalls.userMessages.length, userMessagesBefore + 1);
    assert.match(
      String(piCalls.userMessages.at(-1).content),
      /# ralph-works Phase: Review/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("TDD phase marker starts review with an unparseable human task list", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
  try {
    await writeFeatureTaskList(tempDir, "No implementation tasks here.\n");
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await advanceToTddWithApproval(piCalls, ctx);
    const newSessionsBefore = ctxCalls.newSessions.length;
    const userMessagesBefore = piCalls.userMessages.length;

    await finishAssistantTurn(
      piCalls,
      ctx,
      "Implementation complete.\nRALPH_PHASE_COMPLETE",
    );

    assert.equal(latestState(piCalls).currentPhase, "review");
    assert.equal(latestState(piCalls).phaseStatus, "executing");
    assert.equal(ctxCalls.newSessions.length, newSessionsBefore + 1);
    assert.equal(piCalls.userMessages.length, userMessagesBefore + 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("TDD phase marker trusts the agent instead of parsing incomplete markdown tasks", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
  try {
    await writeFeatureTaskList(
      tempDir,
      [
        "- [x] T001 P0 Build phase state",
        "- [ ] T002 P1 Render task progress",
      ].join("\n"),
    );
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await advanceToTddWithApproval(piCalls, ctx);
    const newSessionsBefore = ctxCalls.newSessions.length;
    const userMessagesBefore = piCalls.userMessages.length;

    await finishAssistantTurn(
      piCalls,
      ctx,
      "Implementation complete.\nRALPH_PHASE_COMPLETE",
    );

    assert.equal(latestState(piCalls).currentPhase, "review");
    assert.equal(latestState(piCalls).phaseStatus, "executing");
    assert.equal(ctxCalls.newSessions.length, newSessionsBefore + 1);
    assert.equal(piCalls.userMessages.length, userMessagesBefore + 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("TDD phase marker blocks review when required gates fail", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
  try {
    await writeFile(
      path.join(tempDir, "gate.config.json"),
      JSON.stringify({
        gates: [{ name: "unit_tests", command: "npm test", required: true }],
        run_after_phase: ["tdd_implement"],
        fail_behavior: "block_transition",
      }),
    );
    await writeFeatureTaskList(tempDir, "- [x] T001 P0 Build phase state\n");

    const { pi, calls: piCalls } = createFakePi({
      exec: async () => ({ code: 1, stdout: "", stderr: "failed" }),
    });
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await advanceToTddWithApproval(piCalls, ctx);
    const newSessionsBefore = ctxCalls.newSessions.length;
    const userMessagesBefore = piCalls.userMessages.length;

    await finishAssistantTurn(
      piCalls,
      ctx,
      "Implementation complete.\nRALPH_PHASE_COMPLETE",
    );

    assert.equal(latestState(piCalls).currentPhase, "tdd_implement");
    assert.equal(latestState(piCalls).pendingHandoff, undefined);
    assert.equal(ctxCalls.newSessions.length, newSessionsBefore);
    assert.equal(piCalls.userMessages.length, userMessagesBefore);
    assert.match(ctxCalls.notifications.at(-1).message, /gates failed/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("TDD phase marker hands work to review with one new session", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
  try {
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await advanceToTddWithApproval(piCalls, ctx);
    const newSessionsBefore = ctxCalls.newSessions.length;
    const userMessagesBefore = piCalls.userMessages.length;

    await finishAssistantTurn(
      piCalls,
      ctx,
      "Implementation complete.\nRALPH_PHASE_COMPLETE",
    );

    assert.equal(latestState(piCalls).currentPhase, "review");
    assert.equal(latestState(piCalls).phaseStatus, "executing");
    assert.equal(
      latestState(piCalls).sessionHandoffEvents.at(-1).boundary,
      "phase",
    );
    assert.equal(
      latestState(piCalls).sessionHandoffEvents.at(-1).sourcePhase,
      "tdd_implement",
    );
    assert.equal(
      latestState(piCalls).sessionHandoffEvents.at(-1).targetPhase,
      "review",
    );
    assert.equal(ctxCalls.newSessions.length, newSessionsBefore + 1);
    assert.equal(piCalls.userMessages.length, userMessagesBefore + 1);
    assert.equal(
      latestState(piCalls).sessionHandoffEvents.filter(
        (event) => event.boundary === "phase" && event.targetPhase === "review",
      ).length,
      1,
    );
    assert.match(
      String(piCalls.userMessages.at(-1).content),
      /# ralph-works Phase: Review/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
