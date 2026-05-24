import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recordArtifact } from "../artifacts/artifact-tracker.js";
import { requiredGatesPassed } from "../gates/gate-result.js";
import { buildPhasePrompt } from "../prompts/phase-prompt-builder.js";
import {
  getTddTaskCompletionMarkerTaskId,
  HARDEN_APPROVAL_STATUS,
  hasPhaseCompletionMarker,
  isLgtmReview,
  requestsReviewLoopback,
} from "../state/phase-completion.js";
import { createPhaseState } from "../state/phase-state.js";
import { advancePhase, transitionToPhase } from "../state/phase-transitions.js";
import {
  appendSessionBoundaryEvent,
  createSessionBoundaryEvent,
  findPendingSessionBoundaryEvent,
  findReusableUnresolvedPhaseBoundaryEvent,
  findSessionBoundaryEvent,
  updateSessionBoundaryEvent,
} from "../state/session-boundaries.js";
import { parseTaskList } from "../tasks/task-list-loader.js";
import { selectNextTask } from "../tasks/task-selector.js";
import {
  buildImplementationStatusDocument,
  createImplementationStatus,
  markTaskComplete,
} from "../tasks/task-status-updater.js";
import { splitCommandArgs } from "./pi-argument-parser.js";
import { runPiConfiguredGates } from "./pi-gate-runner.js";
import {
  applyModelTargetToCurrentSession,
  getActivePhaseModelName,
  resolveModelTargetForCurrentPhase,
} from "./pi-model-router.js";
import { launchPiSessionBoundary } from "./pi-session-boundary-launcher.js";
import {
  persistRalphWorksState,
  restoreRalphWorksState,
} from "./pi-state-persistence.js";
import { createToolResult } from "./pi-tool-result.js";
import { updateRalphWorksTui } from "./pi-tui-updater.js";
import { formatSessionBoundaryDiagnostic } from "./session-boundary-diagnostics.js";
import {
  buildSessionBoundaryPlan,
  normalizeReviewFeedback,
} from "./session-boundary-plan.js";

const DEFAULT_EXTENSION_ROOT = fileURLToPath(
  new URL("../../", import.meta.url),
);
const NO_ACTIVE_PIPELINE_MESSAGE =
  "No active ralph-works pipeline. Start one with /ralph-works start <feature> [prompt].";
const HARDEN_APPROVAL_MESSAGE =
  "Approve the hardened spec with /ralph-works approve to continue to implementation planning, or /ralph-works approve --render-html to render HTML first.";
const CONTINUE_BOUNDARY_COMMAND = "continue-boundary";
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

function phaseArtifactPath(workflowState, phaseId) {
  return workflowState.phases.find((phase) => phase.id === phaseId)
    ?.artifactPath;
}

function implementationStatusArtifactPath(workflowState) {
  return phaseArtifactPath(workflowState, "tdd_implement");
}

function ensureImplementationStatusArtifact(workflowState) {
  const artifactPath = implementationStatusArtifactPath(workflowState);
  if (!artifactPath) {
    return workflowState;
  }

  if (workflowState.artifacts?.implementationStatus === artifactPath) {
    return workflowState;
  }

  return recordArtifact(workflowState, "implementationStatus", artifactPath);
}

function readJsonDocument(absolutePath) {
  try {
    return JSON.parse(readFileSync(absolutePath, "utf8"));
  } catch {
    return {};
  }
}

function writeImplementationStatusArtifact(ctx, workflowState, status) {
  const artifactPath = implementationStatusArtifactPath(workflowState);
  if (!artifactPath) {
    return workflowState;
  }

  const absolutePath = path.resolve(ctx.cwd ?? process.cwd(), artifactPath);
  const document = buildImplementationStatusDocument(status, {
    feature: workflowState.feature,
    workflowStatus:
      workflowState.pipelineStatus === "completed"
        ? "completed"
        : "in_progress",
    previous: readJsonDocument(absolutePath),
  });

  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `${JSON.stringify(document, null, 2)}\n`);

  return {
    ...ensureImplementationStatusArtifact(workflowState),
    implementationStatus: document,
  };
}

export function registerRalphWorksExtension(
  pi,
  { extensionRoot = DEFAULT_EXTENSION_ROOT } = {},
) {
  let state;
  let implementationStatus = createImplementationStatus();
  let boundarySequence = 0;

  function createBoundaryId(boundaryType, phaseId) {
    boundarySequence += 1;
    const safePhaseId = String(phaseId ?? "workflow").replace(
      /[^a-zA-Z0-9_-]+/g,
      "-",
    );
    return `rw-${boundaryType}-${safePhaseId}-${boundarySequence}`;
  }

  function buildContinueBoundaryCommand(boundaryId) {
    return `/ralph-works ${CONTINUE_BOUNDARY_COMMAND} ${boundaryId}`;
  }

  function notifyNoActivePipeline(ctx) {
    ctx.ui?.notify?.(NO_ACTIVE_PIPELINE_MESSAGE, "info");
  }

  function notifyHardenApproval(ctx, message = HARDEN_APPROVAL_MESSAGE) {
    ctx.ui?.notify?.(message, "warning");
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

  function formatErrorMessage(error) {
    if (error instanceof Error && error.message) {
      return error.message;
    }
    if (typeof error === "string") {
      return error;
    }
    return undefined;
  }

  function buildBoundaryHandoffFailure(boundaryId, error) {
    const command = buildContinueBoundaryCommand(boundaryId);
    const detail = formatErrorMessage(error);
    return {
      boundaryId,
      command,
      message: detail
        ? `ralph-works could not enqueue boundary launcher ${boundaryId}: ${detail}. Run ${command} to continue.`
        : `ralph-works could not enqueue boundary launcher ${boundaryId}; follow-up messages are unavailable. Run ${command} to continue.`,
    };
  }

  async function enqueueBoundaryLauncher(boundaryId) {
    if (typeof pi.sendUserMessage !== "function") {
      return {
        queued: false,
        failure: buildBoundaryHandoffFailure(boundaryId),
      };
    }

    try {
      await pi.sendUserMessage(buildContinueBoundaryCommand(boundaryId), {
        deliverAs: "followUp",
      });
      return { queued: true };
    } catch (error) {
      return {
        queued: false,
        failure: buildBoundaryHandoffFailure(boundaryId, error),
      };
    }
  }

  let lastBoundaryHandoffFailure;

  async function persistAndEnqueueBoundary(
    ctx,
    nextState,
    {
      boundaryType,
      reason,
      fromPhase,
      toPhase,
      taskId,
      nextTaskId,
      reviewFeedback,
    } = {},
  ) {
    const boundaryState =
      nextState.currentPhase === "tdd_implement"
        ? ensureImplementationStatusArtifact(nextState)
        : nextState;
    const boundaryId = createBoundaryId(
      boundaryType,
      boundaryState.currentPhase,
    );
    const boundaryEvent = createSessionBoundaryEvent({
      id: boundaryId,
      boundaryType,
      reason,
      fromPhase,
      toPhase,
      taskId,
      nextTaskId,
      reviewFeedback,
    });
    state = appendSessionBoundaryEvent(boundaryState, boundaryEvent);
    persistRalphWorksState(pi, state);
    updateRalphWorksTui(ctx, state, await getActivePhaseModelName(ctx, state));

    const enqueueResult = await enqueueBoundaryLauncher(boundaryId);
    if (!enqueueResult.queued) {
      lastBoundaryHandoffFailure = enqueueResult.failure;
      state = updateSessionBoundaryEvent(state, boundaryId, {
        status: "followup_failed",
      });
      persistRalphWorksState(pi, state);
      updateRalphWorksTui(
        ctx,
        state,
        await getActivePhaseModelName(ctx, state),
      );
      ctx.ui?.notify?.(enqueueResult.failure.message, "error");
      return state;
    }

    lastBoundaryHandoffFailure = undefined;
    return state;
  }

  async function requeueReusableBoundary(ctx, boundaryEvent) {
    updateRalphWorksTui(ctx, state, await getActivePhaseModelName(ctx, state));
    if (
      state?.currentPhase === "harden_spec" &&
      state?.phaseStatus === HARDEN_APPROVAL_STATUS
    ) {
      notifyHardenApproval(
        ctx,
        `Hardened spec is waiting for approval. ${HARDEN_APPROVAL_MESSAGE}`,
      );
    }

    const enqueueResult = await enqueueBoundaryLauncher(boundaryEvent.id);
    if (!enqueueResult.queued) {
      lastBoundaryHandoffFailure = enqueueResult.failure;
      if (boundaryEvent.status !== "followup_failed") {
        state = updateSessionBoundaryEvent(state, boundaryEvent.id, {
          status: "followup_failed",
        });
        persistRalphWorksState(pi, state);
        updateRalphWorksTui(
          ctx,
          state,
          await getActivePhaseModelName(ctx, state),
        );
      }
      ctx.ui?.notify?.(enqueueResult.failure.message, "error");
      return state;
    }

    lastBoundaryHandoffFailure = undefined;
    return state;
  }

  function promptWithOptionalPrefix(prompt, prefixText) {
    if (!prompt) {
      return undefined;
    }
    return prefixText ? `${prefixText}\n\n${prompt}` : prompt;
  }

  function reviewLoopbackPrefix(reviewFeedback) {
    const lines = ["Review requested changes; return to TDD implementation."];
    if (reviewFeedback) {
      lines.push("", "Review context:", reviewFeedback);
    }
    return lines.join("\n");
  }

  function selectNextTddTask(ctx, workflowState) {
    const tasks = readTaskList(ctx, workflowState);
    return tasks.length > 0
      ? selectNextTask(tasks, implementationStatus)
      : undefined;
  }

  function resolveBoundaryAction(ctx, boundaryEvent) {
    if (
      state?.pipelineStatus === "completed" ||
      state?.currentPhase === "complete"
    ) {
      return { nextActionType: "completion" };
    }

    if (
      state?.currentPhase === "harden_spec" &&
      state?.phaseStatus === HARDEN_APPROVAL_STATUS
    ) {
      return { nextActionType: "approval_pause" };
    }

    const phasePrompt = buildPhasePrompt(state, { extensionRoot });

    if (boundaryEvent.boundaryType === "task") {
      const task = selectNextTddTask(ctx, state);
      return {
        nextActionType: "tdd_task_prompt",
        kickoffPrompt: promptWithOptionalPrefix(
          phasePrompt,
          "Continue TDD implementation with the next incomplete task.",
        ),
        task,
      };
    }

    if (
      state.currentPhase === "tdd_implement" &&
      boundaryEvent.reason === "review requested changes"
    ) {
      const reviewFeedback = normalizeReviewFeedback(
        boundaryEvent.reviewFeedback,
      );
      return {
        nextActionType: "review_loopback",
        kickoffPrompt: promptWithOptionalPrefix(
          phasePrompt,
          reviewLoopbackPrefix(reviewFeedback),
        ),
        task: selectNextTddTask(ctx, state),
        reviewFeedback,
      };
    }

    return {
      nextActionType: "phase_prompt",
      kickoffPrompt: phasePrompt,
    };
  }

  function persistBoundaryLaunchState(boundaryId, nextState) {
    state = nextState;
    const boundaryEvent = findSessionBoundaryEvent(state, boundaryId);
    if (!boundaryEvent?.freshSessionCreated) {
      persistRalphWorksState(pi, state);
    }
  }

  async function continueBoundary(ctx, boundaryId) {
    if (!state) {
      state = restoreRalphWorksState(ctx);
      implementationStatus =
        state?.implementationStatus ?? createImplementationStatus();
    }
    if (!state) {
      notifyNoActivePipeline(ctx);
      return undefined;
    }

    const boundaryEvent = findSessionBoundaryEvent(state, boundaryId);
    const pendingBoundary = findPendingSessionBoundaryEvent(state, boundaryId);
    if (!pendingBoundary) {
      ctx.ui?.notify?.(
        `ralph-works ${formatSessionBoundaryDiagnostic({
          boundaryId,
          reason: boundaryEvent?.reason ?? "no matching pending boundary",
        })} is stale, already handled, or not retryable.`,
        "info",
      );
      return state;
    }

    const action = resolveBoundaryAction(ctx, pendingBoundary);
    const selectedModelTarget = action.kickoffPrompt
      ? await resolveModelTargetForCurrentPhase(ctx, state)
      : undefined;
    const activeModel =
      selectedModelTarget?.raw ?? (await getActivePhaseModelName(ctx, state));
    const plan = buildSessionBoundaryPlan(state, {
      boundaryId: pendingBoundary.id,
      boundaryType: pendingBoundary.boundaryType,
      reason: pendingBoundary.reason,
      nextActionType: action.nextActionType,
      kickoffPrompt: action.kickoffPrompt,
      selectedModelTarget,
      task: action.task,
      gateResults: state.gateResults,
      reviewFeedback: action.reviewFeedback,
    });

    const result = await launchPiSessionBoundary(ctx, state, plan, {
      onStateChange(nextState) {
        persistBoundaryLaunchState(pendingBoundary.id, nextState);
      },
      async sendFallbackPrompt(content, options) {
        pi.sendUserMessage?.(content, options);
      },
      async applyFallbackModel() {
        await applyModelTargetToCurrentSession(pi, ctx, selectedModelTarget);
      },
      async onReplacementReady(replacementCtx, replacementState) {
        updateRalphWorksTui(replacementCtx, replacementState, activeModel);
      },
    });
    state = result.state;
    if (!result.freshSessionCreated) {
      persistRalphWorksState(pi, state);
    }
    return state;
  }

  function buildBoundaryAction(ctx, boundaryEvent, { prefixText } = {}) {
    const action = resolveBoundaryAction(ctx, boundaryEvent);
    return {
      ...action,
      kickoffPrompt: promptWithOptionalPrefix(action.kickoffPrompt, prefixText),
    };
  }

  async function launchSessionBoundary(
    ctx,
    nextState,
    {
      boundaryType,
      reason,
      fromPhase,
      toPhase,
      taskId,
      nextTaskId,
      reviewFeedback,
    } = {},
    { prefixText } = {},
  ) {
    const boundaryState =
      nextState.currentPhase === "tdd_implement"
        ? ensureImplementationStatusArtifact(nextState)
        : nextState;
    const boundaryId = createBoundaryId(
      boundaryType,
      boundaryState.currentPhase,
    );
    const boundaryEvent = createSessionBoundaryEvent({
      id: boundaryId,
      boundaryType,
      reason,
      fromPhase,
      toPhase,
      taskId,
      nextTaskId,
      reviewFeedback,
    });
    state = appendSessionBoundaryEvent(boundaryState, boundaryEvent);
    const action = buildBoundaryAction(ctx, boundaryEvent, { prefixText });
    const selectedModelTarget = action.kickoffPrompt
      ? await resolveModelTargetForCurrentPhase(ctx, state)
      : undefined;
    const activeModel =
      selectedModelTarget?.raw ?? (await getActivePhaseModelName(ctx, state));
    persistRalphWorksState(pi, state);
    updateRalphWorksTui(ctx, state, activeModel);

    const plan = buildSessionBoundaryPlan(state, {
      boundaryId,
      boundaryType,
      reason,
      nextActionType: action.nextActionType,
      kickoffPrompt: action.kickoffPrompt,
      selectedModelTarget,
      task: action.task,
      gateResults: state.gateResults,
      reviewFeedback: action.reviewFeedback,
    });

    const result = await launchPiSessionBoundary(ctx, state, plan, {
      onStateChange(nextState) {
        persistBoundaryLaunchState(boundaryId, nextState);
      },
      async sendFallbackPrompt(content, options) {
        pi.sendUserMessage?.(content, options);
      },
      async applyFallbackModel() {
        await applyModelTargetToCurrentSession(pi, ctx, selectedModelTarget);
      },
      async onReplacementReady(replacementCtx, replacementState) {
        updateRalphWorksTui(replacementCtx, replacementState, activeModel);
      },
    });
    state = result.state;
    if (!result.freshSessionCreated) {
      persistRalphWorksState(pi, state);
    }
    return state;
  }

  function getLatestTransition(nextState) {
    return Array.isArray(nextState.transitionHistory)
      ? nextState.transitionHistory.at(-1)
      : undefined;
  }

  async function enterPhase(ctx, nextState, { reason, prefixText } = {}) {
    const transition = getLatestTransition(nextState);
    const phaseEntryState = {
      ...nextState,
      pipelineStatus: "running",
      phaseStatus: "executing",
    };
    return launchSessionBoundary(
      ctx,
      nextState.currentPhase === "tdd_implement"
        ? ensureImplementationStatusArtifact(phaseEntryState)
        : phaseEntryState,
      {
        boundaryType: "phase",
        reason,
        fromPhase: transition?.from,
        toPhase: nextState.currentPhase,
      },
      { prefixText },
    );
  }

  async function pauseForHardenApproval(ctx, { handoff = false } = {}) {
    if (!state) {
      return undefined;
    }

    if (state.phaseStatus === HARDEN_APPROVAL_STATUS) {
      notifyHardenApproval(
        ctx,
        `Hardened spec is waiting for approval. ${HARDEN_APPROVAL_MESSAGE}`,
      );
      return state;
    }

    const nextState = {
      ...state,
      phaseStatus: HARDEN_APPROVAL_STATUS,
    };
    const boundary = {
      boundaryType: "phase",
      reason: "hardened spec awaiting approval",
      fromPhase: "harden_spec",
      toPhase: "harden_spec",
    };

    notifyHardenApproval(ctx);
    return handoff
      ? persistAndEnqueueBoundary(ctx, nextState, boundary)
      : launchSessionBoundary(ctx, nextState, boundary);
  }

  async function advanceToNextPhase(
    ctx,
    commandArgs,
    reason,
    { handoff = false } = {},
  ) {
    if (!state) {
      return undefined;
    }

    if (state.currentPhase === "harden_spec") {
      return pauseForHardenApproval(ctx, { handoff });
    }

    if (
      state.currentPhase === "tdd_implement" &&
      !(await runReviewAdvancementGates(ctx))
    ) {
      return state;
    }

    const fromPhase = state.currentPhase;
    const nextState = advancePhase(state, {
      renderHtml: commandArgs.includes("--render-html"),
      reason,
    });
    const boundary = {
      boundaryType: "phase",
      reason: `entered ${nextState.currentPhase}`,
      fromPhase,
      toPhase: nextState.currentPhase,
    };

    return handoff
      ? persistAndEnqueueBoundary(ctx, nextState, boundary)
      : enterPhase(ctx, nextState, { reason: boundary.reason });
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
    return launchSessionBoundary(ctx, state, {
      boundaryType: "phase",
      reason: "start",
      toPhase: state.currentPhase,
    });
  }

  async function completePipeline(ctx, reason, { handoff = false } = {}) {
    if (!state) {
      return undefined;
    }

    const fromPhase = state.currentPhase;
    const completedState =
      state.currentPhase === "complete"
        ? state
        : transitionToPhase(state, "complete", { reason });
    const nextState = {
      ...completedState,
      pipelineStatus: "completed",
      phaseStatus: "post_hook",
    };

    if (handoff) {
      ctx.ui?.notify?.("ralph-works pipeline complete.", "info");
      return persistAndEnqueueBoundary(ctx, nextState, {
        boundaryType: "phase",
        reason,
        fromPhase,
        toPhase: "complete",
      });
    }

    ctx.ui?.notify?.("ralph-works pipeline complete.", "info");
    return launchSessionBoundary(ctx, nextState, {
      boundaryType: "phase",
      reason,
      fromPhase,
      toPhase: "complete",
    });
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

  async function runReviewAdvancementGates(ctx) {
    const gateResults = await runGates(ctx);
    if (!requiredGatesPassed(gateResults)) {
      ctx.ui?.notify?.(
        "ralph-works gates failed; review phase will not start.",
        "error",
      );
      return false;
    }
    return true;
  }

  async function continueAfterCompletedTddTask(
    ctx,
    taskId,
    { handoff = false } = {},
  ) {
    if (!state || state.currentPhase !== "tdd_implement") {
      return state;
    }

    const tasks = readTaskList(ctx, state);
    const nextTask =
      tasks.length > 0
        ? selectNextTask(tasks, implementationStatus)
        : undefined;

    if (tasks.length === 0 || nextTask) {
      const boundary = {
        boundaryType: "task",
        reason: `completed ${taskId}`,
        fromPhase: "tdd_implement",
        taskId,
        nextTaskId: nextTask?.id,
      };
      return handoff
        ? persistAndEnqueueBoundary(ctx, state, boundary)
        : launchSessionBoundary(ctx, state, boundary);
    }

    const fromPhase = state.currentPhase;
    const nextState = advancePhase(state, {
      reason: "completed tdd_implement",
    });
    const boundary = {
      boundaryType: "phase",
      reason: `entered ${nextState.currentPhase}`,
      fromPhase,
      toPhase: nextState.currentPhase,
      taskId,
    };
    return handoff
      ? persistAndEnqueueBoundary(ctx, nextState, boundary)
      : launchSessionBoundary(ctx, nextState, boundary);
  }

  async function completeTddTask(ctx, taskId, { handoff = false } = {}) {
    if (!state) {
      notifyNoActivePipeline(ctx);
      return undefined;
    }

    const gateResults = await runGates(ctx);
    if (!requiredGatesPassed(gateResults)) {
      ctx.ui?.notify?.(
        "ralph-works gates failed; task remains incomplete.",
        "error",
      );
      return state;
    }

    implementationStatus = markTaskComplete(implementationStatus, taskId, {
      gateResults,
    });
    state = writeImplementationStatusArtifact(
      ctx,
      {
        ...state,
        tddCompletedTasks: state.tddCompletedTasks + 1,
        implementationStatus,
      },
      implementationStatus,
    );
    implementationStatus = state.implementationStatus ?? implementationStatus;
    persistRalphWorksState(pi, state);
    updateRalphWorksTui(ctx, state, await getActivePhaseModelName(ctx, state));

    return continueAfterCompletedTddTask(ctx, taskId, { handoff });
  }

  async function handlePhaseCompleteSignal(ctx) {
    if (!state) {
      return undefined;
    }

    if (state.currentPhase === "complete") {
      return completePipeline(ctx, "LGTM", { handoff: true });
    }

    if (state.currentPhase === "review") {
      ctx.ui?.notify?.(
        "Review approval must end with LGTM; RALPH_PHASE_COMPLETE is ignored during review.",
        "warning",
      );
      return state;
    }

    if (state.currentPhase === "harden_spec") {
      if (state.phaseStatus === HARDEN_APPROVAL_STATUS) {
        notifyHardenApproval(
          ctx,
          `Hardened spec is waiting for approval. ${HARDEN_APPROVAL_MESSAGE}`,
        );
        return state;
      }

      const nextState = {
        ...state,
        phaseStatus: HARDEN_APPROVAL_STATUS,
      };
      notifyHardenApproval(ctx);
      return persistAndEnqueueBoundary(ctx, nextState, {
        boundaryType: "phase",
        reason: "hardened spec awaiting approval",
        fromPhase: "harden_spec",
        toPhase: "harden_spec",
      });
    }

    if (
      state.currentPhase === "tdd_implement" &&
      !(await runReviewAdvancementGates(ctx))
    ) {
      return state;
    }

    const fromPhase = state.currentPhase;
    const nextState = advancePhase(state, {
      reason: `completed ${state.currentPhase}`,
    });
    return persistAndEnqueueBoundary(ctx, nextState, {
      boundaryType: "phase",
      reason: `entered ${nextState.currentPhase}`,
      fromPhase,
      toPhase: nextState.currentPhase,
    });
  }

  async function handleReviewTurn(ctx, assistantText) {
    if (!state || state.currentPhase !== "review") {
      return false;
    }

    if (isLgtmReview(assistantText)) {
      await completePipeline(ctx, "review LGTM", { handoff: true });
      return true;
    }

    if (requestsReviewLoopback(assistantText)) {
      const fromPhase = state.currentPhase;
      const reviewFeedback = normalizeReviewFeedback(assistantText);
      const nextState = transitionToPhase(state, "tdd_implement", {
        reason: "review requested changes",
      });
      await persistAndEnqueueBoundary(ctx, nextState, {
        boundaryType: "phase",
        reason: "review requested changes",
        fromPhase,
        toPhase: "tdd_implement",
        reviewFeedback,
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

    const tddTaskId =
      state.currentPhase === "tdd_implement"
        ? getTddTaskCompletionMarkerTaskId(assistantText)
        : undefined;
    if (tddTaskId) {
      await completeTddTask(ctx, tddTaskId, { handoff: true });
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
    if (command === CONTINUE_BOUNDARY_COMMAND) {
      const boundaryId = commandArgs[0];
      if (!boundaryId) {
        throw new Error("Usage: /ralph-works continue-boundary <boundary-id>");
      }
      await continueBoundary(ctx, boundaryId);
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
    implementationStatus =
      state?.implementationStatus ?? createImplementationStatus();
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

      lastBoundaryHandoffFailure = undefined;
      const reusableBoundary = findReusableUnresolvedPhaseBoundaryEvent(state);
      if (reusableBoundary) {
        await requeueReusableBoundary(ctx, reusableBoundary);
      } else if (state.currentPhase === "review") {
        ctx.ui?.notify?.(
          "Review approval must end with LGTM; ralph_works_transition is ignored during review.",
          "warning",
        );
        updateRalphWorksTui(
          ctx,
          state,
          await getActivePhaseModelName(ctx, state),
        );
      } else {
        await advanceToNextPhase(
          ctx,
          params.renderHtml ? ["--render-html"] : [],
          "command:next",
          { handoff: true },
        );
      }
      const recoveryText = lastBoundaryHandoffFailure
        ? `\nFollow-up queue failed. Run ${lastBoundaryHandoffFailure.command} to continue.`
        : "";
      return createToolResult(
        `ralph-works phase: ${state.currentPhase}${recoveryText}`,
        state,
      );
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
