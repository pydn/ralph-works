import path from "node:path";
import { fileURLToPath } from "node:url";

import { recordCompactionEvent } from "../artifacts/compaction-summary.js";
import { recordArtifact } from "../artifacts/artifact-tracker.js";
import { requiredGatesPassed } from "../gates/gate-result.js";
import { createPhaseState } from "../state/phase-state.js";
import { applyPhaseCommand } from "./pi-phase-event-handler.js";
import { createImplementationStatus, markTaskComplete } from "../tasks/task-status-updater.js";
import { splitCommandArgs } from "./pi-argument-parser.js";
import { triggerRalphWorksCompaction } from "./pi-compaction-trigger.js";
import { runPiConfiguredGates } from "./pi-gate-runner.js";
import {
  getActivePhaseModelName,
  routeModelForCurrentPhase,
} from "./pi-model-router.js";
import {
  persistRalphWorksState,
  restoreRalphWorksState,
} from "./pi-state-persistence.js";
import { createToolResult } from "./pi-tool-result.js";
import { updateRalphWorksTui } from "./pi-tui-updater.js";

const DEFAULT_EXTENSION_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export function registerRalphWorksExtension(
  pi,
  { extensionRoot = DEFAULT_EXTENSION_ROOT } = {},
) {
  let state = createPhaseState();
  let implementationStatus = createImplementationStatus();

  async function showStatus(ctx) {
    const activeModel = await getActivePhaseModelName(ctx, state);
    updateRalphWorksTui(ctx, state, activeModel);
    return state;
  }

  async function commitPhaseBoundary(ctx, reason) {
    const activeModel = await routeModelForCurrentPhase(pi, ctx, state);
    state = recordCompactionEvent(state, {
      boundary: "phase",
      reason,
    });
    persistRalphWorksState(pi, state);
    updateRalphWorksTui(ctx, state, activeModel);
    triggerRalphWorksCompaction(ctx, state, "phase", reason);
    return state;
  }

  async function advanceWorkflow(ctx, commandArgs) {
    state = applyPhaseCommand(state, "next", commandArgs);
    await commitPhaseBoundary(ctx, `entered ${state.currentPhase}`);
    return state;
  }

  async function recordWorkflowArtifact(ctx, commandArgs) {
    const [artifactKey, artifactPath] = commandArgs;
    state = recordArtifact(state, artifactKey, artifactPath);
    persistRalphWorksState(pi, state);
    await showStatus(ctx);
    return state;
  }

  async function runGates(ctx) {
    const gateResults = await runPiConfiguredGates(pi, ctx);

    state = {
      ...state,
      gateResults,
    };
    persistRalphWorksState(pi, state);
    await showStatus(ctx);
    return gateResults;
  }

  async function completeTddTask(ctx, commandArgs) {
    const taskId = commandArgs[0];
    if (!taskId) {
      throw new Error("Usage: /ralph-works tdd-complete <task-id>");
    }

    const gateResults = await runGates(ctx);
    if (!requiredGatesPassed(gateResults)) {
      ctx.ui?.notify?.("ralph-works gates failed; task remains incomplete.", "error");
      return state;
    }

    implementationStatus = markTaskComplete(implementationStatus, taskId, {
      gateResults,
    });
    state = {
      ...state,
      tddCompletedTasks: state.tddCompletedTasks + 1,
      implementationStatus,
    };
    state = recordCompactionEvent(state, {
      boundary: "task",
      reason: `completed ${taskId}`,
    });
    persistRalphWorksState(pi, state);
    await showStatus(ctx);
    triggerRalphWorksCompaction(ctx, state, "task", `completed ${taskId}`);
    return state;
  }

  async function handleCommand(args, ctx) {
    const [command = "status", ...commandArgs] = splitCommandArgs(args);

    if (command === "status") {
      await showStatus(ctx);
      return;
    }
    if (command === "help") {
      ctx.ui?.notify?.(
        "Commands: status, next, gates, tdd-complete <task-id>, artifact <key> <path>, loopback, approve, reset",
        "info",
      );
      await showStatus(ctx);
      return;
    }
    if (command === "next") {
      await advanceWorkflow(ctx, commandArgs);
      return;
    }
    if (command === "gates") {
      await runGates(ctx);
      return;
    }
    if (command === "tdd-complete") {
      await completeTddTask(ctx, commandArgs);
      return;
    }
    if (command === "artifact") {
      await recordWorkflowArtifact(ctx, commandArgs);
      return;
    }
    if (command === "loopback" || command === "approve") {
      state = applyPhaseCommand(state, command, commandArgs);
      await commitPhaseBoundary(ctx, command);
      return;
    }
    if (command === "reset") {
      state = createPhaseState();
      implementationStatus = createImplementationStatus();
      persistRalphWorksState(pi, state);
      await showStatus(ctx);
      return;
    }

    throw new Error(`Unknown /ralph-works command: ${command}`);
  }

  pi.on("session_start", async (_event, ctx) => {
    state = restoreRalphWorksState(ctx);
    await showStatus(ctx);
  });

  pi.on("resources_discover", async () => ({
    skillPaths: [path.join(extensionRoot, "skills")],
  }));

  pi.registerCommand("ralph-works", {
    description: "Show and advance the RalphWorks workflow.",
    getArgumentCompletions(prefix) {
      const commands = [
        "status",
        "next",
        "next --render-html",
        "gates",
        "tdd-complete",
        "artifact",
        "loopback",
        "approve",
        "reset",
        "help",
      ];
      return commands
        .filter((command) => command.startsWith(prefix))
        .map((command) => ({ value: command, label: command }));
    },
    handler: handleCommand,
  });

  pi.registerTool({
    name: "ralph_works_status",
    label: "RalphWorks Status",
    description: "Return the current ralph-works workflow state.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      await showStatus(ctx);
      return createToolResult(`ralph-works phase: ${state.currentPhase}`, state);
    },
  });

  pi.registerTool({
    name: "ralph_works_transition",
    label: "RalphWorks Transition",
    description: "Advance ralph-works to the next legal workflow phase.",
    parameters: {
      type: "object",
      properties: {
        renderHtml: { type: "boolean" },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      state = applyPhaseCommand(
        state,
        "next",
        params.renderHtml ? ["--render-html"] : [],
      );
      await commitPhaseBoundary(ctx, `entered ${state.currentPhase}`);
      return createToolResult(`ralph-works phase: ${state.currentPhase}`, state);
    },
  });

  pi.registerTool({
    name: "ralph_works_record_artifact",
    label: "RalphWorks Artifact",
    description: "Record a ralph-works workflow artifact path.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string" },
        path: { type: "string" },
      },
      required: ["key", "path"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      state = recordArtifact(state, params.key, params.path);
      persistRalphWorksState(pi, state);
      await showStatus(ctx);
      return createToolResult(`recorded ${params.key}: ${params.path}`, state);
    },
  });
}
