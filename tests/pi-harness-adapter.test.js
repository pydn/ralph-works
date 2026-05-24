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

test("ralph-works status command renders the calm TUI widget", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-adapter-"));
  try {
    const { pi, calls: piCalls } = createFakePi();
    const { ctx, calls: ctxCalls } = createFakeContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    await piCalls.commands.get("ralph-works").handler("status", ctx);

    assert.equal(ctxCalls.statuses.at(-1).key, "ralph-works");
    assert.match(ctxCalls.statuses.at(-1).value, /Generate Spec/);
    const widgetText = ctxCalls.widgets.at(-1).value.join("\n");
    assert.match(stripAnsi(widgetText), /ralph-works · RUNNING/);
    assert.match(stripAnsi(widgetText), /▶ 1\/8 Generate Spec/);
    assert.match(widgetText, /\u001b\[38;2;/);
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

    await piCalls.commands.get("ralph-works").handler("next", ctx);

    assert.equal(piCalls.models[0].provider, "openai");
    assert.equal(piCalls.models[0].id, "red-team-model");
    assert.equal(piCalls.appended.at(-1).customType, "ralph-works-state");
    assert.equal(piCalls.appended.at(-1).data.currentPhase, "red_team");
    assert.equal(ctxCalls.compactions.length, 1);
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
    const { ctx } = createFakeContext(tempDir);
    registerRalphWorksExtension(pi, { extensionRoot: path.resolve(".") });

    for (let index = 0; index < 5; index += 1) {
      await piCalls.commands.get("ralph-works").handler("next", ctx);
    }
    const modelSelectionsBeforeLoopback = piCalls.models.length;
    await piCalls.commands.get("ralph-works").handler("loopback critical bugs", ctx);

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
