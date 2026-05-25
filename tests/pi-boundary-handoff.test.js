import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { registerRalphWorksExtension } from "../src/harness/pi-harness-adapter.js";
import { RALPH_WORKS_SESSION_BOUNDARY_PLAN_ENTRY_TYPE } from "../src/harness/pi-session-boundary-launcher.js";
import { RALPH_WORKS_STATE_ENTRY_TYPE } from "../src/harness/pi-state-persistence.js";
import { RALPH_WORKS_SESSION_BOUNDARY_MESSAGE_TYPE } from "../src/harness/session-boundary-plan.js";
import { createPhaseState } from "../src/state/phase-state.js";
import { transitionToPhase } from "../src/state/phase-transitions.js";
import {
  createSessionBoundaryEvent,
  findSessionBoundaryEvent,
} from "../src/state/session-boundaries.js";

function createFakePi({
  exec = async () => ({ code: 0, stdout: "ok", stderr: "" }),
  sendUserMessage = (content, options, calls) => {
    calls.userMessages.push({ content, options });
  },
} = {}) {
  const calls = {
    commands: new Map(),
    events: new Map(),
    tools: [],
    appended: [],
    models: [],
    userMessages: [],
    execs: [],
  };
  const pi = {
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
    async exec(command, args, options) {
      calls.execs.push({ command, args, options });
      return exec(command, args, options);
    },
  };

  if (sendUserMessage !== false) {
    pi.sendUserMessage = (content, options) =>
      sendUserMessage(content, options, calls);
  }

  return { calls, pi };
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

function latestSetupBoundaryMessage(ctxCalls) {
  return ctxCalls.setupEntries
    .filter(
      (entry) =>
        entry.type === "custom_message" &&
        entry.customType === RALPH_WORKS_SESSION_BOUNDARY_MESSAGE_TYPE,
    )
    .at(-1);
}

function latestSetupBoundaryPlan(ctxCalls) {
  return ctxCalls.setupEntries
    .filter(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === RALPH_WORKS_SESSION_BOUNDARY_PLAN_ENTRY_TYPE,
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

test("tool transition preserves TUI, model routing, artifacts, and safe continuation", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-handoff-"));
  try {
    await writeFile(
      path.join(tempDir, "model.config.json"),
      JSON.stringify({
        phase_models: {
          red_team: "openai/red-team-model",
        },
      }),
    );
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });
    await startPipeline(piCalls, ctx);
    await piCalls.tools
      .find((definition) => definition.name === "ralph_works_record_artifact")
      .execute(
        "artifact-1",
        { key: "generated_spec", path: "docs/feature-a-generated-spec.md" },
        undefined,
        undefined,
        ctx,
      );

    const tool = piCalls.tools.find(
      (definition) => definition.name === "ralph_works_transition",
    );
    const newSessionsBeforeTool = ctxCalls.newSessions.length;
    const compactionsBeforeTool = ctxCalls.compactions.length;
    const replacementPromptsBeforeTool =
      ctxCalls.replacementUserMessages.length;

    await tool.execute("tool-model-artifact", {}, undefined, undefined, ctx);

    const boundary = latestBoundary(piCalls);
    assert.equal(latestState(piCalls).currentPhase, "red_team");
    assert.equal(boundary.toPhase, "red_team");
    assert.equal(boundary.status, "pending");
    assert.equal(ctxCalls.statuses.at(-1).value, "ralph-works: Red Team Pass");
    assert.match(ctxCalls.widgets.at(-1).value.join("\n"), /RUNNING/);
    assert.match(ctxCalls.widgets.at(-1).value.join("\n"), /red-team-model/);
    assert.equal(ctxCalls.newSessions.length, newSessionsBeforeTool);
    assert.equal(ctxCalls.compactions.length, compactionsBeforeTool);
    assert.equal(
      ctxCalls.replacementUserMessages.length,
      replacementPromptsBeforeTool,
    );
    assert.deepEqual(piCalls.userMessages.at(-1), {
      content: `/ralph-works continue-boundary ${boundary.id}`,
      options: { deliverAs: "followUp" },
    });
    assert.equal(
      piCalls.userMessages.every(
        (message) =>
          message.content === `/ralph-works continue-boundary ${boundary.id}`,
      ),
      true,
    );
    assert.equal(
      piCalls.userMessages.some((message) =>
        String(message.content).includes("/new"),
      ),
      false,
    );

    await continueBoundary(piCalls, ctx, boundary.id);

    const setupState = latestSetupState(ctxCalls);
    const plan = latestSetupBoundaryPlan(ctxCalls);
    assert.equal(ctxCalls.newSessions.length, newSessionsBeforeTool + 1);
    assert.equal(ctxCalls.compactions.length, compactionsBeforeTool);
    assert.deepEqual(setupState.artifacts, {
      generated_spec: "docs/feature-a-generated-spec.md",
    });
    assert.deepEqual(plan.selectedModelTarget, {
      provider: "openai",
      id: "red-team-model",
      raw: "openai/red-team-model",
    });
    assert.deepEqual(plan.artifactPaths, [
      { key: "generated_spec", path: "docs/feature-a-generated-spec.md" },
    ]);
    assert.deepEqual(plan.resumeContext.artifactPaths, [
      { key: "generated_spec", path: "docs/feature-a-generated-spec.md" },
    ]);
    assert.deepEqual(
      ctxCalls.setupEntries.find((entry) => entry.type === "model"),
      { type: "model", provider: "openai", modelId: "red-team-model" },
    );
    assert.match(
      String(ctxCalls.replacementUserMessages.at(-1).content),
      /# ralph-works Phase: Red Team Pass/,
    );
    assert.equal(
      findSessionBoundaryEvent(setupState, boundary.id).status,
      "created",
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("tool transition handoff is continued from command context as a fresh session", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-handoff-"));
  try {
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });
    await startPipeline(piCalls, ctx);

    const tool = piCalls.tools.find(
      (definition) => definition.name === "ralph_works_transition",
    );
    const newSessionsBeforeTool = ctxCalls.newSessions.length;
    const compactionsBeforeTool = ctxCalls.compactions.length;
    const replacementPromptsBeforeTool =
      ctxCalls.replacementUserMessages.length;

    const result = await tool.execute("tool-1", {}, undefined, undefined, ctx);

    const boundary = latestBoundary(piCalls);
    assert.equal(result.details.state.currentPhase, "red_team");
    assert.equal(latestState(piCalls).currentPhase, "red_team");
    assert.equal(boundary.boundaryType, "phase");
    assert.equal(boundary.status, "pending");
    assert.equal(boundary.fromPhase, "generate_spec");
    assert.equal(boundary.toPhase, "red_team");
    assert.equal(ctxCalls.newSessions.length, newSessionsBeforeTool);
    assert.equal(ctxCalls.compactions.length, compactionsBeforeTool);
    assert.equal(
      ctxCalls.replacementUserMessages.length,
      replacementPromptsBeforeTool,
    );
    assert.deepEqual(piCalls.userMessages.at(-1), {
      content: `/ralph-works continue-boundary ${boundary.id}`,
      options: { deliverAs: "followUp" },
    });

    await continueBoundary(piCalls, ctx, boundary.id);

    assert.equal(ctxCalls.newSessions.length, newSessionsBeforeTool + 1);
    assert.equal(ctxCalls.compactions.length, compactionsBeforeTool);
    assert.equal(
      ctxCalls.replacementUserMessages.length,
      replacementPromptsBeforeTool + 1,
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

test("tool transition from harden spec hands off an approval-pause boundary", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-handoff-"));
  try {
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });
    await startPipeline(piCalls, ctx);
    await advanceWithCommand(piCalls, ctx, ctxCalls);
    await advanceWithCommand(piCalls, ctx, ctxCalls);
    assert.equal(latestState(piCalls).currentPhase, "harden_spec");
    assert.equal(latestState(piCalls).phaseStatus, "executing");

    const tool = piCalls.tools.find(
      (definition) => definition.name === "ralph_works_transition",
    );
    const newSessionsBeforeTool = ctxCalls.newSessions.length;
    const compactionsBeforeTool = ctxCalls.compactions.length;
    const messagesBeforeTool = piCalls.userMessages.length;
    const replacementPromptsBeforeTool =
      ctxCalls.replacementUserMessages.length;

    const result = await tool.execute(
      "tool-harden",
      { renderHtml: true },
      undefined,
      undefined,
      ctx,
    );

    const boundary = latestBoundary(piCalls);
    assert.equal(result.details.state.currentPhase, "harden_spec");
    assert.equal(result.details.state.phaseStatus, "awaiting_harden_approval");
    assert.equal(latestState(piCalls).currentPhase, "harden_spec");
    assert.equal(latestState(piCalls).phaseStatus, "awaiting_harden_approval");
    assert.equal(boundary.boundaryType, "phase");
    assert.equal(boundary.status, "pending");
    assert.equal(boundary.fromPhase, "harden_spec");
    assert.equal(boundary.toPhase, "harden_spec");
    assert.equal(ctxCalls.newSessions.length, newSessionsBeforeTool);
    assert.equal(ctxCalls.compactions.length, compactionsBeforeTool);
    assert.equal(
      ctxCalls.replacementUserMessages.length,
      replacementPromptsBeforeTool,
    );
    assert.equal(piCalls.userMessages.length, messagesBeforeTool + 1);
    assert.deepEqual(piCalls.userMessages.at(-1), {
      content: `/ralph-works continue-boundary ${boundary.id}`,
      options: { deliverAs: "followUp" },
    });
    assert.match(
      ctxCalls.notifications.at(-1).message,
      /Approve the hardened spec/,
    );
    assert.match(
      ctxCalls.notifications.at(-1).message,
      /approve --render-html/,
    );

    const boundaryCount = latestState(piCalls).sessionBoundaryEvents.length;
    const repeatedResult = await tool.execute(
      "tool-harden-repeat",
      {},
      undefined,
      undefined,
      ctx,
    );

    assert.equal(repeatedResult.details.state.currentPhase, "harden_spec");
    assert.equal(
      repeatedResult.details.state.phaseStatus,
      "awaiting_harden_approval",
    );
    assert.equal(
      latestState(piCalls).sessionBoundaryEvents.length,
      boundaryCount,
    );
    assert.equal(latestBoundary(piCalls).id, boundary.id);
    assert.equal(ctxCalls.newSessions.length, newSessionsBeforeTool);
    assert.equal(ctxCalls.compactions.length, compactionsBeforeTool);
    assert.equal(piCalls.userMessages.length, messagesBeforeTool + 2);
    assert.deepEqual(piCalls.userMessages.at(-1), {
      content: `/ralph-works continue-boundary ${boundary.id}`,
      options: { deliverAs: "followUp" },
    });
    assert.match(ctxCalls.notifications.at(-1).message, /approve/i);
    assert.match(
      ctxCalls.notifications.at(-1).message,
      /approve --render-html/,
    );

    await continueBoundary(piCalls, ctx, boundary.id);

    assert.equal(ctxCalls.newSessions.length, newSessionsBeforeTool + 1);
    assert.equal(ctxCalls.compactions.length, compactionsBeforeTool);
    assert.equal(
      ctxCalls.replacementUserMessages.length,
      replacementPromptsBeforeTool,
    );
    const approvalMessage = latestSetupBoundaryMessage(ctxCalls);
    assert.equal(approvalMessage.display, true);
    assert.equal(approvalMessage.details.nextActionType, "approval_pause");
    assert.match(approvalMessage.content, /Action required/);
    assert.match(approvalMessage.content, /\/ralph-works approve\b/);
    assert.match(
      approvalMessage.content,
      /\/ralph-works approve --render-html\b/,
    );
    assert.doesNotMatch(
      String(ctxCalls.replacementUserMessages.at(-1)?.content ?? ""),
      /# ralph-works Phase: (Task Creation|Optional HTML Render)/,
    );
    assert.equal(
      findSessionBoundaryEvent(latestSetupState(ctxCalls), boundary.id).status,
      "created",
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("repeated tool transition reuses unresolved phase boundary without rerunning gates", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-handoff-"));
  try {
    await writeFile(
      path.join(tempDir, "gate.config.json"),
      JSON.stringify({
        gates: [{ name: "unit_tests", command: "npm test", required: true }],
        run_after_phase: ["tdd_implement"],
        fail_behavior: "block_transition",
      }),
    );

    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });
    await startPipeline(piCalls, ctx);
    await advanceWithCommand(piCalls, ctx, ctxCalls);
    await advanceWithCommand(piCalls, ctx, ctxCalls);
    await advanceWithCommand(piCalls, ctx, ctxCalls);
    await piCalls.commands.get("ralph-works").handler("approve", ctx);
    assert.equal(latestState(piCalls).currentPhase, "create_tasks");

    const tool = piCalls.tools.find(
      (definition) => definition.name === "ralph_works_transition",
    );
    await tool.execute("tool-create-tdd", {}, undefined, undefined, ctx);

    const boundary = latestBoundary(piCalls);
    const boundaryCount = latestState(piCalls).sessionBoundaryEvents.length;
    const messagesAfterFirstTool = piCalls.userMessages.length;
    assert.equal(latestState(piCalls).currentPhase, "tdd_implement");
    assert.equal(boundary.toPhase, "tdd_implement");
    assert.equal(piCalls.execs.length, 0);

    const result = await tool.execute(
      "tool-repeat-tdd",
      {},
      undefined,
      undefined,
      ctx,
    );

    assert.equal(result.details.state.currentPhase, "tdd_implement");
    assert.equal(latestState(piCalls).currentPhase, "tdd_implement");
    assert.equal(
      latestState(piCalls).sessionBoundaryEvents.length,
      boundaryCount,
    );
    assert.equal(latestBoundary(piCalls).id, boundary.id);
    assert.equal(piCalls.execs.length, 0);
    assert.equal(piCalls.userMessages.length, messagesAfterFirstTool + 1);
    assert.deepEqual(piCalls.userMessages.at(-1), {
      content: `/ralph-works continue-boundary ${boundary.id}`,
      options: { deliverAs: "followUp" },
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("tool transition from TDD blocks on required gate failure without a boundary", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-handoff-"));
  try {
    await writeFile(
      path.join(tempDir, "gate.config.json"),
      JSON.stringify({
        gates: [{ name: "unit_tests", command: "npm test", required: true }],
        run_after_phase: ["tdd_implement"],
        fail_behavior: "block_transition",
      }),
    );

    const { pi, calls: piCalls } = createFakePi({
      exec: async () => ({ code: 1, stdout: "", stderr: "failed" }),
    });
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });
    await advanceToTdd(piCalls, ctx, ctxCalls);

    const boundaryCountBeforeTool =
      latestState(piCalls).sessionBoundaryEvents.length;
    const messagesBeforeTool = piCalls.userMessages.length;
    const newSessionsBeforeTool = ctxCalls.newSessions.length;
    const compactionsBeforeTool = ctxCalls.compactions.length;
    const tool = piCalls.tools.find(
      (definition) => definition.name === "ralph_works_transition",
    );

    const result = await tool.execute(
      "tool-tdd-gate-fail",
      {},
      undefined,
      undefined,
      ctx,
    );

    const state = latestState(piCalls);
    assert.equal(result.details.state.currentPhase, "tdd_implement");
    assert.equal(state.currentPhase, "tdd_implement");
    assert.equal(state.sessionBoundaryEvents.length, boundaryCountBeforeTool);
    assert.equal(piCalls.userMessages.length, messagesBeforeTool);
    assert.equal(ctxCalls.newSessions.length, newSessionsBeforeTool);
    assert.equal(ctxCalls.compactions.length, compactionsBeforeTool);
    assert.equal(piCalls.execs.length, 1);
    assert.equal(state.gateResults[0].name, "unit_tests");
    assert.equal(state.gateResults[0].passed, false);
    assert.equal(state.gateResults[0].blocksTransition, true);
    assert.match(ctxCalls.widgets.at(-1).value.join("\n"), /unit_tests/);
    assert.match(ctxCalls.notifications.at(-1).message, /gates failed/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("tool transition from TDD runs gates once before creating one review boundary", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-handoff-"));
  try {
    await writeFile(
      path.join(tempDir, "gate.config.json"),
      JSON.stringify({
        gates: [{ name: "unit_tests", command: "npm test", required: true }],
        run_after_phase: ["tdd_implement"],
        fail_behavior: "block_transition",
      }),
    );

    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });
    await advanceToTdd(piCalls, ctx, ctxCalls);

    const boundaryCountBeforeTool =
      latestState(piCalls).sessionBoundaryEvents.length;
    const execsBeforeTool = piCalls.execs.length;
    const newSessionsBeforeTool = ctxCalls.newSessions.length;
    const compactionsBeforeTool = ctxCalls.compactions.length;
    const tool = piCalls.tools.find(
      (definition) => definition.name === "ralph_works_transition",
    );

    const result = await tool.execute(
      "tool-tdd-gate-pass",
      {},
      undefined,
      undefined,
      ctx,
    );

    const state = latestState(piCalls);
    const boundary = latestBoundary(piCalls);
    assert.equal(result.details.state.currentPhase, "review");
    assert.equal(state.currentPhase, "review");
    assert.equal(
      state.sessionBoundaryEvents.length,
      boundaryCountBeforeTool + 1,
    );
    assert.equal(boundary.boundaryType, "phase");
    assert.equal(boundary.status, "pending");
    assert.equal(boundary.fromPhase, "tdd_implement");
    assert.equal(boundary.toPhase, "review");
    assert.equal(piCalls.execs.length, execsBeforeTool + 1);
    assert.equal(state.gateResults[0].name, "unit_tests");
    assert.equal(state.gateResults[0].passed, true);
    assert.equal(ctxCalls.newSessions.length, newSessionsBeforeTool);
    assert.equal(ctxCalls.compactions.length, compactionsBeforeTool);
    assert.deepEqual(piCalls.userMessages.at(-1), {
      content: `/ralph-works continue-boundary ${boundary.id}`,
      options: { deliverAs: "followUp" },
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("repeated tool transition reports the same manual command when follow-up queueing is unavailable", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-handoff-"));
  try {
    const { pi, calls: piCalls } = createFakePi({ sendUserMessage: false });
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });
    await startPipeline(piCalls, ctx);

    const tool = piCalls.tools.find(
      (definition) => definition.name === "ralph_works_transition",
    );
    await tool.execute("tool-first", {}, undefined, undefined, ctx);

    const boundary = latestBoundary(piCalls);
    const boundaryCount = latestState(piCalls).sessionBoundaryEvents.length;
    const manualCommand = `/ralph-works continue-boundary ${boundary.id}`;
    assert.equal(latestState(piCalls).currentPhase, "red_team");
    assert.equal(boundary.status, "followup_failed");

    const result = await tool.execute(
      "tool-repeat",
      {},
      undefined,
      undefined,
      ctx,
    );

    assert.equal(result.details.state.currentPhase, "red_team");
    assert.equal(latestState(piCalls).currentPhase, "red_team");
    assert.equal(
      latestState(piCalls).sessionBoundaryEvents.length,
      boundaryCount,
    );
    assert.equal(latestBoundary(piCalls).id, boundary.id);
    assert.match(result.content[0].text, new RegExp(manualCommand));
    assert.match(
      ctxCalls.notifications.at(-1).message,
      new RegExp(manualCommand),
    );
    assert.equal(piCalls.userMessages.length, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("tool transition ignores unresolved phase boundaries for a different target phase", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-handoff-"));
  try {
    const activeState = transitionToPhase(
      createPhaseState({
        feature: "feature-a",
        promptText: "Build feature A",
        now: () => "2026-05-24T00:00:00.000Z",
      }),
      "red_team",
      {
        reason: "restored red team",
        now: () => "2026-05-24T00:00:00.000Z",
      },
    );
    const restoredState = {
      ...activeState,
      sessionBoundaryEvents: [
        createSessionBoundaryEvent({
          id: "stale-boundary",
          boundaryType: "phase",
          reason: "stale generate spec handoff",
          fromPhase: "start",
          toPhase: "generate_spec",
          status: "pending",
          now: () => "2026-05-24T00:00:00.000Z",
        }),
      ],
    };
    const { pi, calls: piCalls } = createFakePi();
    const { ctx } = createFakeContext(tempDir, {
      entries: [stateEntry(restoredState)],
    });
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });
    await piCalls.events.get("session_start")({}, ctx);

    const tool = piCalls.tools.find(
      (definition) => definition.name === "ralph_works_transition",
    );
    const result = await tool.execute(
      "tool-stale",
      {},
      undefined,
      undefined,
      ctx,
    );

    assert.equal(result.details.state.currentPhase, "harden_spec");
    assert.equal(latestState(piCalls).sessionBoundaryEvents.length, 2);
    assert.equal(latestBoundary(piCalls).toPhase, "harden_spec");
    assert.notEqual(latestBoundary(piCalls).id, "stale-boundary");
    assert.deepEqual(piCalls.userMessages.at(-1), {
      content: `/ralph-works continue-boundary ${latestBoundary(piCalls).id}`,
      options: { deliverAs: "followUp" },
    });
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

test("tool handoff follow-up failures are durable and manually continuable after restore", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-handoff-"));
  try {
    for (const scenario of [
      { name: "missing sendUserMessage", sendUserMessage: false },
      {
        name: "throwing sendUserMessage",
        sendUserMessage() {
          throw new Error("follow-up failed");
        },
      },
    ]) {
      const { pi, calls: piCalls } = createFakePi({
        sendUserMessage: scenario.sendUserMessage,
      });
      const { ctx, calls: ctxCalls } = createFakeContext(tempDir);
      registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });
      await startPipeline(piCalls, ctx);
      const compactionsBeforeTool = ctxCalls.compactions.length;
      const tool = piCalls.tools.find(
        (definition) => definition.name === "ralph_works_transition",
      );

      const result = await tool.execute(
        `tool-${scenario.name}`,
        {},
        undefined,
        undefined,
        ctx,
      );

      const persistedState = latestState(piCalls);
      const boundary = latestBoundary(piCalls);
      const manualCommand = `/ralph-works continue-boundary ${boundary.id}`;
      assert.equal(
        result.details.state.currentPhase,
        "red_team",
        scenario.name,
      );
      assert.equal(persistedState.currentPhase, "red_team", scenario.name);
      assert.equal(boundary.status, "followup_failed", scenario.name);
      assert.equal(
        ctxCalls.compactions.length,
        compactionsBeforeTool,
        scenario.name,
      );
      assert.equal(piCalls.userMessages.length, 0, scenario.name);
      assert.match(
        ctxCalls.notifications.at(-1).message,
        new RegExp(boundary.id),
        scenario.name,
      );
      assert.match(
        ctxCalls.notifications.at(-1).message,
        /\/ralph-works continue-boundary /,
        scenario.name,
      );
      assert.match(
        result.content[0].text,
        new RegExp(manualCommand),
        scenario.name,
      );

      const { pi: restoredPi, calls: restoredPiCalls } = createFakePi({
        sendUserMessage: scenario.sendUserMessage,
      });
      const { ctx: restoredCtx, calls: restoredCtxCalls } = createFakeContext(
        tempDir,
        { entries: [stateEntry(persistedState)] },
      );
      registerRalphWorksExtension(restoredPi, {
        extensionRoot: path.resolve("."),
      });

      await restoredPiCalls.events.get("session_start")({}, restoredCtx);
      await continueBoundary(restoredPiCalls, restoredCtx, boundary.id);

      assert.equal(restoredCtxCalls.compactions.length, 0, scenario.name);
      assert.equal(restoredCtxCalls.newSessions.length, 1, scenario.name);
      assert.match(
        String(restoredCtxCalls.replacementUserMessages[0].content),
        /# ralph-works Phase: Red Team Pass/,
        scenario.name,
      );
      assert.equal(
        findSessionBoundaryEvent(
          latestSetupState(restoredCtxCalls),
          boundary.id,
        )?.status,
        "created",
        scenario.name,
      );
    }
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

test("explicit review change-request markers use assistant handoff", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-handoff-"));
  try {
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });
    await advanceToReview(piCalls, ctx, ctxCalls);

    const newSessionsBeforeMarker = ctxCalls.newSessions.length;
    const compactionsBeforeMarker = ctxCalls.compactions.length;
    const messagesBeforeMarker = piCalls.userMessages.length;

    await finishAssistantTurn(
      piCalls,
      ctx,
      [
        "Please address the review findings.",
        "RALPH_REVIEW_CHANGES_REQUESTED",
      ].join("\n"),
    );

    const boundary = latestBoundary(piCalls);
    assert.equal(latestState(piCalls).currentPhase, "tdd_implement");
    assert.equal(latestState(piCalls).loopbackCount, 1);
    assert.equal(boundary.boundaryType, "phase");
    assert.equal(boundary.reason, "review requested changes");
    assert.equal(boundary.fromPhase, "review");
    assert.equal(boundary.toPhase, "tdd_implement");
    assert.match(boundary.reviewFeedback, /Please address/);
    assert.doesNotMatch(
      boundary.reviewFeedback,
      /RALPH_REVIEW_CHANGES_REQUESTED/,
    );
    assert.equal(ctxCalls.newSessions.length, newSessionsBeforeMarker);
    assert.equal(ctxCalls.compactions.length, compactionsBeforeMarker);
    assert.equal(piCalls.userMessages.length, messagesBeforeMarker + 1);
    assert.deepEqual(piCalls.userMessages.at(-1), {
      content: `/ralph-works continue-boundary ${boundary.id}`,
      options: { deliverAs: "followUp" },
    });

    await continueBoundary(piCalls, ctx, boundary.id);

    assert.equal(ctxCalls.newSessions.length, newSessionsBeforeMarker + 1);
    assert.match(
      String(ctxCalls.replacementUserMessages.at(-1).content),
      /Review requested changes/,
    );
    assert.match(
      String(ctxCalls.replacementUserMessages.at(-1).content),
      /# ralph-works Phase: Red-Green TDD Implement/,
    );
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
