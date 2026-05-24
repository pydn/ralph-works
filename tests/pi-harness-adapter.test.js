import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { registerRalphWorksExtension } from "../src/harness/pi-harness-adapter.js";

function createFakePi({ exec = async () => ({ code: 0, stdout: "ok", stderr: "" }) } = {}) {
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

function createFakeContext(cwd) {
  const calls = {
    statuses: [],
    widgets: [],
    notifications: [],
    compactions: [],
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
          return [];
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
    },
  };
}

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function latestState(piCalls) {
  return piCalls.appended.at(-1)?.data;
}

async function startPipeline(piCalls, ctx, args = "start feature-a Build feature A") {
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

async function completeLatestCompaction(ctxCalls) {
  const compaction = ctxCalls.compactions.at(-1);
  assert.equal(typeof compaction?.onComplete, "function");
  await compaction.onComplete();
}

test("extension registers ralph-works command, tools, and skill discovery", async () => {
  const { pi, calls } = createFakePi();

  registerRalphWorksExtension(pi, {
    extensionRoot: path.resolve("."),
  });

  assert.equal(calls.commands.has("ralph-works"), true);
  assert.equal(calls.tools.some((tool) => tool.name === "ralph_works_status"), true);

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
      message: "No active ralph-works pipeline. Start one with /ralph-works start <feature> [prompt].",
      level: "info",
    });
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
    assert.match(String(piCalls.userMessages[0].content), /# ralph-works Phase: Generate Spec/);
    assert.match(String(piCalls.userMessages[0].content), /<ralph-skill-instructions>/);
    assert.match(String(piCalls.userMessages[0].content), /docs\/feature-a-generated-spec\.md/);
    assert.match(String(piCalls.userMessages[0].content), /RALPH_PHASE_COMPLETE/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("phase completion automatically launches the next phase prompt", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
  try {
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await startPipeline(piCalls, ctx);
    await finishAssistantTurn(piCalls, ctx, "Spec complete.\nRALPH_PHASE_COMPLETE");

    assert.equal(latestState(piCalls).currentPhase, "red_team");
    assert.equal(latestState(piCalls).phaseStatus, "executing");
    assert.equal(ctxCalls.compactions.length, 1);
    assert.equal(piCalls.userMessages.length, 1);

    await completeLatestCompaction(ctxCalls);

    assert.equal(latestState(piCalls).currentPhase, "red_team");
    assert.equal(latestState(piCalls).phaseStatus, "executing");
    assert.equal(piCalls.userMessages.length, 2);
    assert.match(String(piCalls.userMessages.at(-1).content), /# ralph-works Phase: Red Team Pass/);
    assert.match(String(piCalls.userMessages.at(-1).content), /docs\/feature-a-generated-spec\.md/);
    assert.match(String(piCalls.userMessages.at(-1).content), /docs\/feature-a-red-team-findings\.md/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("harden spec completion pauses for explicit user approval", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
  try {
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await startPipeline(piCalls, ctx);
    await finishAssistantTurn(piCalls, ctx, "Spec complete.\nRALPH_PHASE_COMPLETE");
    await completeLatestCompaction(ctxCalls);
    await finishAssistantTurn(piCalls, ctx, "Red team complete.\nRALPH_PHASE_COMPLETE");
    await completeLatestCompaction(ctxCalls);
    const messagesBeforeHardenCompletion = piCalls.userMessages.length;
    await finishAssistantTurn(piCalls, ctx, "Hardened spec complete.\nRALPH_PHASE_COMPLETE");

    assert.equal(latestState(piCalls).currentPhase, "harden_spec");
    assert.equal(latestState(piCalls).phaseStatus, "awaiting_harden_approval");
    assert.equal(piCalls.userMessages.length, messagesBeforeHardenCompletion);
    assert.match(ctxCalls.notifications.at(-1).message, /Approve the hardened spec/);

    await piCalls.commands.get("ralph-works").handler("approve", ctx);
    await completeLatestCompaction(ctxCalls);

    assert.equal(latestState(piCalls).currentPhase, "create_tasks");
    assert.equal(latestState(piCalls).phaseStatus, "executing");
    assert.match(String(piCalls.userMessages.at(-1).content), /# ralph-works Phase: Task Creation/);
    assert.match(String(piCalls.userMessages.at(-1).content), /docs\/feature-a-hardened-spec\.md/);
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
    await finishAssistantTurn(piCalls, ctx, "Spec complete.\nRALPH_PHASE_COMPLETE");
    await completeLatestCompaction(ctxCalls);
    await finishAssistantTurn(piCalls, ctx, "Red team complete.\nRALPH_PHASE_COMPLETE");
    await completeLatestCompaction(ctxCalls);
    await finishAssistantTurn(piCalls, ctx, "Hardened spec complete.\nRALPH_PHASE_COMPLETE");
    await piCalls.commands.get("ralph-works").handler("approve", ctx);
    await completeLatestCompaction(ctxCalls);
    await finishAssistantTurn(piCalls, ctx, "Tasks complete.\nRALPH_PHASE_COMPLETE");
    await completeLatestCompaction(ctxCalls);
    assert.equal(latestState(piCalls).currentPhase, "tdd_implement");

    await finishAssistantTurn(piCalls, ctx, "Implementation complete.\nRALPH_PHASE_COMPLETE");
    await completeLatestCompaction(ctxCalls);
    assert.equal(latestState(piCalls).currentPhase, "review");
    assert.match(String(piCalls.userMessages.at(-1).content), /# ralph-works Phase: Review/);

    await finishAssistantTurn(piCalls, ctx, "[CRITICAL] Missing regression test.");
    await completeLatestCompaction(ctxCalls);
    assert.equal(latestState(piCalls).currentPhase, "tdd_implement");
    assert.equal(latestState(piCalls).loopbackCount, 1);
    assert.match(String(piCalls.userMessages.at(-1).content), /Review requested changes/);
    assert.match(String(piCalls.userMessages.at(-1).content), /# ralph-works Phase: Red-Green TDD Implement/);

    await finishAssistantTurn(piCalls, ctx, "Fixed.\nRALPH_PHASE_COMPLETE");
    await completeLatestCompaction(ctxCalls);
    assert.equal(latestState(piCalls).currentPhase, "review");
    await finishAssistantTurn(piCalls, ctx, "LGTM. No critical bugs found.");

    assert.equal(latestState(piCalls).currentPhase, "complete");
    assert.equal(latestState(piCalls).pipelineStatus, "completed");
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
    await finishAssistantTurn(piCalls, ctx, "Spec complete.\nRALPH_PHASE_COMPLETE");
    await completeLatestCompaction(ctxCalls);
    await finishAssistantTurn(piCalls, ctx, "Red team complete.\nRALPH_PHASE_COMPLETE");
    await completeLatestCompaction(ctxCalls);
    await finishAssistantTurn(piCalls, ctx, "Hardened spec complete.\nRALPH_PHASE_COMPLETE");
    await piCalls.commands.get("ralph-works").handler("approve", ctx);
    await completeLatestCompaction(ctxCalls);
    await finishAssistantTurn(piCalls, ctx, "Tasks complete.\nRALPH_PHASE_COMPLETE");
    await completeLatestCompaction(ctxCalls);
    await finishAssistantTurn(piCalls, ctx, "Implementation complete.\nRALPH_PHASE_COMPLETE");
    await completeLatestCompaction(ctxCalls);

    await finishAssistantTurn(piCalls, ctx, "looks good to me\nRALPH_PHASE_COMPLETE");

    assert.equal(latestState(piCalls).currentPhase, "review");
    assert.equal(latestState(piCalls).pipelineStatus, "running");
    assert.match(ctxCalls.notifications.at(-1).message, /LGTM/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ralph-works next advances phase, routes configured model, stores state, and compacts", async () => {
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
    assert.equal(ctxCalls.compactions.length, 1);
    await completeLatestCompaction(ctxCalls);

    assert.equal(piCalls.models.at(-1).provider, "openai");
    assert.equal(piCalls.models.at(-1).id, "red-team-model");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ralph_works_transition tool stores state and compacts phase boundaries", async () => {
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
    assert.equal(piCalls.appended.at(-1).data.currentPhase, "red_team");
    assert.equal(ctxCalls.compactions.length, 1);
    assert.equal(ctxCalls.compactions[0].customInstructions.includes("Boundary: phase"), true);
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

    await startPipeline(piCalls, ctx);
    for (let index = 0; index < 5; index += 1) {
      await piCalls.commands.get("ralph-works").handler("next", ctx);
    }
    const modelSelectionsBeforeLoopback = piCalls.models.length;
    await piCalls.commands.get("ralph-works").handler("loopback critical bugs", ctx);
    await completeLatestCompaction(ctxCalls);

    assert.equal(piCalls.models.length, modelSelectionsBeforeLoopback + 1);
    assert.equal(piCalls.models.at(-1).provider, "openai");
    assert.equal(piCalls.models.at(-1).id, "tdd-model");
    assert.equal(piCalls.appended.at(-1).data.currentPhase, "tdd_implement");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ralph-works tdd-complete runs gates, records task completion, and compacts task", async () => {
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

    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await startPipeline(piCalls, ctx);
    for (let index = 0; index < 4; index += 1) {
      await piCalls.commands.get("ralph-works").handler("next", ctx);
    }
    await piCalls.commands.get("ralph-works").handler("tdd-complete T001", ctx);

    assert.equal(piCalls.appended.at(-1).data.tddCompletedTasks, 1);
    assert.equal(
      piCalls.appended.at(-1).data.implementationStatus.completedTaskIds[0],
      "T001",
    );
    assert.equal(ctxCalls.compactions.at(-1).customInstructions.includes("Boundary: task"), true);
    assert.match(ctxCalls.widgets.at(-1).value.join("\n"), /unit_tests/);
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

    const { pi, calls: piCalls } = createFakePi({
      exec: async () => ({ code: 1, stdout: "", stderr: "failed" }),
    });
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await startPipeline(piCalls, ctx);
    for (let index = 0; index < 4; index += 1) {
      await piCalls.commands.get("ralph-works").handler("next", ctx);
    }
    const compactionsBefore = ctxCalls.compactions.length;
    await piCalls.commands.get("ralph-works").handler("tdd-complete T001", ctx);

    assert.equal(piCalls.appended.at(-1).data.tddCompletedTasks, 0);
    assert.equal(ctxCalls.compactions.length, compactionsBefore);
    assert.match(ctxCalls.notifications.at(-1).message, /gates failed/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
