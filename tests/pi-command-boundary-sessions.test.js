import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { registerRalphWorksExtension } from "../src/harness/pi-harness-adapter.js";
import { RALPH_WORKS_SESSION_BOUNDARY_PLAN_ENTRY_TYPE } from "../src/harness/pi-session-boundary-launcher.js";
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
    execs: [],
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
      async exec(command, args, options) {
        calls.execs.push({ command, args, options });
        return exec(command, args, options);
      },
      sendUserMessage(content, options) {
        calls.userMessages.push({ content, options });
      },
    },
  };
}

function createWritableSessionManager(sessionFile) {
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

function createFreshSessionContext(cwd, { entries = [], modelRegistry } = {}) {
  const calls = {
    statuses: [],
    widgets: [],
    notifications: [],
    compactions: [],
    waits: 0,
    newSessions: [],
    setupEntries: [],
    replacementUserMessages: [],
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
      modelRegistry: modelRegistry ?? {
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
        const setupSessionManager = createWritableSessionManager(
          `/sessions/replacement-${calls.newSessions.length}.jsonl`,
        );
        await options.setup?.(setupSessionManager);
        calls.setupEntries.push(...setupSessionManager.entries);
        await options.withSession?.({
          hasUI: true,
          ui: {
            setStatus(key, value) {
              calls.statuses.push({ key, value, replacement: true });
            },
            setWidget(key, value) {
              calls.widgets.push({ key, value, replacement: true });
            },
            notify(message, level) {
              calls.notifications.push({ message, level, replacement: true });
            },
          },
          sessionManager: createWritableSessionManager(
            `/sessions/replacement-${calls.newSessions.length}.jsonl`,
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

function latestPersistedState(piCalls) {
  return piCalls.appended.at(-1)?.data;
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

function latestBoundaryPlanEntry(ctxCalls) {
  return ctxCalls.setupEntries
    .filter(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === RALPH_WORKS_SESSION_BOUNDARY_PLAN_ENTRY_TYPE,
    )
    .at(-1)?.data;
}

function latestCustomMessageEntry(ctxCalls) {
  return ctxCalls.setupEntries
    .filter((entry) => entry.type === "custom_message")
    .at(-1);
}

function latestModelChangeEntry(ctxCalls) {
  return ctxCalls.setupEntries.filter((entry) => entry.type === "model").at(-1);
}

async function runCommand(piCalls, ctx, command) {
  await piCalls.commands.get("ralph-works").handler(command, ctx);
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

async function advanceToTdd(piCalls, ctx) {
  await runCommand(piCalls, ctx, "start feature-a Build feature A");
  await runCommand(piCalls, ctx, "next");
  await runCommand(piCalls, ctx, "next");
  await runCommand(piCalls, ctx, "next");
  await runCommand(piCalls, ctx, "approve");
  await runCommand(piCalls, ctx, "next");
  assert.equal(latestPersistedState(piCalls).currentPhase, "tdd_implement");
}

async function writeTddFixtures(tempDir, taskListMarkdown) {
  await mkdir(path.join(tempDir, "docs"));
  await writeFile(
    path.join(tempDir, "gate.config.json"),
    JSON.stringify({
      gates: [{ name: "unit_tests", command: "npm test", required: true }],
      run_after_phase: ["tdd_implement"],
      fail_behavior: "block_transition",
    }),
  );
  await writeFile(
    path.join(tempDir, "docs/feature-a-task-list.md"),
    taskListMarkdown,
  );
}

async function readImplementationStatus(tempDir) {
  return JSON.parse(
    await readFile(
      path.join(tempDir, "docs/feature-a-implementation-status.json"),
      "utf8",
    ),
  );
}

test("start creates a fresh session and launches generate_spec from the replacement context", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-command-boundary-"));
  try {
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFreshSessionContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await runCommand(piCalls, ctx, "start feature-a Build feature A");

    assert.equal(ctxCalls.waits, 1);
    assert.equal(ctxCalls.newSessions.length, 1);
    assert.equal(ctxCalls.compactions.length, 0);
    assert.equal(piCalls.userMessages.length, 0);
    assert.equal(ctxCalls.replacementUserMessages.length, 1);
    assert.match(
      String(ctxCalls.replacementUserMessages[0].content),
      /# ralph-works Phase: Generate Spec/,
    );
    const persistedState = latestPersistedState(piCalls);
    assert.equal(persistedState.currentPhase, "generate_spec");
    assert.equal(persistedState.phaseStatus, "executing");
    const boundary = persistedState.sessionBoundaryEvents.at(-1);
    assert.equal(boundary.boundaryType, "phase");
    assert.equal(boundary.reason, "start");
    assert.equal(boundary.toPhase, "generate_spec");
    assert.equal(
      findSessionBoundaryEvent(latestSetupState(ctxCalls), boundary.id).status,
      "created",
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("fresh session boundaries update TUI from the replacement context", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-command-boundary-"));
  try {
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFreshSessionContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await runCommand(piCalls, ctx, "start feature-a Build feature A");

    const replacementStatus = ctxCalls.statuses.find(
      (status) => status.replacement,
    );
    const replacementWidget = ctxCalls.widgets.find(
      (widget) => widget.replacement,
    );
    assert.deepEqual(replacementStatus, {
      key: "ralph-works",
      value: "ralph-works: Generate Spec",
      replacement: true,
    });
    assert.match(replacementWidget.value.join("\n"), /RUNNING/);

    await runCommand(piCalls, ctx, "next");
    await runCommand(piCalls, ctx, "next");
    const promptsBeforePause = ctxCalls.replacementUserMessages.length;
    await runCommand(piCalls, ctx, "next");

    const pauseStatus = ctxCalls.statuses
      .filter((status) => status.replacement)
      .at(-1);
    const pauseWidget = ctxCalls.widgets
      .filter((widget) => widget.replacement)
      .at(-1);
    assert.equal(ctxCalls.replacementUserMessages.length, promptsBeforePause);
    assert.deepEqual(pauseStatus, {
      key: "ralph-works",
      value: "ralph-works: Harden Spec",
      replacement: true,
    });
    assert.match(pauseWidget.value.join("\n"), /WAITING/);

    await runCommand(piCalls, ctx, "approve");
    await runCommand(piCalls, ctx, "next");
    await runCommand(piCalls, ctx, "next");
    const promptsBeforeCompletion = ctxCalls.replacementUserMessages.length;
    await runCommand(piCalls, ctx, "approve");

    const completionStatus = ctxCalls.statuses
      .filter((status) => status.replacement)
      .at(-1);
    const completionWidget = ctxCalls.widgets
      .filter((widget) => widget.replacement)
      .at(-1);
    assert.equal(
      ctxCalls.replacementUserMessages.length,
      promptsBeforeCompletion,
    );
    assert.deepEqual(completionStatus, {
      key: "ralph-works",
      value: "ralph-works: Complete",
      replacement: true,
    });
    assert.match(completionWidget.value.join("\n"), /COMPLETE/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("command phase transitions, harden pause, and approval use fresh sessions", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-command-boundary-"));
  try {
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFreshSessionContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await runCommand(piCalls, ctx, "start feature-a Build feature A");
    await runCommand(piCalls, ctx, "next");

    assert.equal(latestPersistedState(piCalls).currentPhase, "red_team");
    assert.equal(ctxCalls.newSessions.length, 2);
    assert.equal(ctxCalls.compactions.length, 0);
    assert.match(
      String(ctxCalls.replacementUserMessages.at(-1).content),
      /# ralph-works Phase: Red Team Pass/,
    );

    await runCommand(piCalls, ctx, "next");
    assert.equal(latestPersistedState(piCalls).currentPhase, "harden_spec");
    assert.equal(ctxCalls.newSessions.length, 3);

    const promptsBeforePause = ctxCalls.replacementUserMessages.length;
    await runCommand(piCalls, ctx, "next");

    assert.equal(latestPersistedState(piCalls).currentPhase, "harden_spec");
    assert.equal(
      latestPersistedState(piCalls).phaseStatus,
      "awaiting_harden_approval",
    );
    assert.equal(ctxCalls.newSessions.length, 4);
    assert.equal(ctxCalls.replacementUserMessages.length, promptsBeforePause);
    assert.match(
      ctxCalls.notifications.at(-1).message,
      /Approve the hardened spec/,
    );

    await runCommand(piCalls, ctx, "approve");

    assert.equal(latestPersistedState(piCalls).currentPhase, "create_tasks");
    assert.equal(latestPersistedState(piCalls).phaseStatus, "executing");
    assert.equal(ctxCalls.newSessions.length, 5);
    assert.match(
      String(ctxCalls.replacementUserMessages.at(-1).content),
      /# ralph-works Phase: Task Creation/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("fresh phase boundaries apply phase-specific models through replacement setup only", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-command-boundary-"));
  try {
    await writeFile(
      path.join(tempDir, "model.config.json"),
      JSON.stringify({
        default_model: "anthropic/default-model",
        phase_models: {
          red_team: "openai/red-team-model",
        },
      }),
    );
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFreshSessionContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await runCommand(piCalls, ctx, "start feature-a Build feature A");
    await runCommand(piCalls, ctx, "next");

    assert.equal(piCalls.models.length, 0);
    assert.deepEqual(latestModelChangeEntry(ctxCalls), {
      type: "model",
      provider: "openai",
      modelId: "red-team-model",
    });
    assert.deepEqual(latestBoundaryPlanEntry(ctxCalls).selectedModelTarget, {
      provider: "openai",
      id: "red-team-model",
      raw: "openai/red-team-model",
    });
    assert.match(ctxCalls.widgets.at(-1).value.join("\n"), /red-team-model/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("fresh phase boundaries fall back to the default configured model", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-command-boundary-"));
  try {
    await writeFile(
      path.join(tempDir, "model.config.json"),
      JSON.stringify({
        default_model: "anthropic/default-model",
        phase_models: {},
      }),
    );
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFreshSessionContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await runCommand(piCalls, ctx, "start feature-a Build feature A");
    await runCommand(piCalls, ctx, "next");

    assert.equal(piCalls.models.length, 0);
    assert.deepEqual(latestModelChangeEntry(ctxCalls), {
      type: "model",
      provider: "anthropic",
      modelId: "default-model",
    });
    assert.deepEqual(latestBoundaryPlanEntry(ctxCalls).selectedModelTarget, {
      provider: "anthropic",
      id: "default-model",
      raw: "anthropic/default-model",
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("fresh phase boundaries warn for missing models without stale setters or setup model changes", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-command-boundary-"));
  try {
    await writeFile(
      path.join(tempDir, "model.config.json"),
      JSON.stringify({
        phase_models: {
          red_team: "openai/missing-model",
        },
      }),
    );
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFreshSessionContext(tempDir, {
      modelRegistry: {
        find() {
          return undefined;
        },
      },
    });
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await runCommand(piCalls, ctx, "start feature-a Build feature A");
    const modelEntriesBefore = ctxCalls.setupEntries.filter(
      (entry) => entry.type === "model",
    ).length;
    await runCommand(piCalls, ctx, "next");

    assert.equal(piCalls.models.length, 0);
    assert.equal(
      ctxCalls.setupEntries.filter((entry) => entry.type === "model").length,
      modelEntriesBefore,
    );
    assert.deepEqual(latestBoundaryPlanEntry(ctxCalls).selectedModelTarget, {
      raw: "openai/missing-model",
    });
    assert.match(
      ctxCalls.notifications.at(-1).message,
      /Configured model not found: openai\/missing-model/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("fresh phase boundaries warn for unavailable model auth without stale setters or setup model changes", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-command-boundary-"));
  try {
    await writeFile(
      path.join(tempDir, "model.config.json"),
      JSON.stringify({
        phase_models: {
          red_team: "openai/no-auth-model",
        },
      }),
    );
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFreshSessionContext(tempDir, {
      modelRegistry: {
        find(provider, id) {
          return { provider, id };
        },
        hasConfiguredAuth() {
          return false;
        },
      },
    });
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await runCommand(piCalls, ctx, "start feature-a Build feature A");
    const modelEntriesBefore = ctxCalls.setupEntries.filter(
      (entry) => entry.type === "model",
    ).length;
    await runCommand(piCalls, ctx, "next");

    assert.equal(piCalls.models.length, 0);
    assert.equal(
      ctxCalls.setupEntries.filter((entry) => entry.type === "model").length,
      modelEntriesBefore,
    );
    assert.deepEqual(latestBoundaryPlanEntry(ctxCalls).selectedModelTarget, {
      raw: "openai/no-auth-model",
    });
    assert.match(
      ctxCalls.notifications.at(-1).message,
      /No API key available for model: openai\/no-auth-model/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("TDD task completion writes durable status and launches next task from a fresh session", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-command-boundary-"));
  try {
    await writeTddFixtures(
      tempDir,
      [
        "- [ ] T001 P0 Build phase state",
        "- [ ] T002 P1 Render task progress",
      ].join("\n"),
    );
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFreshSessionContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await advanceToTdd(piCalls, ctx);

    assert.equal(
      latestPersistedState(piCalls).artifacts.implementationStatus,
      "docs/feature-a-implementation-status.json",
    );
    const sessionsBeforeTask = ctxCalls.newSessions.length;
    await finishAssistantTurn(
      piCalls,
      ctx,
      "T001 done.\nRALPH_TDD_TASK_COMPLETE T001",
    );

    const status = await readImplementationStatus(tempDir);
    assert.equal(status.feature, "feature-a");
    assert.equal(status.status, "in_progress");
    assert.equal(status.completedTaskIds.includes("T001"), true);
    assert.deepEqual(status.claimedTaskIds, []);
    assert.equal(status.gateResultsByTask.T001[0].name, "unit_tests");
    assert.equal(status.gateResultsByTask.T001[0].passed, true);
    assert.equal("stdout" in status.gateResultsByTask.T001[0], false);
    assert.equal("stderr" in status.gateResultsByTask.T001[0], false);

    const boundary = latestPersistedState(piCalls).sessionBoundaryEvents.at(-1);
    assert.equal(boundary.boundaryType, "task");
    assert.equal(boundary.taskId, "T001");
    assert.equal(boundary.nextTaskId, "T002");
    assert.equal(ctxCalls.newSessions.length, sessionsBeforeTask);

    await runCommand(piCalls, ctx, `continue-boundary ${boundary.id}`);

    assert.equal(ctxCalls.newSessions.length, sessionsBeforeTask + 1);
    assert.equal(ctxCalls.compactions.length, 0);
    assert.equal(
      piCalls.userMessages.at(-1).content,
      `/ralph-works continue-boundary ${boundary.id}`,
    );
    assert.match(
      String(ctxCalls.replacementUserMessages.at(-1).content),
      /# ralph-works Phase: Red-Green TDD Implement/,
    );
    assert.equal(
      latestSetupState(ctxCalls).implementationStatus.completedTaskIds.includes(
        "T001",
      ),
      true,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("session_start restores seeded replacement state and selects next TDD task from durable status artifact", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-command-boundary-"));
  try {
    await writeTddFixtures(
      tempDir,
      [
        "- [ ] T001 P0 Build phase state",
        "- [ ] T002 P1 Render task progress",
      ].join("\n"),
    );
    await writeFile(
      path.join(tempDir, "docs/feature-a-implementation-status.json"),
      `${JSON.stringify(
        {
          feature: "feature-a",
          status: "in_progress",
          updatedAt: "2026-05-24T00:00:00.000Z",
          completedTaskIds: ["T001"],
          claimedTaskIds: [],
          gateResultsByTask: {
            T001: [
              {
                name: "unit_tests",
                command: "npm test",
                required: true,
                passed: true,
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );

    const pendingBoundary = createSessionBoundaryEvent({
      id: "restore-task-boundary",
      boundaryType: "task",
      reason: "completed T001",
      fromPhase: "tdd_implement",
      taskId: "T001",
      nextTaskId: "T002",
      now: () => "2026-05-24T00:00:01.000Z",
    });
    const seededState = {
      ...createPhaseState({
        feature: "feature-a",
        promptText: "Build feature A",
        now: () => "2026-05-24T00:00:00.000Z",
      }),
      currentPhase: "tdd_implement",
      phaseStatus: "executing",
      completedPhases: [
        "generate_spec",
        "red_team",
        "harden_spec",
        "create_tasks",
      ],
      artifacts: {
        taskList: "docs/feature-a-task-list.md",
        implementationStatus: "docs/feature-a-implementation-status.json",
      },
      gateResults: [
        {
          name: "unit_tests",
          command: "npm test",
          required: true,
          passed: true,
        },
      ],
      implementationStatus: {
        completedTaskIds: [],
        claimedTaskIds: [],
        gateResultsByTask: {},
      },
      tddCompletedTasks: 1,
      sessionBoundaryEvents: [pendingBoundary],
      compactionEvents: [
        {
          boundary: "phase",
          reason: "legacy fallback",
          at: "2026-05-23T00:00:00.000Z",
        },
      ],
    };
    const entries = [
      {
        type: "custom_message",
        customType: "ralph-works-session-boundary",
        content: "RalphWorks is starting a new session.",
      },
      {
        type: "custom",
        customType: RALPH_WORKS_STATE_ENTRY_TYPE,
        data: seededState,
      },
    ];

    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFreshSessionContext(tempDir, {
      entries,
    });
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await piCalls.events.get("session_start")({ reason: "startup" }, ctx);

    assert.equal(
      ctxCalls.statuses.at(-1).value,
      "ralph-works: Red-Green TDD Implement",
    );
    const statusTool = piCalls.tools.find(
      (definition) => definition.name === "ralph_works_status",
    );
    const statusResult = await statusTool.execute(
      "tool-1",
      {},
      undefined,
      undefined,
      ctx,
    );
    assert.equal(statusResult.details.state.currentPhase, "tdd_implement");
    assert.equal(statusResult.details.state.phaseStatus, "executing");
    assert.deepEqual(
      statusResult.details.state.gateResults,
      seededState.gateResults,
    );
    assert.equal(
      statusResult.details.state.implementationStatus.completedTaskIds.includes(
        "T001",
      ),
      true,
    );
    assert.deepEqual(statusResult.details.state.sessionBoundaryEvents, [
      pendingBoundary,
    ]);
    assert.deepEqual(
      statusResult.details.state.compactionEvents,
      seededState.compactionEvents,
    );

    await runCommand(piCalls, ctx, `continue-boundary ${pendingBoundary.id}`);

    assert.equal(ctxCalls.newSessions.length, 1);
    assert.equal(latestBoundaryPlanEntry(ctxCalls).taskDetails.id, "T002");
    assert.equal(
      latestSetupState(ctxCalls).implementationStatus.completedTaskIds.includes(
        "T001",
      ),
      true,
    );
    assert.equal(
      latestSetupState(ctxCalls).compactionEvents[0].reason,
      "legacy fallback",
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("required gate failure blocks TDD task boundaries without fresh session or compaction", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-command-boundary-"));
  try {
    await writeTddFixtures(
      tempDir,
      [
        "- [ ] T001 P0 Build phase state",
        "- [ ] T002 P1 Render task progress",
      ].join("\n"),
    );
    const { pi, calls: piCalls } = createFakePi({
      exec: async () => ({
        code: 1,
        stdout: `RAW_GATE_OUTPUT:${"x".repeat(3000)}`,
        stderr: "SECRET_TOKEN=do-not-copy",
      }),
    });
    const { ctx, calls: ctxCalls } = createFreshSessionContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await advanceToTdd(piCalls, ctx);

    const sessionsBeforeTask = ctxCalls.newSessions.length;
    const promptsBeforeTask = ctxCalls.replacementUserMessages.length;
    const boundariesBeforeTask =
      latestPersistedState(piCalls).sessionBoundaryEvents.length;
    await finishAssistantTurn(
      piCalls,
      ctx,
      "T001 done.\nRALPH_TDD_TASK_COMPLETE T001",
    );

    const state = latestPersistedState(piCalls);
    assert.equal(piCalls.execs.length, 1);
    assert.equal(state.currentPhase, "tdd_implement");
    assert.equal(state.tddCompletedTasks, 0);
    assert.equal(state.gateResults[0].name, "unit_tests");
    assert.equal(state.gateResults[0].passed, false);
    assert.equal(state.gateResults[0].blocksTransition, true);
    assert.equal(state.sessionBoundaryEvents.length, boundariesBeforeTask);
    assert.equal(ctxCalls.newSessions.length, sessionsBeforeTask);
    assert.equal(ctxCalls.compactions.length, 0);
    assert.equal(ctxCalls.replacementUserMessages.length, promptsBeforeTask);
    assert.match(ctxCalls.widgets.at(-1).value.join("\n"), /unit_tests/);
    assert.match(ctxCalls.widgets.at(-1).value.join("\n"), /blocks transition/);
    assert.match(ctxCalls.notifications.at(-1).message, /gates failed/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("required gate failure blocks TDD review advancement without fresh session or compaction", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-command-boundary-"));
  try {
    await writeTddFixtures(tempDir, "- [x] T001 P0 Build phase state\n");
    const { pi, calls: piCalls } = createFakePi({
      exec: async () => ({
        code: 1,
        stdout: `RAW_GATE_OUTPUT:${"x".repeat(3000)}`,
        stderr: "SECRET_TOKEN=do-not-copy",
      }),
    });
    const { ctx, calls: ctxCalls } = createFreshSessionContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await advanceToTdd(piCalls, ctx);

    const sessionsBeforeAdvance = ctxCalls.newSessions.length;
    const promptsBeforeAdvance = ctxCalls.replacementUserMessages.length;
    const boundariesBeforeAdvance =
      latestPersistedState(piCalls).sessionBoundaryEvents.length;
    await runCommand(piCalls, ctx, "next");

    const state = latestPersistedState(piCalls);
    assert.equal(piCalls.execs.length, 1);
    assert.equal(state.currentPhase, "tdd_implement");
    assert.equal(state.gateResults[0].name, "unit_tests");
    assert.equal(state.gateResults[0].passed, false);
    assert.equal(state.gateResults[0].blocksTransition, true);
    assert.equal(state.sessionBoundaryEvents.length, boundariesBeforeAdvance);
    assert.equal(ctxCalls.newSessions.length, sessionsBeforeAdvance);
    assert.equal(ctxCalls.compactions.length, 0);
    assert.equal(ctxCalls.replacementUserMessages.length, promptsBeforeAdvance);
    assert.match(ctxCalls.widgets.at(-1).value.join("\n"), /unit_tests/);
    assert.match(ctxCalls.widgets.at(-1).value.join("\n"), /blocks transition/);
    assert.match(ctxCalls.notifications.at(-1).message, /gates failed/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("passing TDD review gates create a fresh review session with bounded gate summaries", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-command-boundary-"));
  try {
    await writeTddFixtures(tempDir, "- [x] T001 P0 Build phase state\n");
    const { pi, calls: piCalls } = createFakePi({
      exec: async () => ({
        code: 0,
        stdout: `RAW_GATE_OUTPUT:${"x".repeat(3000)}`,
        stderr: "SECRET_TOKEN=do-not-copy",
      }),
    });
    const { ctx, calls: ctxCalls } = createFreshSessionContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await advanceToTdd(piCalls, ctx);

    const sessionsBeforeAdvance = ctxCalls.newSessions.length;
    await runCommand(piCalls, ctx, "next");

    assert.equal(piCalls.execs.length, 1);
    assert.equal(ctxCalls.newSessions.length, sessionsBeforeAdvance + 1);
    assert.equal(ctxCalls.compactions.length, 0);
    assert.equal(latestPersistedState(piCalls).currentPhase, "review");
    assert.match(
      String(ctxCalls.replacementUserMessages.at(-1).content),
      /# ralph-works Phase: Review/,
    );

    const planEntry = latestBoundaryPlanEntry(ctxCalls);
    assert.equal(planEntry.latestGateSummary.results[0].name, "unit_tests");
    assert.equal(planEntry.latestGateSummary.results[0].passed, true);
    assert.equal(planEntry.latestGateSummary.results[0].stdout, undefined);
    assert.equal(planEntry.latestGateSummary.results[0].stderr, undefined);

    const customMessage = latestCustomMessageEntry(ctxCalls);
    assert.match(customMessage.content, /unit_tests: passed \(required\)/);
    assert.doesNotMatch(customMessage.content, /RAW_GATE_OUTPUT/);
    assert.doesNotMatch(customMessage.content, /SECRET_TOKEN/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("review assistant loopback and LGTM completion use fresh sessions with bounded context", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-command-boundary-"));
  try {
    await writeTddFixtures(
      tempDir,
      "- [ ] T010 P1 Fix review session handoff\n",
    );
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFreshSessionContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await advanceToTdd(piCalls, ctx);
    await runCommand(piCalls, ctx, "next");
    assert.equal(latestPersistedState(piCalls).currentPhase, "review");

    const sessionsBeforeLoopback = ctxCalls.newSessions.length;
    const promptsBeforeLoopback = ctxCalls.replacementUserMessages.length;
    await finishAssistantTurn(
      piCalls,
      ctx,
      [
        "[CRITICAL] Missing regression test for review loopbacks.",
        "SECRET_TOKEN=do-not-copy",
        `Details: ${"x".repeat(2500)}`,
        "RALPH_REVIEW_CHANGES_REQUESTED",
      ].join("\n"),
    );

    const loopbackBoundary =
      latestPersistedState(piCalls).sessionBoundaryEvents.at(-1);
    assert.equal(latestPersistedState(piCalls).currentPhase, "tdd_implement");
    assert.equal(latestPersistedState(piCalls).loopbackCount, 1);
    assert.equal(loopbackBoundary.reason, "review requested changes");
    assert.equal(typeof loopbackBoundary.reviewFeedback, "string");
    assert.match(loopbackBoundary.reviewFeedback, /Missing regression test/);
    assert.doesNotMatch(loopbackBoundary.reviewFeedback, /do-not-copy/);
    assert.equal(loopbackBoundary.reviewFeedback.length <= 2020, true);
    assert.equal(ctxCalls.newSessions.length, sessionsBeforeLoopback);
    assert.equal(
      ctxCalls.replacementUserMessages.length,
      promptsBeforeLoopback,
    );
    assert.deepEqual(piCalls.userMessages.at(-1), {
      content: `/ralph-works continue-boundary ${loopbackBoundary.id}`,
      options: { deliverAs: "followUp" },
    });

    await runCommand(piCalls, ctx, `continue-boundary ${loopbackBoundary.id}`);

    assert.equal(ctxCalls.newSessions.length, sessionsBeforeLoopback + 1);
    assert.equal(ctxCalls.compactions.length, 0);
    const loopbackPrompt = String(
      ctxCalls.replacementUserMessages.at(-1).content,
    );
    assert.match(loopbackPrompt, /Review context:/);
    assert.match(loopbackPrompt, /Missing regression test/);
    assert.match(
      loopbackPrompt,
      /# ralph-works Phase: Red-Green TDD Implement/,
    );
    assert.doesNotMatch(loopbackPrompt, /do-not-copy/);
    const loopbackPlan = latestBoundaryPlanEntry(ctxCalls);
    assert.equal(loopbackPlan.nextActionType, "review_loopback");
    assert.match(
      loopbackPlan.resumeContext.reviewFeedback,
      /Missing regression test/,
    );
    assert.doesNotMatch(
      latestCustomMessageEntry(ctxCalls).content,
      /do-not-copy/,
    );

    await runCommand(piCalls, ctx, "next");
    assert.equal(latestPersistedState(piCalls).currentPhase, "review");
    const sessionsBeforeIgnoredMarker = ctxCalls.newSessions.length;
    const promptsBeforeIgnoredMarker = ctxCalls.replacementUserMessages.length;
    const userMessagesBeforeIgnoredMarker = piCalls.userMessages.length;
    const boundariesBeforeIgnoredMarker =
      latestPersistedState(piCalls).sessionBoundaryEvents.length;

    await finishAssistantTurn(
      piCalls,
      ctx,
      "looks good to me\nRALPH_PHASE_COMPLETE",
    );

    assert.equal(latestPersistedState(piCalls).currentPhase, "review");
    assert.equal(
      latestPersistedState(piCalls).sessionBoundaryEvents.length,
      boundariesBeforeIgnoredMarker,
    );
    assert.equal(ctxCalls.newSessions.length, sessionsBeforeIgnoredMarker);
    assert.equal(
      ctxCalls.replacementUserMessages.length,
      promptsBeforeIgnoredMarker,
    );
    assert.equal(piCalls.userMessages.length, userMessagesBeforeIgnoredMarker);
    assert.match(
      ctxCalls.notifications.at(-1).message,
      /ignored during review/,
    );

    const sessionsBeforeLgtm = ctxCalls.newSessions.length;
    const promptsBeforeLgtm = ctxCalls.replacementUserMessages.length;
    const userMessagesBeforeLgtm = piCalls.userMessages.length;

    await finishAssistantTurn(piCalls, ctx, "LGTM");

    const completionBoundary =
      latestPersistedState(piCalls).sessionBoundaryEvents.at(-1);
    assert.equal(latestPersistedState(piCalls).currentPhase, "complete");
    assert.equal(latestPersistedState(piCalls).pipelineStatus, "completed");
    assert.equal(ctxCalls.newSessions.length, sessionsBeforeLgtm);
    assert.equal(piCalls.userMessages.length, userMessagesBeforeLgtm + 1);
    assert.deepEqual(piCalls.userMessages.at(-1), {
      content: `/ralph-works continue-boundary ${completionBoundary.id}`,
      options: { deliverAs: "followUp" },
    });

    await runCommand(
      piCalls,
      ctx,
      `continue-boundary ${completionBoundary.id}`,
    );

    assert.equal(ctxCalls.newSessions.length, sessionsBeforeLgtm + 1);
    assert.equal(ctxCalls.replacementUserMessages.length, promptsBeforeLgtm);
    assert.equal(
      latestBoundaryPlanEntry(ctxCalls).nextActionType,
      "completion",
    );
    assert.equal(latestSetupState(ctxCalls).pipelineStatus, "completed");
    assert.equal(
      findSessionBoundaryEvent(
        latestSetupState(ctxCalls),
        completionBoundary.id,
      ).status,
      "created",
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("final TDD command creates one review fresh session without redundant task boundary", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-command-boundary-"));
  try {
    await writeTddFixtures(tempDir, "- [ ] T001 P0 Build phase state\n");
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFreshSessionContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await advanceToTdd(piCalls, ctx);

    const sessionsBeforeTask = ctxCalls.newSessions.length;
    await runCommand(piCalls, ctx, "tdd-complete T001");

    assert.equal(ctxCalls.newSessions.length, sessionsBeforeTask + 1);
    assert.equal(ctxCalls.compactions.length, 0);
    assert.equal(latestPersistedState(piCalls).currentPhase, "review");
    assert.match(
      String(ctxCalls.replacementUserMessages.at(-1).content),
      /# ralph-works Phase: Review/,
    );

    const taskBoundaries = latestPersistedState(
      piCalls,
    ).sessionBoundaryEvents.filter((event) => event.taskId === "T001");
    assert.equal(taskBoundaries.length, 1);
    assert.equal(taskBoundaries[0].boundaryType, "phase");
    assert.equal(taskBoundaries[0].fromPhase, "tdd_implement");
    assert.equal(taskBoundaries[0].toPhase, "review");

    const status = await readImplementationStatus(tempDir);
    assert.equal(status.completedTaskIds.includes("T001"), true);
    assert.equal(status.gateResultsByTask.T001[0].passed, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("optional render continuation and final completion use fresh sessions without extra prompts", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-command-boundary-"));
  try {
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFreshSessionContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await runCommand(piCalls, ctx, "start feature-a Build feature A");
    await runCommand(piCalls, ctx, "next");
    await runCommand(piCalls, ctx, "next");
    await runCommand(piCalls, ctx, "next");
    await runCommand(piCalls, ctx, "approve --render-html");

    assert.equal(
      latestPersistedState(piCalls).currentPhase,
      "render_html_optional",
    );
    assert.match(
      String(ctxCalls.replacementUserMessages.at(-1).content),
      /# ralph-works Phase: Optional HTML Render/,
    );

    await runCommand(piCalls, ctx, "next");

    assert.equal(latestPersistedState(piCalls).currentPhase, "create_tasks");
    assert.match(
      String(ctxCalls.replacementUserMessages.at(-1).content),
      /# ralph-works Phase: Task Creation/,
    );

    await runCommand(piCalls, ctx, "next");
    await runCommand(piCalls, ctx, "next");
    assert.equal(latestPersistedState(piCalls).currentPhase, "review");
    assert.match(
      String(ctxCalls.replacementUserMessages.at(-1).content),
      /# ralph-works Phase: Review/,
    );

    const promptsBeforeCompletion = ctxCalls.replacementUserMessages.length;
    await runCommand(piCalls, ctx, "approve");

    assert.equal(latestPersistedState(piCalls).currentPhase, "complete");
    assert.equal(latestPersistedState(piCalls).pipelineStatus, "completed");
    assert.equal(ctxCalls.compactions.length, 0);
    assert.equal(
      ctxCalls.replacementUserMessages.length,
      promptsBeforeCompletion,
    );
    const completionBoundary =
      latestPersistedState(piCalls).sessionBoundaryEvents.at(-1);
    assert.equal(completionBoundary.toPhase, "complete");
    assert.equal(
      findSessionBoundaryEvent(
        latestSetupState(ctxCalls),
        completionBoundary.id,
      ).status,
      "created",
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("fresh-session regression covers every RalphWorks boundary", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-boundary-e2e-"));
  try {
    await writeTddFixtures(
      tempDir,
      [
        "- [ ] T001 P0 Build phase state",
        "- [ ] T002 P1 Render task progress",
      ].join("\n"),
    );
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFreshSessionContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    const records = [];
    const recordLatestBoundary = (label) => {
      const boundary =
        latestPersistedState(piCalls).sessionBoundaryEvents.at(-1);
      const plan = latestBoundaryPlanEntry(ctxCalls);
      const setupEvent = findSessionBoundaryEvent(
        latestSetupState(ctxCalls),
        boundary.id,
      );
      records.push({
        label,
        boundaryType: boundary.boundaryType,
        fromPhase: boundary.fromPhase,
        toPhase: boundary.toPhase,
        taskId: boundary.taskId,
        nextTaskId: boundary.nextTaskId,
        nextActionType: plan.nextActionType,
        status: setupEvent?.status,
      });
    };

    await runCommand(piCalls, ctx, "start feature-a Build feature A");
    recordLatestBoundary("pipeline start");

    await runCommand(piCalls, ctx, "next");
    recordLatestBoundary("phase transition to red_team");

    await runCommand(piCalls, ctx, "next");
    recordLatestBoundary("phase transition to harden_spec");

    const promptsBeforeApprovalPause = ctxCalls.replacementUserMessages.length;
    await runCommand(piCalls, ctx, "next");
    recordLatestBoundary("harden approval pause");
    assert.equal(
      ctxCalls.replacementUserMessages.length,
      promptsBeforeApprovalPause,
    );

    await runCommand(piCalls, ctx, "approve --render-html");
    recordLatestBoundary("approval continuation to render_html_optional");

    await runCommand(piCalls, ctx, "next");
    recordLatestBoundary("optional render continuation to create_tasks");

    await runCommand(piCalls, ctx, "next");
    recordLatestBoundary("phase transition to tdd_implement");

    const sessionsBeforeTddMarker = ctxCalls.newSessions.length;
    await finishAssistantTurn(
      piCalls,
      ctx,
      "T001 done.\nRALPH_TDD_TASK_COMPLETE T001",
    );
    const taskBoundary =
      latestPersistedState(piCalls).sessionBoundaryEvents.at(-1);
    assert.equal(ctxCalls.newSessions.length, sessionsBeforeTddMarker);
    assert.deepEqual(piCalls.userMessages.at(-1), {
      content: `/ralph-works continue-boundary ${taskBoundary.id}`,
      options: { deliverAs: "followUp" },
    });
    await runCommand(piCalls, ctx, `continue-boundary ${taskBoundary.id}`);
    recordLatestBoundary("TDD next-task boundary");

    await runCommand(piCalls, ctx, "tdd-complete T002");
    recordLatestBoundary("final TDD-to-review boundary");

    const sessionsBeforeLoopback = ctxCalls.newSessions.length;
    await finishAssistantTurn(
      piCalls,
      ctx,
      "[CRITICAL] Missing regression test.\nRALPH_REVIEW_CHANGES_REQUESTED",
    );
    const loopbackBoundary =
      latestPersistedState(piCalls).sessionBoundaryEvents.at(-1);
    assert.equal(ctxCalls.newSessions.length, sessionsBeforeLoopback);
    assert.deepEqual(piCalls.userMessages.at(-1), {
      content: `/ralph-works continue-boundary ${loopbackBoundary.id}`,
      options: { deliverAs: "followUp" },
    });
    await runCommand(piCalls, ctx, `continue-boundary ${loopbackBoundary.id}`);
    recordLatestBoundary("review loopback boundary");

    await runCommand(piCalls, ctx, "next");
    recordLatestBoundary("post-loopback review boundary");

    const promptsBeforeCompletion = ctxCalls.replacementUserMessages.length;
    const sessionsBeforeLgtm = ctxCalls.newSessions.length;
    await finishAssistantTurn(piCalls, ctx, "LGTM");
    const finalBoundary =
      latestPersistedState(piCalls).sessionBoundaryEvents.at(-1);
    assert.equal(ctxCalls.newSessions.length, sessionsBeforeLgtm);
    assert.deepEqual(piCalls.userMessages.at(-1), {
      content: `/ralph-works continue-boundary ${finalBoundary.id}`,
      options: { deliverAs: "followUp" },
    });
    await runCommand(piCalls, ctx, `continue-boundary ${finalBoundary.id}`);
    recordLatestBoundary("final completion boundary");
    assert.equal(
      ctxCalls.replacementUserMessages.length,
      promptsBeforeCompletion,
    );

    assert.deepEqual(records, [
      {
        label: "pipeline start",
        boundaryType: "phase",
        fromPhase: undefined,
        toPhase: "generate_spec",
        taskId: undefined,
        nextTaskId: undefined,
        nextActionType: "phase_prompt",
        status: "created",
      },
      {
        label: "phase transition to red_team",
        boundaryType: "phase",
        fromPhase: "generate_spec",
        toPhase: "red_team",
        taskId: undefined,
        nextTaskId: undefined,
        nextActionType: "phase_prompt",
        status: "created",
      },
      {
        label: "phase transition to harden_spec",
        boundaryType: "phase",
        fromPhase: "red_team",
        toPhase: "harden_spec",
        taskId: undefined,
        nextTaskId: undefined,
        nextActionType: "phase_prompt",
        status: "created",
      },
      {
        label: "harden approval pause",
        boundaryType: "phase",
        fromPhase: "harden_spec",
        toPhase: "harden_spec",
        taskId: undefined,
        nextTaskId: undefined,
        nextActionType: "approval_pause",
        status: "created",
      },
      {
        label: "approval continuation to render_html_optional",
        boundaryType: "phase",
        fromPhase: "harden_spec",
        toPhase: "render_html_optional",
        taskId: undefined,
        nextTaskId: undefined,
        nextActionType: "phase_prompt",
        status: "created",
      },
      {
        label: "optional render continuation to create_tasks",
        boundaryType: "phase",
        fromPhase: "render_html_optional",
        toPhase: "create_tasks",
        taskId: undefined,
        nextTaskId: undefined,
        nextActionType: "phase_prompt",
        status: "created",
      },
      {
        label: "phase transition to tdd_implement",
        boundaryType: "phase",
        fromPhase: "create_tasks",
        toPhase: "tdd_implement",
        taskId: undefined,
        nextTaskId: undefined,
        nextActionType: "phase_prompt",
        status: "created",
      },
      {
        label: "TDD next-task boundary",
        boundaryType: "task",
        fromPhase: "tdd_implement",
        toPhase: undefined,
        taskId: "T001",
        nextTaskId: "T002",
        nextActionType: "tdd_task_prompt",
        status: "created",
      },
      {
        label: "final TDD-to-review boundary",
        boundaryType: "phase",
        fromPhase: "tdd_implement",
        toPhase: "review",
        taskId: "T002",
        nextTaskId: undefined,
        nextActionType: "phase_prompt",
        status: "created",
      },
      {
        label: "review loopback boundary",
        boundaryType: "phase",
        fromPhase: "review",
        toPhase: "tdd_implement",
        taskId: undefined,
        nextTaskId: undefined,
        nextActionType: "review_loopback",
        status: "created",
      },
      {
        label: "post-loopback review boundary",
        boundaryType: "phase",
        fromPhase: "tdd_implement",
        toPhase: "review",
        taskId: undefined,
        nextTaskId: undefined,
        nextActionType: "phase_prompt",
        status: "created",
      },
      {
        label: "final completion boundary",
        boundaryType: "phase",
        fromPhase: "review",
        toPhase: "complete",
        taskId: undefined,
        nextTaskId: undefined,
        nextActionType: "completion",
        status: "created",
      },
    ]);
    assert.equal(ctxCalls.newSessions.length, records.length);
    assert.equal(ctxCalls.waits, records.length);
    assert.equal(ctxCalls.compactions.length, 0);
    assert.equal(
      piCalls.userMessages.some((message) =>
        /# ralph-works Phase/.test(String(message.content)),
      ),
      false,
    );
    assert.ok(
      ctxCalls.widgets.filter((widget) => widget.replacement).length >=
        records.length,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
