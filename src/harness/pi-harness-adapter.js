import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { recordCompactionEvent } from "../artifacts/compaction-summary.js";
import { recordArtifact } from "../artifacts/artifact-tracker.js";
import { requiredGatesPassed } from "../gates/gate-result.js";
import { buildPhasePrompt } from "../prompts/phase-prompt-builder.js";
import {
  HARDEN_APPROVAL_STATUS,
  getTddTaskCompletionMarkerTaskId,
  hasPhaseCompletionMarker,
  isLgtmReview,
  requestsReviewLoopback,
} from "../state/phase-completion.js";
import { createPhaseState } from "../state/phase-state.js";
import {
  advancePhase,
  transitionToPhase,
} from "../state/phase-transitions.js";
import { parseTaskList } from "../tasks/task-list-loader.js";
import { selectNextTask } from "../tasks/task-selector.js";
import {
  createImplementationStatus,
  markTaskComplete,
} from "../tasks/task-status-updater.js";
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
const NO_ACTIVE_PIPELINE_MESSAGE =
  "No active ralph-works pipeline. Start one with /ralph-works start <feature> [prompt].";
const HARDEN_APPROVAL_MESSAGE =
  "Approve the hardened spec with /ralph-works approve to continue to implementation planning, or /ralph-works approve --render-html to render HTML first.";
const HELP_MESSAGE = [
  "Commands:",
  "/ralph-works start <feature> [prompt]",
  "/ralph-works status",
  "/ralph-works next",
  "/ralph-works next --render-html",
  "/ralph-works gates",
  "/ralph-works tdd-complete <task-id>",
  "/ralph-works artifact <key> <path>",
  "/ralph-works loopback [reason]",
  "/ralph-works approve",
  "/ralph-works approve --render-html",
  "/ralph-works reset",
  "/ralph-works help",
].join("\n");

function extractMessageText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function readTaskList(ctx, workflowState) {
  const taskListPath = workflowState.phases.find(
    (phase) => phase.id === "create_tasks",
  )?.artifactPath;
  if (!taskListPath) {
    return [];
  }

  try {
    const absolutePath = path.resolve(ctx.cwd ?? process.cwd(), taskListPath);
    return parseTaskList(readFileSync(absolutePath, "utf8"));
  } catch {
    return [];
  }
}

export function registerRalphWorksExtension(
  pi,
  { extensionRoot = DEFAULT_EXTENSION_ROOT } = {},
) {
  let state;
  let implementationStatus = createImplementationStatus();

  function notifyNoActivePipeline(ctx) {
    ctx.ui?.notify?.(NO_ACTIVE_PIPELINE_MESSAGE, "info");
  }

  async function showStatus(ctx) {
    if (!state) {
      notifyNoActivePipeline(ctx);
      return undefined;
    }

    const activeModel = await getActivePhaseModelName(ctx, state);
    updateRalphWorksTui(ctx, state, activeModel);
    return state;
  }

  async function launchCurrentPhase(ctx, { prefixText, delivery } = {}) {
    if (!state) {
      return undefined;
    }

    const activeModel = await routeModelForCurrentPhase(pi, ctx, state);
    state = {
      ...state,
      pipelineStatus: "running",
      phaseStatus: "executing",
    };
    persistRalphWorksState(pi, state);
    updateRalphWorksTui(ctx, state, activeModel);

    const prompt = buildPhasePrompt(state, { extensionRoot });
    const content = prefixText ? `${prefixText}\n\n${prompt}` : prompt;
    pi.sendUserMessage?.(
      content,
      delivery ? { deliverAs: delivery } : undefined,
    );
    return state;
  }

  async function enterPhase(ctx, nextState, { reason, prefixText } = {}) {
    state = recordCompactionEvent(nextState, {
      boundary: "phase",
      reason,
    });
    persistRalphWorksState(pi, state);
    updateRalphWorksTui(ctx, state, await getActivePhaseModelName(ctx, state));

    let launched = false;
    const launchAfterCompaction = async () => {
      if (launched) {
        return state;
      }
      launched = true;
      return launchCurrentPhase(ctx, {
        prefixText,
        delivery: "followUp",
      });
    };

    const compactStarted = triggerRalphWorksCompaction(ctx, state, "phase", reason, {
      onComplete: launchAfterCompaction,
      onError: launchAfterCompaction,
    });
    if (!compactStarted) {
      return launchAfterCompaction();
    }

    return state;
  }

  async function pauseForHardenApproval(ctx) {
    if (!state) {
      return undefined;
    }

    if (state.phaseStatus === HARDEN_APPROVAL_STATUS) {
      ctx.ui?.notify?.(
        `Hardened spec is waiting for approval. ${HARDEN_APPROVAL_MESSAGE}`,
        "warning",
      );
      return state;
    }

    state = recordCompactionEvent(state, {
      boundary: "phase",
      reason: "hardened spec awaiting approval",
    });
    state = {
      ...state,
      phaseStatus: HARDEN_APPROVAL_STATUS,
    };
    persistRalphWorksState(pi, state);
    updateRalphWorksTui(ctx, state, await getActivePhaseModelName(ctx, state));
    triggerRalphWorksCompaction(
      ctx,
      state,
      "phase",
      "hardened spec awaiting approval",
    );
    ctx.ui?.notify?.(
      HARDEN_APPROVAL_MESSAGE,
      "warning",
    );
    return state;
  }

  async function advanceToNextPhase(ctx, commandArgs, reason) {
    if (!state) {
      return undefined;
    }

    if (state.currentPhase === "harden_spec") {
      return pauseForHardenApproval(ctx);
    }

    const nextState = advancePhase(state, {
      renderHtml: commandArgs.includes("--render-html"),
      reason,
    });
    return enterPhase(ctx, nextState, {
      reason: `entered ${nextState.currentPhase}`,
    });
  }

  async function startWorkflow(ctx, commandArgs) {
    const [feature, ...promptParts] = commandArgs;
    if (!feature) {
      ctx.ui?.notify?.("Usage: /ralph-works start <feature> [prompt]", "error");
      return undefined;
    }
    if (state?.pipelineStatus === "running") {
      ctx.ui?.notify?.(
        "A ralph-works pipeline is already running. Reset it before starting another.",
        "error",
      );
      return state;
    }

    state = createPhaseState({
      feature,
      promptText: promptParts.join(" ") || undefined,
    });
    implementationStatus = createImplementationStatus();
    return launchCurrentPhase(ctx);
  }

  async function completePipeline(ctx, reason) {
    if (!state) {
      return undefined;
    }

    state = state.currentPhase === "complete"
      ? state
      : transitionToPhase(state, "complete", { reason });
    state = {
      ...state,
      pipelineStatus: "completed",
      phaseStatus: "post_hook",
    };
    persistRalphWorksState(pi, state);
    updateRalphWorksTui(ctx, state, await getActivePhaseModelName(ctx, state));
    ctx.ui?.notify?.("ralph-works pipeline complete.", "info");
    return state;
  }

  async function advanceWorkflow(ctx, commandArgs) {
    if (!state) {
      notifyNoActivePipeline(ctx);
      return undefined;
    }

    return advanceToNextPhase(ctx, commandArgs, "command:next");
  }

  async function recordWorkflowArtifact(ctx, commandArgs) {
    if (!state) {
      notifyNoActivePipeline(ctx);
      return undefined;
    }

    const [artifactKey, artifactPath] = commandArgs;
    state = recordArtifact(state, artifactKey, artifactPath);
    persistRalphWorksState(pi, state);
    await showStatus(ctx);
    return state;
  }

  async function runGates(ctx) {
    if (!state) {
      notifyNoActivePipeline(ctx);
      return [];
    }

    const gateResults = await runPiConfiguredGates(pi, ctx);
    state = {
      ...state,
      gateResults,
    };
    persistRalphWorksState(pi, state);
    await showStatus(ctx);
    return gateResults;
  }

  async function continueAfterTddTaskCompaction(ctx) {
    if (!state || state.currentPhase !== "tdd_implement") {
      return state;
    }

    const tasks = readTaskList(ctx, state);
    const nextTask = tasks.length > 0
      ? selectNextTask(tasks, implementationStatus)
      : undefined;

    if (tasks.length === 0 || nextTask) {
      return launchCurrentPhase(ctx, {
        prefixText: "Continue TDD implementation with the next incomplete task.",
        delivery: "followUp",
      });
    }

    const nextState = advancePhase(state, {
      reason: "completed tdd_implement",
    });
    return enterPhase(ctx, nextState, {
      reason: `entered ${nextState.currentPhase}`,
    });
  }

  async function completeTddTask(ctx, taskId) {
    if (!state) {
      notifyNoActivePipeline(ctx);
      return undefined;
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

    let continued = false;
    const continueOnce = async () => {
      if (continued) {
        return state;
      }
      continued = true;
      return continueAfterTddTaskCompaction(ctx);
    };
    const compactStarted = triggerRalphWorksCompaction(
      ctx,
      state,
      "task",
      `completed ${taskId}`,
      {
        onComplete: continueOnce,
        onError: continueOnce,
      },
    );
    if (!compactStarted) {
      return continueOnce();
    }
    return state;
  }

  async function handlePhaseCompleteSignal(ctx) {
    if (!state) {
      return undefined;
    }

    if (state.currentPhase === "complete") {
      return completePipeline(ctx, "LGTM");
    }

    if (state.currentPhase === "review") {
      ctx.ui?.notify?.(
        "Review approval must end with LGTM; RALPH_PHASE_COMPLETE is ignored during review.",
        "warning",
      );
      return state;
    }

    if (state.currentPhase === "harden_spec") {
      return pauseForHardenApproval(ctx);
    }

    if (state.currentPhase === "tdd_implement") {
      const gateResults = await runPiConfiguredGates(pi, ctx);
      state = {
        ...state,
        gateResults,
      };
      persistRalphWorksState(pi, state);
      updateRalphWorksTui(ctx, state, await getActivePhaseModelName(ctx, state));
      if (!requiredGatesPassed(gateResults)) {
        ctx.ui?.notify?.(
          "ralph-works gates failed; review phase will not start.",
          "error",
        );
        return state;
      }
    }

    const nextState = advancePhase(state, {
      reason: `completed ${state.currentPhase}`,
    });
    return enterPhase(ctx, nextState, {
      reason: `entered ${nextState.currentPhase}`,
    });
  }

  async function handleReviewTurn(ctx, assistantText) {
    if (!state || state.currentPhase !== "review") {
      return false;
    }

    if (isLgtmReview(assistantText)) {
      await completePipeline(ctx, "review LGTM");
      return true;
    }

    if (requestsReviewLoopback(assistantText)) {
      const nextState = transitionToPhase(state, "tdd_implement", {
        reason: "review requested changes",
      });
      await enterPhase(ctx, nextState, {
        reason: "review requested changes",
        prefixText: "Review requested changes; return to TDD implementation.",
      });
      return true;
    }

    return false;
  }

  async function handleAgentEnd(event, ctx) {
    if (!state || state.pipelineStatus !== "running") {
      return;
    }

    const lastAssistantMessage = [...(event.messages ?? [])]
      .reverse()
      .find((message) => message.role === "assistant");
    const assistantText = extractMessageText(lastAssistantMessage?.content);

    if (await handleReviewTurn(ctx, assistantText)) {
      return;
    }

    const tddTaskId = state.currentPhase === "tdd_implement"
      ? getTddTaskCompletionMarkerTaskId(assistantText)
      : undefined;
    if (tddTaskId) {
      await completeTddTask(ctx, tddTaskId);
      return;
    }

    if (hasPhaseCompletionMarker(assistantText)) {
      await handlePhaseCompleteSignal(ctx);
    }
  }

  async function approveHardenedSpec(ctx, commandArgs = []) {
    if (state?.currentPhase !== "harden_spec") {
      return false;
    }

    const nextState = advancePhase(state, {
      renderHtml: commandArgs.includes("--render-html"),
      reason: "hardened spec approved",
    });
    await enterPhase(ctx, nextState, {
      reason: `entered ${nextState.currentPhase}`,
    });
    return true;
  }

  async function handleCommand(args, ctx) {
    const [command = "status", ...commandArgs] = splitCommandArgs(args);

    if (command === "start") {
      await startWorkflow(ctx, commandArgs);
      return;
    }
    if (command === "status") {
      await showStatus(ctx);
      return;
    }
    if (command === "help") {
      ctx.ui?.notify?.(HELP_MESSAGE, "info");
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
      const taskId = commandArgs[0];
      if (!taskId) {
        throw new Error("Usage: /ralph-works tdd-complete <task-id>");
      }
      await completeTddTask(ctx, taskId);
      return;
    }
    if (command === "artifact") {
      await recordWorkflowArtifact(ctx, commandArgs);
      return;
    }
    if (command === "approve") {
      if (!state) {
        notifyNoActivePipeline(ctx);
        return;
      }
      if (await approveHardenedSpec(ctx, commandArgs)) {
        return;
      }
      if (state.currentPhase === "review") {
        await completePipeline(ctx, "LGTM");
        return;
      }
      ctx.ui?.notify?.(
        "Nothing to approve in the current ralph-works phase.",
        "info",
      );
      return;
    }
    if (command === "loopback") {
      if (!state) {
        notifyNoActivePipeline(ctx);
        return;
      }
      state = applyPhaseCommand(state, command, commandArgs);
      await enterPhase(ctx, state, { reason: command });
      return;
    }
    if (command === "reset") {
      state = undefined;
      implementationStatus = createImplementationStatus();
      ctx.ui?.setStatus?.("ralph-works", undefined);
      ctx.ui?.setWidget?.("ralph-works", []);
      return;
    }

    throw new Error(`Unknown /ralph-works command: ${command}`);
  }

  pi.on("session_start", async (_event, ctx) => {
    state = restoreRalphWorksState(ctx);
    implementationStatus = state?.implementationStatus
      ?? createImplementationStatus();
    if (state) {
      await showStatus(ctx);
    }
  });

  pi.on("agent_end", handleAgentEnd);

  pi.on("resources_discover", async () => ({
    skillPaths: [path.join(extensionRoot, "skills")],
  }));

  pi.registerCommand("ralph-works", {
    description: "Show and advance the RalphWorks workflow.",
    getArgumentCompletions(prefix) {
      const commands = [
        "start",
        "status",
        "next",
        "next --render-html",
        "gates",
        "tdd-complete",
        "artifact",
        "loopback",
        "approve",
        "approve --render-html",
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
      return createToolResult(
        state
          ? `ralph-works phase: ${state.currentPhase}`
          : "ralph-works pipeline not started",
        state,
      );
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
      if (!state) {
        return createToolResult("ralph-works pipeline not started", undefined);
      }

      await advanceToNextPhase(
        ctx,
        params.renderHtml ? ["--render-html"] : [],
        "command:next",
      );
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
      if (!state) {
        return createToolResult("ralph-works pipeline not started", undefined);
      }

      state = recordArtifact(state, params.key, params.path);
      persistRalphWorksState(pi, state);
      await showStatus(ctx);
      return createToolResult(`recorded ${params.key}: ${params.path}`, state);
    },
  });
}

function applyPhaseCommand(state, command, commandArgs) {
  if (command === "loopback") {
    return transitionToPhase(state, "tdd_implement", {
      reason: commandArgs.join(" ") || "review-critical-bugs",
    });
  }

  throw new Error(`Unknown ralph-works phase command: ${command}`);
}
