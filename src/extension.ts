/**
 * ralph-works Extension — Phase-state-machine pipeline inside pi.
 *
 * Deterministic state machine with pre-hook → execution → post-hook lifecycle.
 * Single-skill injection, structured review decisions, crash recovery.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  appendModelSwitchHistoryEvent,
  checkPipelineLock,
  createPipelineLock,
  phaseCompletionMarkerExists,
  removePipelineLock,
  removePipelineLocks,
  writeDevCycleSummary,
  writeMetrics,
  writePhaseCompletionMarker,
} from "./artifacts";
import {
  GATE_PHASES,
  GATE_THRESHOLD,
  IMPLEMENT_CHECKPOINT_WAIT_REASON,
  MAX_PHASE_ATTEMPTS,
  RENDER_PHASE,
  SKILL_BASE,
  USER_COMMAND,
  USER_COMMAND_NAME,
  UI_WIDGET_ID,
  VALIDATION_FAILED_PHASE_STATUS,
  WAITING_FOR_USER_PHASE_STATUS,
} from "./config";
import type { ModelThinkingLevel, PipelineState, RalphModelPlan, RalphModelSelector } from "./domain";
import { formatGateResults, runLintGates } from "./gates";
import {
  sendDedupedPipelineUserMessage,
  sendPhasePrompt,
  sendPipelineUserMessage,
  withoutPendingSteer,
} from "./messaging";
import {
  activeModelMatchesSelector,
  appendModelSwitchHistory,
  buildModelPlanFromOptions,
  createModelSwitchEvent,
  formatModelSelector,
  resolvePhaseModelSelector,
  selectedModelIds,
  selectorFromCurrentModel,
} from "./modelPlan";
import {
  PHASE_CONFIGS,
  formatMissingPhaseSkillPrerequisites,
  getMissingPhaseSkillPrerequisites,
  runPostHook,
  runPreHook,
} from "./phaseConfig";
import {
  addRenderPhase,
  buildPhasePrompt,
  canAddRenderBeforeCurrentPhase,
  parseCommandArgs,
  parseRalphFlags,
  resolveCurrentPhaseIndex,
  resolvePromptInput,
} from "./prompts";
import { getState, saveState } from "./stateStore";
import {
  validatePhaseOrder,
  PHASE_META,
  PHASE_ORDER,
  DEFAULT_PHASES,
  resolvePhaseCompletion,
  resolveSessionStartAction,
  hasPhaseCompletionMarker,
  resolveGateConfiguration,
  PHASE_COMPLETE_MARKER,
  sanitizeFeatureName,
} from "./stateMachine";
import { appendReviewTasks, parseTaskLedger, selectNextTask, updateTaskStatus } from "./taskLedger";
import {
  enterImplementCheckpoint as buildImplementCheckpointState,
  enterPhaseExecution,
  enterPhasePreHook,
  enterValidationFailed,
  markPhaseValidated,
} from "./stateController";
import {
  wrapSteerMessage,
  MAX_STEER_SIZE,
  validatePhaseIndex,
  canClearContext,
  buildReorientationPrompt,
  resolveArtifactPaths,
} from "./steer";
import {
  clearPipelineWidgetCache,
  refreshWidget,
  setPipelineCompactingUi,
  setPipelineWaitingUi,
  setPipelineWorkingUi,
} from "./widget";
import {
  buildWorkDirPolicyWarning,
  formatExpectedArtifactPaths,
  formatPostHookFailure,
  getExpectedArtifactPaths,
  resolvePipelineWorkDir,
} from "./workdir";

/** Extract plain text from Pi message content blocks. */
function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const textParts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const block = part as { type?: string; text?: string };
    if (block.type === "text" && typeof block.text === "string") textParts.push(block.text);
  }
  return textParts.join("\n").trim();
}

/** Only non-terminal persisted states should prevent a fresh `/ralph-works start`. */
function blocksNewPipelineStart(state: PipelineState | null): boolean {
  if (!state) return false;
  return !["completed", "cancelled", "failed", "halted"].includes(state.pipelineStatus ?? "running");
}

const RALPH_TOP_LEVEL_COMMANDS = [
  "start",
  "status",
  "cancel",
  "gate",
  "continue",
  "resume",
  "pause",
  "set-workdir",
  "clear-context",
];

const RALPH_USAGE = `Usage: ${USER_COMMAND} start <feature> [--render-html|html] [--yolo] | status | cancel | gate | set-workdir <path> | continue [--render-html|html] [--yolo] | resume | pause | clear-context [--auto]`;

/** Auto phase-boundary compaction is enabled unless a persisted state explicitly opts out. */
function isAutoClearContextEnabled(state: PipelineState): boolean {
  return state.autoClearContext !== false;
}

const TASK_COMPLETE_MARKER = "RALPH_TASK_COMPLETE";
const TASK_BLOCKED_MARKER = "RALPH_TASK_BLOCKED";
const TASK_PARTIALLY_VERIFIED_MARKER = "RALPH_TASK_PARTIALLY_VERIFIED";
const TASK_NEEDS_FOLLOWUP_MARKER = "RALPH_TASK_NEEDS_FOLLOWUP";

function finalNonEmptyLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) ?? ""
  );
}

function parseSelectedTaskMarker(text: string): string | null {
  const line = finalNonEmptyLine(text);
  const match = line.match(/^RALPH_SELECTED_TASK\s+(TASK-\d{4})$/);
  return match?.[1] ?? null;
}

function hasNoTasksRemainMarker(text: string): boolean {
  return finalNonEmptyLine(text) === "RALPH_NO_TASKS_REMAIN";
}

function parseTaskStatusMarker(text: string): "complete" | "blocked" | "partially_verified" | "needs_followup" | null {
  const line = finalNonEmptyLine(text);
  if (line === TASK_COMPLETE_MARKER) return "complete";
  if (line === TASK_BLOCKED_MARKER) return "blocked";
  if (line === TASK_PARTIALLY_VERIFIED_MARKER) return "partially_verified";
  if (line === TASK_NEEDS_FOLLOWUP_MARKER) return "needs_followup";
  return null;
}

function taskFileRelativePath(state: PipelineState): string {
  return state.taskFile ?? `docs/specs/todo_${sanitizeFeatureName(state.feature)}.md`;
}

function taskFileAbsolutePath(state: PipelineState): string {
  return path.join(state.workDir, taskFileRelativePath(state));
}

function buildTaskSelectorPrompt(state: PipelineState, ledgerContent: string): string {
  return [
    "# ralph-works Task Selector",
    "",
    "Select exactly one highest-priority pending, unblocked implementation task from the task ledger.",
    "A task is eligible only when all `Depends On` tasks are complete.",
    "Return only one final marker line:",
    "",
    "```text",
    "RALPH_SELECTED_TASK TASK-0001",
    "```",
    "",
    "If no pending unblocked task remains, return:",
    "",
    "```text",
    "RALPH_NO_TASKS_REMAIN",
    "```",
    "",
    `Task ledger: ${taskFileRelativePath(state)}`,
    "",
    "<task-ledger>",
    ledgerContent,
    "</task-ledger>",
  ].join("\n");
}

/** Recognize a review turn that clearly ended LGTM even if the tool call was omitted. */
function isLgtmReviewText(text: string): boolean {
  if (!text.trim()) return false;
  if (/(?:^|\n)\s*(?:[-*]\s*)?(?:\[CRITICAL\]|\bCRITICAL\b\s*:)/i.test(text)) return false;

  const lgtm = /\bLGTM\b/i.test(text) && !/\b(?:not|not yet|cannot|can't|no)\s+LGTM\b/i.test(text);
  const noCriticalFinding =
    /\bno\s+critical\s+(?:bugs?|issues?|findings?|defects?|blockers?)\s+(?:were\s+|are\s+)?(?:found|detected|identified|remain|remaining)\b/i.test(
      text,
    ) ||
    /\b(?:found|detected|identified)\s+no\s+critical\s+(?:bugs?|issues?|findings?|defects?|blockers?)\b/i.test(text);

  return lgtm || noCriticalFinding;
}

/** Persist a waiting state and switch the TUI out of "working" mode. */
function enterWaitingForUser(pi: ExtensionAPI, ctx: ExtensionContext, st: PipelineState): void {
  if (st.pipelineStatus !== "running") return;
  if (st.phaseStatus !== "executing" && st.phaseStatus !== WAITING_FOR_USER_PHASE_STATUS) return;
  const waitingState: PipelineState = { ...st, phaseStatus: WAITING_FOR_USER_PHASE_STATUS, turnWriteCount: 0 };
  saveState(pi, waitingState);
  setPipelineWaitingUi(ctx, waitingState);
  refreshWidget(ctx, waitingState);
}

function buildPausedState(state: PipelineState): PipelineState {
  const cleared = withoutPendingSteer(state);
  return {
    ...cleared,
    pipelineStatus: "paused",
    pausedFromPhaseStatus: state.pausedFromPhaseStatus ?? state.phaseStatus,
    turnWriteCount: 0,
    readyToAdvancePhase: undefined,
  };
}

function requestCurrentAgentAbort(ctx: ExtensionContext): "requested" | "idle" | "unavailable" | "failed" {
  const maybeCtx = ctx as ExtensionContext & { abort?: () => void; signal?: AbortSignal };
  if (typeof maybeCtx.abort !== "function") return "unavailable";
  if (!maybeCtx.signal) return "idle";
  if (maybeCtx.signal.aborted) return "requested";
  try {
    maybeCtx.abort();
    return "requested";
  } catch {
    return "failed";
  }
}

function formatPauseNotice(abortStatus: ReturnType<typeof requestCurrentAgentAbort>): string {
  if (abortStatus === "requested") {
    return "Pipeline paused; current assistant turn abort requested. ralph-works will not launch additional phase work until /ralph-works resume.";
  }
  if (abortStatus === "idle") {
    return "Pipeline paused. ralph-works will not launch additional phase work until /ralph-works resume.";
  }
  if (abortStatus === "failed") {
    return "Pipeline paused, but aborting the current assistant turn failed; the current assistant turn may continue. ralph-works will not launch additional phase work until /ralph-works resume.";
  }
  return "Pipeline paused. This Pi build cannot abort the current assistant turn, so the current assistant turn may continue; ralph-works will not launch additional phase work until /ralph-works resume.";
}

function restorePausedNonLaunchingState(state: PipelineState): PipelineState | undefined {
  if (state.pipelineStatus !== "paused") return undefined;
  const phaseStatus = state.pausedFromPhaseStatus ?? state.phaseStatus;
  if (phaseStatus !== WAITING_FOR_USER_PHASE_STATUS && phaseStatus !== VALIDATION_FAILED_PHASE_STATUS) return undefined;
  return {
    ...withoutPendingSteer(state),
    pipelineStatus: "running",
    phaseStatus,
    pausedFromPhaseStatus: undefined,
    turnWriteCount: 0,
    readyToAdvancePhase: undefined,
  };
}

/** Decide whether to stop between planning and implementation for operator approval. */
function shouldPauseBeforeImplementCheckpoint(
  state: PipelineState,
  phases: string[],
  currentIdx: number,
  nextIdx: number,
  nextPhase: string,
): boolean {
  if (nextPhase !== "implement") return false;
  if (state.yoloMode || state.implementCheckpointApproved) return false;
  if (nextIdx <= 0) return false;
  if (phases[currentIdx] === "review") return false;
  return true;
}

/** Pause before implementation so the operator can inspect generated planning artifacts. */
function enterImplementCheckpoint(pi: ExtensionAPI, ctx: ExtensionContext, st: PipelineState): void {
  const checkpointState = buildImplementCheckpointState(st);
  saveState(pi, checkpointState);
  setPipelineWaitingUi(ctx, checkpointState);
  refreshWidget(ctx, checkpointState);
  const renderOption = st.phases?.includes(RENDER_PHASE)
    ? ""
    : " Or run /ralph-works continue --render-html (or /ralph-works continue html) to render the spec to HTML first.";
  ctx.ui.notify(
    `Review the completed planning phases before task-loop implementation. Run /ralph-works continue to approve.${renderOption} Start with --yolo to run straight through next time.`,
    "warning",
  );
}

function getCurrentThinkingLevel(pi: ExtensionAPI): ModelThinkingLevel | undefined {
  const value = (pi as unknown as { getThinkingLevel?: () => string }).getThinkingLevel?.();
  return ["off", "minimal", "low", "medium", "high", "xhigh"].includes(value ?? "")
    ? (value as ModelThinkingLevel)
    : undefined;
}

function validateModelPlanSelectors(
  ctx: ExtensionContext,
  plan: RalphModelPlan | undefined,
  phases: string[] = [],
): string[] {
  if (!plan) return [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const selector of selectedModelIds(plan)) {
    const id = formatModelSelector(selector);
    if (seen.has(id)) continue;
    seen.add(id);
    const found = ctx.modelRegistry?.find(selector.provider, selector.model);
    if (!found) errors.push(`Model not found: ${id}`);
  }

  if (plan.allowWeakModel) return errors;
  for (const phase of phases) {
    if (phase !== "implement" && phase !== "review") continue;
    const selector = resolvePhaseModelSelector(plan, phase);
    if (!selector) continue;
    const model = ctx.modelRegistry?.find(selector.provider, selector.model) as
      | { contextWindow?: number; maxTokens?: number }
      | undefined;
    if (!model) continue;
    if (typeof model.contextWindow === "number" && model.contextWindow < 64000) {
      errors.push(
        `${phase}: ${formatModelSelector(selector)} contextWindow ${model.contextWindow} is below 64000; pass --allow-weak-model to override.`,
      );
    }
    if (typeof model.maxTokens === "number" && model.maxTokens < 8000) {
      errors.push(
        `${phase}: ${formatModelSelector(selector)} maxTokens ${model.maxTokens} is below 8000; pass --allow-weak-model to override.`,
      );
    }
  }
  return errors;
}

function formatModelPlanSummary(plan: RalphModelPlan | undefined): string | undefined {
  if (!plan) return undefined;
  const parts: string[] = [];
  if (plan.default) parts.push(`default ${formatModelSelector(plan.default)} (${plan.default.source})`);
  for (const [phase, selector] of Object.entries(plan.phases ?? {})) {
    if (selector) parts.push(`${phase} ${formatModelSelector(selector)} (${selector.source})`);
  }
  return parts.length ? parts.join("; ") : undefined;
}

function appendModelEventState(state: PipelineState, event: ReturnType<typeof createModelSwitchEvent>): PipelineState {
  appendModelSwitchHistoryEvent(state, event);
  return appendModelSwitchHistory(state, event);
}

const PROVIDER_DRIFT_BLOCK_MODEL = "__ralph_model_drift_blocked__";
const PROVIDER_DRIFT_BLOCK_MESSAGE = "ralph-works blocked this provider request because the active model drifted.";

function buildBlockedProviderPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { model: PROVIDER_DRIFT_BLOCK_MODEL, messages: [{ role: "user", content: PROVIDER_DRIFT_BLOCK_MESSAGE }] };
  }
  const blocked: Record<string, unknown> = {
    ...(payload as Record<string, unknown>),
    model: PROVIDER_DRIFT_BLOCK_MODEL,
  };
  if ("messages" in blocked) blocked.messages = [{ role: "user", content: PROVIDER_DRIFT_BLOCK_MESSAGE }];
  if ("input" in blocked) blocked.input = PROVIDER_DRIFT_BLOCK_MESSAGE;
  if ("contents" in blocked) blocked.contents = [{ role: "user", parts: [{ text: PROVIDER_DRIFT_BLOCK_MESSAGE }] }];
  if ("system" in blocked) blocked.system = PROVIDER_DRIFT_BLOCK_MESSAGE;
  if ("prompt" in blocked) blocked.prompt = PROVIDER_DRIFT_BLOCK_MESSAGE;
  return blocked;
}

async function applyPhaseModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: PipelineState,
  eventName: "apply" | "reapply" = "apply",
): Promise<{ ok: true; state: PipelineState } | { ok: false; state: PipelineState; message: string }> {
  const phaseKey = state.currentPhase;
  if (!phaseKey) return { ok: true, state };
  const selector = resolvePhaseModelSelector(state.modelPlan, phaseKey);
  if (!selector) return { ok: true, state };

  const model = ctx.modelRegistry?.find(selector.provider, selector.model);
  if (!model) {
    const failed = appendModelEventState(
      state,
      createModelSwitchEvent("failure", selector, "failure", {
        phaseKey,
        reason: "model not found",
      }),
    );
    return { ok: false, state: failed, message: `Model not found: ${formatModelSelector(selector)}` };
  }

  try {
    const ok = await pi.setModel(model);
    if (!ok) {
      const failed = appendModelEventState(
        state,
        createModelSwitchEvent("failure", selector, "failure", {
          phaseKey,
          reason: "model unavailable or missing auth",
        }),
      );
      return { ok: false, state: failed, message: `No API key or auth for ${formatModelSelector(selector)}` };
    }
    if (selector.thinkingLevel) pi.setThinkingLevel(selector.thinkingLevel);
    const nonce = `${phaseKey}-${Date.now()}`;
    const applied: PipelineState = appendModelEventState(
      {
        ...state,
        phaseModelNonce: nonce,
        lastAppliedModel: {
          phaseKey,
          provider: selector.provider,
          model: selector.model,
          thinkingLevel: selector.thinkingLevel,
          appliedAt: Date.now(),
          nonce,
        },
      },
      createModelSwitchEvent(eventName, selector, "success", { phaseKey, nonce }),
    );
    return { ok: true, state: applied };
  } catch (error) {
    const failed = appendModelEventState(
      state,
      createModelSwitchEvent("failure", selector, "failure", {
        phaseKey,
        reason: String(error),
      }),
    );
    return {
      ok: false,
      state: failed,
      message: `Failed to switch to ${formatModelSelector(selector)}: ${String(error)}`,
    };
  }
}

async function enforcePhaseModelBeforeDispatch(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: PipelineState,
): Promise<PipelineState> {
  if (state.pipelineStatus !== "running" || state.phaseStatus !== "executing" || !state.currentPhase) return state;
  const selector = resolvePhaseModelSelector(state.modelPlan, state.currentPhase);
  if (!selector) return state;
  if (activeModelMatchesSelector(ctx.model, selector)) return state;

  const mismatch = appendModelEventState(
    state,
    createModelSwitchEvent("mismatch", selector, "blocked", {
      phaseKey: state.currentPhase,
      reason: `active model differs from expected ${formatModelSelector(selector)}`,
      nonce: state.phaseModelNonce,
    }),
  );
  const applied = await applyPhaseModel(pi, ctx, mismatch, "reapply");
  if (applied.ok) {
    saveState(pi, applied.state);
    return applied.state;
  }
  const failedState: PipelineState = { ...applied.state, pipelineStatus: "failed", phaseStatus: "pre_hook" };
  saveState(pi, failedState);
  refreshWidget(ctx, failedState);
  ctx.ui.notify(`Model drift guard failed: ${applied.message}`, "error");
  throw new Error(applied.message);
}

async function failClosedProviderRequestOnDrift(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: PipelineState,
  payload: unknown,
): Promise<unknown | undefined> {
  if (state.pipelineStatus !== "running" || state.phaseStatus !== "executing" || !state.currentPhase) return undefined;
  const selector = resolvePhaseModelSelector(state.modelPlan, state.currentPhase);
  if (!selector) return undefined;
  if (activeModelMatchesSelector(ctx.model, selector)) return undefined;

  const mismatch = appendModelEventState(
    state,
    createModelSwitchEvent("mismatch", selector, "blocked", {
      phaseKey: state.currentPhase,
      reason: `active model differs from expected ${formatModelSelector(selector)} at provider dispatch`,
      nonce: state.phaseModelNonce,
    }),
  );
  const blocked = appendModelEventState(
    mismatch,
    createModelSwitchEvent("failure", selector, "blocked", {
      phaseKey: state.currentPhase,
      reason: "provider dispatch blocked after model drift",
      nonce: state.phaseModelNonce,
    }),
  );
  const failedState: PipelineState = { ...blocked, pipelineStatus: "failed", phaseStatus: "pre_hook" };
  saveState(pi, failedState);
  refreshWidget(ctx, failedState);
  ctx.ui.notify(`Model drift guard blocked provider dispatch for ${formatModelSelector(selector)}.`, "error");
  return buildBlockedProviderPayload(payload);
}

async function restoreOriginalModelForTerminal(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: PipelineState,
): Promise<PipelineState> {
  if (!state.modelPlan || state.modelPlan.restoreOriginalOnComplete === false || !state.originalModel) return state;
  if (state.lastAppliedModel) {
    const lastSelector: RalphModelSelector = { ...state.lastAppliedModel, source: "cli" };
    if (!activeModelMatchesSelector(ctx.model, lastSelector)) {
      return appendModelEventState(
        state,
        createModelSwitchEvent("skipped-restore", state.originalModel, "skipped", {
          phaseKey: state.currentPhase,
          reason: "active model no longer matches last ralph-works-applied model",
          nonce: state.lastAppliedModel.nonce,
        }),
      );
    }
  }

  const model = ctx.modelRegistry?.find(state.originalModel.provider, state.originalModel.model);
  if (!model) {
    return appendModelEventState(
      state,
      createModelSwitchEvent("restore", state.originalModel, "failure", {
        phaseKey: state.currentPhase,
        reason: "original model not found",
      }),
    );
  }
  const ok = await pi.setModel(model);
  if (!ok) {
    return appendModelEventState(
      state,
      createModelSwitchEvent("restore", state.originalModel, "failure", {
        phaseKey: state.currentPhase,
        reason: "original model unavailable or missing auth",
      }),
    );
  }
  if (state.originalModel.thinkingLevel) pi.setThinkingLevel(state.originalModel.thinkingLevel);
  return appendModelEventState(
    state,
    createModelSwitchEvent("restore", state.originalModel, "success", { phaseKey: state.currentPhase }),
  );
}

async function saveTerminalFailure(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: PipelineState,
  status: "failed" | "halted",
  phaseStatus: string,
  message: string,
): Promise<void> {
  const restoredState = await restoreOriginalModelForTerminal(pi, ctx, state);
  const terminalState: PipelineState = {
    ...restoredState,
    pipelineStatus: status,
    phaseStatus,
    turnWriteCount: 0,
    waitingReason: undefined,
    readyToAdvancePhase: undefined,
    lastValidationFailure: state.lastValidationFailure ?? message,
  };
  saveState(pi, terminalState);
  refreshWidget(ctx, terminalState);
  ctx.ui.notify(message, "error");
}

/** Persist terminal success and switch the visible UI out of any waiting state. */
async function completePipeline(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: PipelineState,
  message?: string,
): Promise<void> {
  const restoredState = await restoreOriginalModelForTerminal(pi, ctx, state);
  const phases = restoredState.phases?.length ? restoredState.phases : DEFAULT_PHASES;
  const finalPhaseIndex = Math.max(0, phases.length - 1);
  const completedState: PipelineState = {
    ...restoredState,
    phases,
    currentPhase: phases[finalPhaseIndex],
    currentPhaseIndex: finalPhaseIndex,
    pipelineStatus: "completed",
    phaseStatus: "post_hook",
    turnWriteCount: 0,
    waitingReason: undefined,
    readyToAdvancePhase: undefined,
  };
  saveState(pi, completedState);
  refreshWidget(ctx, completedState);
  ctx.ui.notify(message ?? `✅ ralph-works loop complete for "${state.feature}"`, "info");
  ctx.ui.setStatus(UI_WIDGET_ID, undefined);
  writeDevCycleSummary(completedState);
  writeMetrics(completedState);
}

async function completeImplementPhaseFromTaskLoop(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: PipelineState,
): Promise<void> {
  const clearedState: PipelineState = {
    ...state,
    selectedTask: undefined,
    taskFile: taskFileRelativePath(state),
    turnWriteCount: 0,
    readyToAdvancePhase: undefined,
  };
  writePhaseCompletionMarker("implement", clearedState.workDir);
  await advancePhase(pi, ctx, markPhaseValidated(clearedState));
}

async function launchTaskSelector(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: PipelineState,
  options?: { asSteer?: boolean; asFollowUp?: boolean; prefixText?: string },
): Promise<void> {
  const taskPath = taskFileAbsolutePath(state);
  if (!fs.existsSync(taskPath)) {
    const message = `Task ledger not found at ${taskPath}. Run or resume the tasks phase before implementation.`;
    const failedState: PipelineState = { ...state, phaseStatus: "pre_hook", lastValidationFailure: message };
    saveState(pi, failedState);
    refreshWidget(ctx, failedState);
    ctx.ui.notify(message, "error");
    return;
  }

  const ledgerContent = fs.readFileSync(taskPath, "utf-8");
  const ledger = parseTaskLedger(ledgerContent);
  if (!selectNextTask(ledger.tasks)) {
    await completeImplementPhaseFromTaskLoop(pi, ctx, state);
    return;
  }

  const selectingState: PipelineState = {
    ...state,
    phaseStatus: "selecting_task",
    selectedTask: undefined,
    taskFile: taskFileRelativePath(state),
    turnWriteCount: 0,
    readyToAdvancePhase: undefined,
  };
  saveState(pi, selectingState);
  refreshWidget(ctx, selectingState);
  const prompt = options?.prefixText
    ? `${options.prefixText}\n\n${buildTaskSelectorPrompt(selectingState, ledgerContent)}`
    : buildTaskSelectorPrompt(selectingState, ledgerContent);
  sendPipelineUserMessage(pi, ctx, prompt, {
    deliverAs: options?.asSteer ? "steer" : options?.asFollowUp ? "followUp" : undefined,
  });
}

async function handleSelectedTaskMarker(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: PipelineState,
  assistantText: string,
): Promise<boolean> {
  if (state.currentPhase !== "implement" || state.phaseStatus !== "selecting_task") return false;
  const noTasksRemain = hasNoTasksRemainMarker(assistantText);
  const taskId = parseSelectedTaskMarker(assistantText);
  if (!noTasksRemain && !taskId) return false;

  const taskPath = taskFileAbsolutePath(state);
  if (!fs.existsSync(taskPath)) return false;
  const content = fs.readFileSync(taskPath, "utf-8");
  const ledger = parseTaskLedger(content);
  if (noTasksRemain) {
    const nextTask = selectNextTask(ledger.tasks);
    if (nextTask) {
      const selectingState: PipelineState = {
        ...state,
        phaseStatus: "selecting_task",
        selectedTask: undefined,
        taskFile: taskFileRelativePath(state),
      };
      saveState(pi, selectingState);
      refreshWidget(ctx, selectingState);
      sendPipelineUserMessage(
        pi,
        ctx,
        `Cannot advance from implement: ${nextTask.id} is still eligible in ${taskFileRelativePath(state)}. Select the next task or mark it blocked with evidence.`,
        { deliverAs: "steer" },
      );
      return true;
    }
    await completeImplementPhaseFromTaskLoop(pi, ctx, state);
    return true;
  }

  const selectedTask = ledger.tasks.find((task) => task.id === taskId);
  if (!selectedTask) {
    sendPipelineUserMessage(pi, ctx, `Selected task ${taskId} was not found in ${taskFileRelativePath(state)}.`, {
      deliverAs: "steer",
    });
    return true;
  }
  const expectedTask = selectNextTask(ledger.tasks);
  if (!expectedTask) {
    sendPipelineUserMessage(
      pi,
      ctx,
      `Selected task ${taskId} is not eligible because no pending unblocked task remains in ${taskFileRelativePath(state)}. Return RALPH_NO_TASKS_REMAIN or reopen a task explicitly.`,
      { deliverAs: "steer" },
    );
    return true;
  }
  if (expectedTask.id !== taskId) {
    sendPipelineUserMessage(
      pi,
      ctx,
      `Expected selector to choose ${expectedTask.id} from ${taskFileRelativePath(state)}, but got ${taskId}. Select the highest-priority eligible task.`,
      { deliverAs: "steer" },
    );
    return true;
  }

  const updatedContent = updateTaskStatus(content, taskId, "in_progress");
  fs.writeFileSync(taskPath, updatedContent, "utf-8");
  const updatedLedger = parseTaskLedger(updatedContent);
  const updatedTask = updatedLedger.tasks.find((task) => task.id === taskId) ?? {
    ...selectedTask,
    status: "in_progress" as const,
  };
  const selectedState: PipelineState = {
    ...state,
    selectedTask: updatedTask,
    taskFile: taskFileRelativePath(state),
    phaseStatus: "pre_hook",
    taskSelectorAttempts: 0,
  };
  saveState(pi, selectedState);
  await launchPhase(pi, ctx, selectedState, { asFollowUp: true });
  return true;
}

async function continueTaskLoopAfterStatus(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: PipelineState,
  status: "complete" | "blocked" | "partially_verified" | "needs_followup",
): Promise<void> {
  const task = state.selectedTask;
  if (!task) return;
  const taskPath = taskFileAbsolutePath(state);
  if (!fs.existsSync(taskPath)) return;

  if (status !== "blocked") {
    const gateResults = runLintGates(state.workDir);
    if (!gateResults.every((result) => result.pass)) {
      sendPipelineUserMessage(pi, ctx, `${formatGateResults(gateResults)}\n\nFix failures before task completion.`, {
        deliverAs: "steer",
      });
      saveState(pi, { ...state, turnWriteCount: 0, readyToAdvancePhase: undefined });
      return;
    }
  }

  const content = fs.readFileSync(taskPath, "utf-8");
  const updatedContent = updateTaskStatus(content, task.id, status);
  fs.writeFileSync(taskPath, updatedContent, "utf-8");
  const updatedLedger = parseTaskLedger(updatedContent);
  const nextTask = selectNextTask(updatedLedger.tasks);
  const nextState: PipelineState = {
    ...state,
    selectedTask: undefined,
    taskFile: taskFileRelativePath(state),
    taskLoopIteration: (state.taskLoopIteration ?? 0) + 1,
    lastTaskSignal: status,
    lastTaskSignalAt: Date.now(),
    turnWriteCount: 0,
    readyToAdvancePhase: undefined,
  };
  saveState(pi, nextState);
  refreshWidget(ctx, nextState);
  if (!nextTask) {
    await completeImplementPhaseFromTaskLoop(pi, ctx, nextState);
    return;
  }
  await launchTaskSelectorAfterTaskCompaction(pi, ctx, nextState);
}

async function launchTaskSelectorAfterTaskCompaction(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: PipelineState,
): Promise<void> {
  if (!isAutoClearContextEnabled(state)) {
    await launchTaskSelector(pi, ctx, state, { asFollowUp: true });
    return;
  }

  const autoCheckState = {
    ...state,
    phaseStatus: "selecting_task",
    lastContextClearAt: undefined,
  } as PipelineState;
  if (!canClearContext(autoCheckState).ok) {
    await launchTaskSelector(pi, ctx, state, { asFollowUp: true });
    return;
  }

  setPipelineCompactingUi(ctx, state);
  ctx.compact({
    customInstructions:
      "Preserve Ralph implementation task loop state. Focus on selecting the next task from the task ledger.",
    onComplete: () => {
      try {
        const latest = getState(ctx) ?? state;
        if (!latest || latest.pipelineStatus !== "running") return;
        const updated: PipelineState = {
          ...latest,
          contextClearCount: (latest.contextClearCount ?? 0) + 1,
          lastContextClearAt: Date.now(),
        };
        saveState(pi, updated);
        void launchTaskSelector(pi, ctx, updated, {
          asFollowUp: true,
          prefixText: "⛔ CONTEXT RESET — Select the next Ralph implementation task.",
        });
      } catch {
        // Auto-clear is best-effort; the task ledger remains the source of truth.
      }
    },
    onError: () => {
      void launchTaskSelector(pi, ctx, state, { asFollowUp: true });
    },
  });
}

async function handleTaskStatusMarker(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: PipelineState,
  assistantText: string,
): Promise<boolean> {
  if (state.currentPhase !== "implement" || state.phaseStatus !== "executing" || !state.selectedTask) return false;
  const status = parseTaskStatusMarker(assistantText);
  if (!status) return false;
  await continueTaskLoopAfterStatus(pi, ctx, state, status);
  return true;
}

/**
 * Validate prerequisites, persist executing state, refresh UI, then prompt the
 * agent for the current phase. This is the only normal phase-entry path.
 */
async function launchPhase(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: PipelineState,
  options?: { asSteer?: boolean; asFollowUp?: boolean; prefixText?: string },
): Promise<void> {
  const pk = state.currentPhase;
  if (!pk) return;
  const workDirWarning = buildWorkDirPolicyWarning(state);
  if (workDirWarning) ctx.ui.notify(workDirWarning, "warning");
  if (!runPreHook(pk, state)) {
    const failureMessage = [
      `Pre-hook failed for phase "${pk}". Fix prerequisites and /ralph-works resume.`,
      workDirWarning,
    ]
      .filter(Boolean)
      .join("\n\n");
    ctx.ui.notify(failureMessage, "error");
    const failedState: PipelineState = {
      ...state,
      pipelineStatus: "failed",
      phaseStatus: "pre_hook",
      lastValidationFailure: failureMessage,
    };
    saveState(pi, failedState);
    refreshWidget(ctx, failedState);
    return;
  }

  if (pk === "implement" && !state.selectedTask) {
    await launchTaskSelector(pi, ctx, state, options);
    return;
  }

  const executingState = enterPhaseExecution(state);
  const selector = resolvePhaseModelSelector(executingState.modelPlan, pk);
  const applied = selector
    ? await applyPhaseModel(pi, ctx, executingState, "apply")
    : { ok: true as const, state: executingState };
  if (!applied.ok) {
    await saveTerminalFailure(pi, ctx, applied.state, "failed", "pre_hook", applied.message);
    return;
  }
  saveState(pi, applied.state);
  setPipelineWorkingUi(ctx, applied.state);
  refreshWidget(ctx, applied.state);
  const promptOptions = workDirWarning
    ? { ...options, prefixText: [workDirWarning, options?.prefixText].filter(Boolean).join("\n\n") }
    : options;
  sendPhasePrompt(pi, ctx, applied.state, promptOptions);
}

/**
 * Move from a completed phase to the next phase or terminal success state.
 * This owns boundary side effects: summaries, checkpoint pauses, auto-compaction,
 * and deterministic next-phase launch.
 */
async function advancePhase(pi: ExtensionAPI, ctx: ExtensionContext, state: PipelineState): Promise<void> {
  const phases = state.phases?.length ? state.phases : DEFAULT_PHASES;
  const idx = state.currentPhaseIndex ?? 0;
  const completion = resolvePhaseCompletion(phases, idx, "explicit_signal");
  if (completion.action === "complete_pipeline") {
    await completePipeline(pi, ctx, state);
    return;
  }

  const nextIdx = completion.nextPhaseIndex ?? Math.min(idx + 1, phases.length - 1);
  const nextPhase = completion.nextPhase ?? phases[nextIdx];
  const meta = PHASE_META[nextPhase];
  const u = enterPhasePreHook(state, { phaseIndex: nextIdx, phase: nextPhase });

  const pauseBeforeImplement = shouldPauseBeforeImplementCheckpoint(state, phases, idx, nextIdx, nextPhase);
  const transitionState = pauseBeforeImplement ? buildImplementCheckpointState(u) : u;

  saveState(pi, transitionState);
  refreshWidget(ctx, transitionState);

  // Auto-clear at every phase boundary by default. Check before pre_hook blocks it,
  // and ignore the manual clear cooldown so quick phase completions still compact.
  if (isAutoClearContextEnabled(state)) {
    const autoCheckState = {
      ...transitionState,
      phaseStatus: "executing",
      lastContextClearAt: undefined,
    } as PipelineState;
    const autoCheck = canClearContext(autoCheckState);
    if (autoCheck.ok) {
      setPipelineCompactingUi(ctx, transitionState);
      ctx.compact({
        customInstructions: "Preserve pipeline phase context. Focus on transitioning to the new phase.",
        onComplete: () => {
          try {
            // Re-validate the persisted transition shape before launching the next phase.
            if (!canClearContext(autoCheckState).ok) {
              if (pauseBeforeImplement) enterImplementCheckpoint(pi, ctx, transitionState);
              else {
                setPipelineWorkingUi(ctx, transitionState);
                refreshWidget(ctx, transitionState);
              }
              return;
            }
            const updated = {
              ...transitionState,
              contextClearCount: (transitionState.contextClearCount ?? 0) + 1,
              lastContextClearAt: Date.now(),
            };
            if (pauseBeforeImplement) {
              enterImplementCheckpoint(pi, ctx, updated);
              return;
            }
            void launchPhase(pi, ctx, updated, {
              asFollowUp: true,
              prefixText: `⛔ CONTEXT RESET — Continue with Phase ${nextIdx + 1}: ${meta?.name ?? nextPhase}.`,
            });
          } catch {
            // Silent failure — auto-clear is best-effort
          }
        },
        onError: () => {
          if (pauseBeforeImplement) enterImplementCheckpoint(pi, ctx, transitionState);
          else void launchPhase(pi, ctx, transitionState, { asFollowUp: true });
        },
      });
      return;
    }
  }

  if (pauseBeforeImplement) {
    enterImplementCheckpoint(pi, ctx, transitionState);
    return;
  }

  await launchPhase(pi, ctx, transitionState, { asFollowUp: true });
}

/** Handle the structured review verdict tool and backtrack on critical findings. */
async function handleReviewDecision(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  params: { status: string; issues?: string[] },
): Promise<void> {
  const state = getState(ctx);
  if (!state) return;
  // Phase gate — reject decisions from non-review phases
  if (state.currentPhase !== "review") {
    ctx.ui.notify(
      `ERROR: ralph_review_decision can only be called during review phase (current: ${state.currentPhase}).`,
      "error",
    );
    return;
  }
  const status = params.status as "LGTM" | "CRITICAL";
  const iter = state.reviewIterations ?? 0;
  if (status === "LGTM") {
    await completePipeline(pi, ctx, state, `✅ ralph-works review LGTM. Loop complete for "${state.feature}"`);
  } else if (status === "CRITICAL") {
    const maxIters = state.maxIterations ?? 10;
    if (iter >= maxIters) {
      await saveTerminalFailure(
        pi,
        ctx,
        state,
        "halted",
        state.phaseStatus ?? "post_hook",
        `Max review iterations (${maxIters}) reached — halted.`,
      );
      return;
    }
    const taskPath = taskFileAbsolutePath(state);
    if (params.issues?.length && fs.existsSync(taskPath)) {
      const now = new Date().toISOString();
      const reviewTasks = params.issues.map((issue, index) => ({
        title: issue,
        priority: "P0" as const,
        reviewFindingRef: `review-${iter + 1} issue-${index + 1}`,
        acceptanceCriteria: [`${issue} is remediated.`],
        testPlan: ["Add or update a regression test that fails before the remediation."],
        filesHint: [],
      }));
      fs.writeFileSync(taskPath, appendReviewTasks(fs.readFileSync(taskPath, "utf-8"), reviewTasks, now), "utf-8");
    }
    const phases = state.phases ?? DEFAULT_PHASES;
    const implIdx = phases.indexOf("implement");
    const u = enterPhasePreHook(
      {
        ...state,
        reviewIterations: iter + 1,
        implementCheckpointApproved: true,
        selectedTask: undefined,
        taskFile: taskFileRelativePath(state),
      },
      {
        phaseIndex: implIdx >= 0 ? implIdx : 3,
        phase: "implement",
      },
    );
    saveState(pi, u);
    refreshWidget(ctx, u);
    ctx.ui.notify(`⚠️ Review CRITICAL (iteration ${iter + 1}/${maxIters}) — backtracking to implement`, "warning");
    const steerText = params.issues?.length
      ? `\n\nCRITICAL issues:\n${params.issues.map((i) => `- ${i}`).join("\n")}`
      : "";
    await launchPhase(pi, ctx, u, {
      asSteer: true,
      prefixText: `⛔ REVIEW CRITICAL — Backtrack to implement.${steerText}`,
    });
  }
}

function buildImplementGateReminder(state: PipelineState): string {
  const resolution = resolveGateConfiguration(state.workDir);
  const taskLabel = state.selectedTask ? `selected task ${state.selectedTask.id}` : "selected task";
  if (resolution.errors.length > 0) {
    return `ralph-works gate configuration is invalid at ${resolution.source}. Fix the gate config or run the repository's documented test commands manually before completing ${taskLabel}. Errors:\n${resolution.errors.map((error) => `- ${error}`).join("\n")}`;
  }
  if (resolution.gates.length > 0) {
    return `The ${taskLabel} is still in the TDD loop. Configured ralph-works gates are available; call the registered \`ralph_gate_check\` tool now if the task is complete. Do not run \`ralph_gate_check\` in \`bash\`; it is a Pi extension tool, not a shell command. If the tool is not visible, continue with documented project commands and let the controller run configured gates before accepting \`RALPH_TASK_COMPLETE\`.`;
  }
  return `The ${taskLabel} is still in the TDD loop. ralph-works gates are not configured for this workDir, so do not assume default lint/typecheck/test commands. Run the repository's documented test commands manually, then end the final assistant message with \`RALPH_TASK_COMPLETE\` when the selected task is complete.`;
}

/**
 * Run post-hook validation after an explicit phase-complete signal.
 * Failed validation keeps the same phase active and sends remediation guidance.
 */
async function handlePhaseCompletion(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<{ ok: boolean; message: string }> {
  const state = getState(ctx);
  if (!state) return { ok: false, message: "No active pipeline." };
  if (state.pipelineStatus !== "running")
    return { ok: false, message: `Pipeline is not running (status: ${state.pipelineStatus ?? "unknown"}).` };
  if (state.currentPhase === "review")
    return { ok: false, message: "Review phase must end via `ralph_review_decision`, not the completion marker." };
  if (state.phaseStatus !== "executing" && state.phaseStatus !== VALIDATION_FAILED_PHASE_STATUS)
    return { ok: false, message: `Current phase is not executing (status: ${state.phaseStatus ?? "unknown"}).` };

  const phases = state.phases?.length ? state.phases : DEFAULT_PHASES;
  const idx = state.currentPhaseIndex ?? 0;
  const pk = phases[idx];
  if (!pk) return { ok: false, message: "Current phase is invalid." };

  const result = runPostHook(pk, state);
  if (!result.pass) {
    const attempts = state.phaseAttempts ?? 0;
    const failureDetails = formatPostHookFailure(pk, state, result);
    if (attempts >= MAX_PHASE_ATTEMPTS) {
      await saveTerminalFailure(
        pi,
        ctx,
        { ...state, lastValidationFailure: failureDetails },
        "failed",
        "post_hook",
        `Phase "${pk}" failed ${MAX_PHASE_ATTEMPTS} times — halted.\n${failureDetails}`,
      );
      return { ok: false, message: failureDetails };
    }

    ctx.ui.notify(
      `Post-hook failed for "${pk}" (attempt ${attempts + 1}/${MAX_PHASE_ATTEMPTS})\n${failureDetails}`,
      "warning",
    );
    const retryInstruction =
      pk === "implement"
        ? `Fix implementation validation failures. ${buildImplementGateReminder(state)}`
        : "Fix the expected phase artifacts under the persisted workDir, then retry phase completion.";
    sendPipelineUserMessage(pi, ctx, `⛔ Phase validation failed:\n\n${failureDetails}\n\n${retryInstruction}`, {
      deliverAs: "steer",
    });
    const updatedState = enterValidationFailed(state, failureDetails);
    saveState(pi, updatedState);
    refreshWidget(ctx, updatedState);
    return { ok: false, message: failureDetails };
  }

  writePhaseCompletionMarker(pk, state.workDir);
  await advancePhase(pi, ctx, markPhaseValidated(state));
  return { ok: true, message: `Phase "${pk}" completion recorded.` };
}

/**
 * Interpret the assistant's finished turn without treating every turn as a
 * phase boundary. Non-review phases advance only through explicit completion.
 * Implement task-loop turns must use a task-level completion marker.
 */
async function handleAgentEnd(
  pi: ExtensionAPI,
  event: { messages: Array<{ role?: string; content?: unknown }> },
  ctx: ExtensionContext,
) {
  const state = getState(ctx);
  if (!state) return;
  if (state.pipelineStatus !== "running") {
    refreshWidget(ctx, state);
    return;
  }
  const lastAssistantMessage = [...event.messages].reverse().find((message) => message.role === "assistant");
  const assistantText = extractMessageText(lastAssistantMessage?.content);
  const phases = state.phases?.length ? state.phases : DEFAULT_PHASES;
  const idx = state.currentPhaseIndex ?? 0;
  if (await handleSelectedTaskMarker(pi, ctx, state, assistantText)) return;
  if (await handleTaskStatusMarker(pi, ctx, state, assistantText)) return;
  if (
    state.currentPhase === "implement" &&
    state.phaseStatus === "executing" &&
    hasPhaseCompletionMarker(assistantText)
  ) {
    sendPipelineUserMessage(
      pi,
      ctx,
      state.selectedTask
        ? `Use RALPH_TASK_COMPLETE, RALPH_TASK_BLOCKED, RALPH_TASK_PARTIALLY_VERIFIED, or RALPH_TASK_NEEDS_FOLLOWUP for ${state.selectedTask.id}. The implement phase no longer accepts ${PHASE_COMPLETE_MARKER} while a task is active.`
        : `The implement phase now requires Ralph to select a task before TDD starts. ${PHASE_COMPLETE_MARKER} is not accepted for broad implementation.`,
      { deliverAs: "steer" },
    );
    saveState(pi, { ...state, turnWriteCount: 0, readyToAdvancePhase: undefined });
    refreshWidget(ctx, state);
    return;
  }
  if (state.currentPhase === "review" && state.phaseStatus === "executing" && isLgtmReviewText(assistantText)) {
    await completePipeline(
      pi,
      ctx,
      state,
      `✅ ralph-works review LGTM: no critical bugs found. Loop complete for "${state.feature}"`,
    );
    return;
  }

  if (state.currentPhase !== "review" && hasPhaseCompletionMarker(assistantText)) {
    const completion = resolvePhaseCompletion(phases, idx, "explicit_signal");
    if (completion.action !== "wait_for_explicit_completion") {
      await handlePhaseCompletion(pi, ctx);
      return;
    }
  }

  if (state.currentPhase === "implement" && state.phaseStatus === "executing") {
    if (state.lastValidationFailure) {
      refreshWidget(ctx, state);
      return;
    }
    sendDedupedPipelineUserMessage(pi, ctx, state, buildImplementGateReminder(state), {
      deliverAs: "steer",
      dedupeKey: `implement-gate:${idx}`,
    });
    return;
  }

  if (state.phaseStatus === VALIDATION_FAILED_PHASE_STATUS) {
    refreshWidget(ctx, state);
    return;
  }

  const completion = resolvePhaseCompletion(phases, idx, "agent_end");
  if (completion.action === "wait_for_explicit_completion") enterWaitingForUser(pi, ctx, state);
}

// ── Extension Entry Point ──────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Note: turnWriteCount is tracked in PipelineState, not module-level,
  // to survive page reloads and session compaction.

  pi.on("message_start", async (event, ctx) => {
    const state = getState(ctx);
    if (!state || state.pipelineStatus !== "running" || event.message.role !== "assistant") return;
    if (state.waitingReason === IMPLEMENT_CHECKPOINT_WAIT_REASON) {
      setPipelineWaitingUi(ctx, state);
      refreshWidget(ctx, state);
      return;
    }
    // A new assistant turn means any pending steer has been accepted by Pi.
    const nextState = withoutPendingSteer(state);
    const updated: PipelineState =
      nextState.phaseStatus === WAITING_FOR_USER_PHASE_STATUS
        ? { ...nextState, phaseStatus: "executing", turnWriteCount: 0 }
        : { ...nextState, turnWriteCount: 0 };
    saveState(pi, updated);
    setPipelineWorkingUi(ctx, updated);
  });

  pi.on("message_update", async (_event, ctx) => {
    const state = getState(ctx);
    if (!state || state.pipelineStatus !== "running" || _event.message.role !== "assistant") return;
    refreshWidget(ctx, state);
  });

  pi.on("input", async (event, ctx) => {
    const state = getState(ctx);
    if (!state || state.pipelineStatus !== "running") return;
    if (state.phaseStatus !== WAITING_FOR_USER_PHASE_STATUS) return;
    if (event.text.trim().startsWith("/")) return;
    if (state.waitingReason === IMPLEMENT_CHECKPOINT_WAIT_REASON) {
      ctx.ui.notify(
        "Task-loop implementation is waiting for review approval. Run /ralph-works continue to launch it.",
        "warning",
      );
      setPipelineWaitingUi(ctx, state);
      refreshWidget(ctx, state);
      return;
    }
    // Regular user text is treated as the operator answering a waiting prompt.
    const updated: PipelineState = { ...state, phaseStatus: "executing", turnWriteCount: 0 };
    saveState(pi, updated);
    setPipelineWorkingUi(ctx, updated);
    refreshWidget(ctx, updated);
  });

  pi.on("session_start", async (_event, ctx) => {
    const state = getState(ctx);
    if (!state) return;
    const phases = state.phases?.length ? state.phases : DEFAULT_PHASES;
    ctx.ui.notify(`ralph-works loop: ${state.feature} (${phases.join(", ")})`, "info");
    if (state.pipelineStatus !== "running") {
      refreshWidget(ctx, state);
      return;
    }
    if (state.phaseStatus === WAITING_FOR_USER_PHASE_STATUS) setPipelineWaitingUi(ctx, state);
    else setPipelineWorkingUi(ctx, state);
    refreshWidget(ctx, state);

    const currentIdx = state.currentPhaseIndex ?? 0;

    // Guard against corrupted phase index from aggressive compaction
    if (!validatePhaseIndex(currentIdx, phases)) {
      ctx.ui.notify(
        `⛔ Pipeline state corrupted: currentPhaseIndex=${currentIdx} out of bounds. Run /ralph-works cancel to reset.`,
        "error",
      );
      saveState(pi, { ...state, pipelineStatus: "failed", phaseStatus: "corrupted" });
      return;
    }

    const action = resolveSessionStartAction(state);
    if (action === "resume_execution") {
      const pk = phases[currentIdx];
      const phasePrompt = buildPhasePrompt(pk, state);
      const steerText = wrapSteerMessage(
        `⛔ SESSION RELOAD — Resuming Phase ${currentIdx + 1}: ${PHASE_META[pk]?.name}.

You were interrupted mid-phase. The phase-specific instructions are below — follow them completely before the extension advances you to the next phase.

---

${phasePrompt}`,
        MAX_STEER_SIZE,
      );
      ctx.ui.notify(`Resuming Phase ${currentIdx + 1} (${PHASE_META[pk]?.name})`, "warning");
      sendDedupedPipelineUserMessage(pi, ctx, state, steerText, {
        deliverAs: "steer",
        wrapSteer: false,
      });
      return;
    }

    if (action === "launch_pending_phase") {
      const pk = phases[currentIdx];
      ctx.ui.notify(`Launching queued Phase ${currentIdx + 1} (${PHASE_META[pk]?.name ?? pk})`, "warning");
      await launchPhase(pi, ctx, state, {
        asSteer: true,
        prefixText: `⛔ SESSION RELOAD — Launch queued Phase ${currentIdx + 1}: ${PHASE_META[pk]?.name ?? pk}.`,
      });
    }
  });

  // Auto-gate on write operations during gate phases
  pi.on("tool_result", async (event, ctx) => {
    const state = getState(ctx);
    if (!state || state.pipelineStatus !== "running") return;
    if (!GATE_PHASES.has(state.currentPhase ?? "")) return;
    const currentCount = state.turnWriteCount ?? 0;
    if (event.toolName === "write" || event.toolName === "edit") {
      const newCount = currentCount + 1;
      if (newCount >= GATE_THRESHOLD) {
        const gateResolution = resolveGateConfiguration(state.workDir);
        saveState(pi, {
          ...state,
          turnWriteCount: 0,
          readyToAdvancePhase: undefined,
        });
        if (!gateResolution.configured) return;
        ctx.ui.notify("🚧 Auto-gate: running lint checks...", "info");
        const results = runLintGates(state.workDir);
        if (results.every((r) => r.pass)) {
          ctx.ui.notify("✅ All gates passed", "info");
        } else {
          ctx.ui.notify(
            `❌ Gate failure: ${results
              .filter((r) => !r.pass)
              .map((r) => r.name)
              .join(", ")}`,
            "error",
          );
          if (state.readyToAdvancePhase) saveState(pi, { ...state, turnWriteCount: 0, readyToAdvancePhase: undefined });
          sendPipelineUserMessage(pi, ctx, `${formatGateResults(results)}\n\nFix and re-check.`, {
            deliverAs: "steer",
          });
        }
        return;
      }
      saveState(pi, { ...state, turnWriteCount: newCount });
    } else {
      saveState(pi, { ...state, turnWriteCount: 0 });
    }
  });

  // Agent end → post-hook → state machine advance
  pi.on("agent_end", async (event, ctx) => {
    const state = getState(ctx);
    if (!state || state.pipelineStatus !== "running") return;
    saveState(pi, { ...state, turnWriteCount: 0 });
    await handleAgentEnd(pi, event as { messages: Array<{ role?: string; content?: unknown }> }, ctx);
  });

  // ── Tool: ralph_set_workdir ─────────────────────────────
  pi.registerTool({
    name: "ralph_set_workdir",
    label: "ralph-works Set WorkDir",
    description: "Update the active ralph-works run root when work moves into a dedicated git worktree.",
    promptSnippet:
      "If you create or switch to a dedicated git worktree, call this with the worktree root before writing artifacts or completing the phase.",
    parameters: Type.Object({ workDir: Type.String() }),
    async execute(_id, params, _sig, _onUpdate, ctx) {
      const state = getState(ctx);
      if (!state) return { content: [{ type: "text", text: "No active pipeline." }], details: {} };
      const requestedWorkDir = String((params as { workDir?: string }).workDir ?? "").trim();
      if (!requestedWorkDir) return { content: [{ type: "text", text: "Missing required workDir." }], details: {} };
      const resolution = resolvePipelineWorkDir(state.workDir, requestedWorkDir, ctx.cwd);
      if (!resolution.ok || !resolution.workDir) {
        return { content: [{ type: "text", text: `ERROR: ${resolution.message}` }], details: resolution };
      }

      const updated: PipelineState = {
        ...state,
        workDir: resolution.workDir,
        turnWriteCount: 0,
        lastValidationFailure: undefined,
      };
      saveState(pi, updated);
      refreshWidget(ctx, updated);
      ctx.ui.notify(resolution.message, "info");
      return { content: [{ type: "text", text: resolution.message }], details: { workDir: resolution.workDir } };
    },
  });

  // ── Tool: ralph_gate_check ──────────────────────────────
  pi.registerTool({
    name: "ralph_gate_check",
    label: "ralph-works Gate Check",
    description: "Run configured ralph-works quality gates from .ralph/gate-config.json.",
    promptSnippet: "Run configured ralph-works gates after implementation/remediation",
    parameters: Type.Object({ paths: Type.Optional(Type.Array(Type.String())) }),
    async execute(_id, params, _sig, onUpdate, ctx) {
      const state = getState(ctx);
      if (!state) return { content: [{ type: "text", text: "No active pipeline." }], details: {} };
      // Pi's callback type is generic, but this tool only streams text updates.
      const update = onUpdate as undefined | ((value: { content: Array<{ type: "text"; text: string }> }) => void);
      update?.({ content: [{ type: "text", text: "🚧 Running configured ralph-works gates..." }] });
      const results = runLintGates(state.workDir, params.paths);
      const allPass = results.every((r) => r.pass);
      const noConfiguredGates = results.every((r) => r.skipped);
      saveState(pi, {
        ...state,
        turnWriteCount: 0,
        readyToAdvancePhase: undefined,
      });
      const failed = results.filter((r) => !r.pass);
      const heading = noConfiguredGates
        ? "No ralph-works Gates Configured"
        : allPass
          ? "✅ All Gates Passed"
          : "❌ Gate Failures";
      const report = [
        `## ${heading}`,
        "",
        `| Gate | Status | Command | Source |`,
        `|------|--------|---------|--------|`,
        ...results.map(
          (r) => `| ${r.name} | ${r.pass ? "✅ PASS" : "❌ FAIL"} | ${r.command ?? ""} | ${r.source ?? ""} |`,
        ),
        "",
      ];
      for (const result of results.filter((r) => !r.pass || r.skipped)) {
        report.push(`\`${result.output.slice(0, 3000)}\``);
      }
      report.push(
        noConfiguredGates
          ? "No configured ralph-works gates were run. Run the repository's documented test commands manually."
          : allPass
            ? state.currentPhase === "implement"
              ? "All configured gates passed. End the selected task with RALPH_TASK_COMPLETE when task work is ready."
              : "All configured gates passed."
            : "Fix failures and re-run ralph_gate_check.",
      );
      ctx.ui.setStatus(
        UI_WIDGET_ID,
        noConfiguredGates
          ? "No ralph-works gates configured"
          : allPass
            ? `✅ Gates clear`
            : `❌ Gates: ${failed.map((f) => f.name).join(", ")}`,
      );
      return { content: [{ type: "text", text: report.join("\n") }], details: { results, allPass } };
    },
  });

  // ── Tool: ralph_review_decision ────────────────────────
  pi.registerTool({
    name: "ralph_review_decision",
    label: "ralph-works Review Decision",
    description: "Submit final review verdict. Only call during review phase.",
    parameters: Type.Object({
      status: Type.Union([Type.Literal("LGTM"), Type.Literal("CRITICAL")]),
      issues: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id, params, _sig, onUpdate, ctx) {
      const state = getState(ctx);
      if (!state) return { content: [{ type: "text", text: "No active pipeline." }], details: {} };
      // Phase gate — reject decisions from non-review phases
      if (state.currentPhase !== "review")
        return {
          content: [
            {
              type: "text",
              text: `ERROR: ralph_review_decision can only be called during review phase (current: ${state.currentPhase}).`,
            },
          ],
          details: {},
        };
      await handleReviewDecision(pi, ctx, params as { status: string; issues?: string[] });
      return { content: [{ type: "text", text: `Decision recorded: ${params.status}` }], details: {} };
    },
  });

  // ── Command: /ralph-works ────────────────────────────────────
  pi.registerCommand(USER_COMMAND_NAME, {
    description: "Dev-cycle pipeline (start | status | cancel | gate | set-workdir | continue | resume | pause)",
    getArgumentCompletions: (prefix: string) => {
      const items = RALPH_TOP_LEVEL_COMMANDS.map((v) => ({ value: v, label: v }));
      return items.filter((i) => i.value.startsWith(prefix));
    },
    handler: async (args, ctx) => {
      const parts = parseCommandArgs(args.trim());
      const cmd = parts[0]?.toLowerCase();
      switch (cmd) {
        case "start": {
          if (blocksNewPipelineStart(getState(ctx))) {
            ctx.ui.notify("Pipeline already running. /ralph-works cancel first.", "error");
            return;
          }
          const feature = parts[1];
          if (!feature) {
            ctx.ui.notify(
              "Usage: /ralph-works start <feature> [prompt] [phases] [--model provider/model[:thinking]] [--models phase=provider/model[:thinking],...] [--trust-model-plan] [--render-html|html] [--yolo]",
              "error",
            );
            return;
          }
          const validPhases = new Set<string>(PHASE_ORDER);
          let phases: string[] = [...DEFAULT_PHASES];
          let promptArg: string | undefined;
          const parsedStartArgs = parseRalphFlags(parts.slice(2));
          if (parsedStartArgs.errors.length) {
            ctx.ui.notify(parsedStartArgs.errors.join("\n"), "error");
            return;
          }
          if (parsedStartArgs.args[0]) {
            // Ambiguous second arg: an all-phase token is a phase list; otherwise it is prompt text.
            const mp = parsedStartArgs.args[0].split(",").map((p) => p.trim());
            if (mp.every((p) => validPhases.has(p))) {
              phases = mp;
            } else {
              promptArg = parsedStartArgs.args[0];
              if (parsedStartArgs.args[1]) {
                const rp = parsedStartArgs.args[1]
                  .split(",")
                  .map((p) => p.trim())
                  .filter((p) => validPhases.has(p));
                if (rp.length) phases = rp;
              }
            }
          }
          if (parsedStartArgs.renderHtml) phases = addRenderPhase(phases);
          // Validate phase order before creating locks or writing session state.
          const validation = validatePhaseOrder(phases);
          if (!validation.valid) {
            ctx.ui.notify(`Invalid phase order: ${validation.error}`, "error");
            return;
          }
          const missingSkills = getMissingPhaseSkillPrerequisites(phases);
          if (missingSkills.length) {
            ctx.ui.notify(formatMissingPhaseSkillPrerequisites(missingSkills), "error");
            return;
          }
          const modelPlanResult = buildModelPlanFromOptions(parsedStartArgs, phases, ctx.cwd);
          for (const warning of modelPlanResult.warnings) ctx.ui.notify(warning, "warning");
          const modelPlanErrors = [
            ...modelPlanResult.errors,
            ...validateModelPlanSelectors(ctx, modelPlanResult.plan, phases),
          ];
          if (modelPlanErrors.length) {
            ctx.ui.notify(modelPlanErrors.join("\n"), "error");
            return;
          }
          const promptText = promptArg ? resolvePromptInput(promptArg, ctx.cwd) : undefined;
          const lockCheck = checkPipelineLock(feature, ctx.cwd);
          if (lockCheck.locked && !lockCheck.stale) {
            ctx.ui.notify("Pipeline already running — /ralph-works cancel first.", "error");
            return;
          }
          createPipelineLock(feature, ctx.cwd);
          const state: PipelineState = {
            feature,
            workDir: ctx.cwd,
            phases,
            maxIterations: 10,
            startedAt: Date.now(),
            currentPhaseIndex: 0,
            currentPhase: phases[0],
            phaseStatus: "pre_hook",
            pipelineStatus: "running",
            reviewIterations: 0,
            phaseAttempts: 0,
            turnWriteCount: 0,
            promptText,
            autoClearContext: true,
            yoloMode: parsedStartArgs.yolo,
            modelPlan: modelPlanResult.plan,
            originalModel: selectorFromCurrentModel(ctx.model, getCurrentThinkingLevel(pi)),
          };
          saveState(pi, state);
          refreshWidget(ctx, state);
          ctx.ui.notify(`Starting pipeline for "${feature}" (${phases.join(", ")})`, "info");
          await launchPhase(pi, ctx, state);
          if (getState(ctx)?.pipelineStatus === "failed") removePipelineLock(feature, ctx.cwd);
          break;
        }
        case "continue": {
          const state = getState(ctx);
          if (!state) {
            ctx.ui.notify("No pipeline to continue.", "error");
            return;
          }
          if (state.pipelineStatus === "completed") {
            ctx.ui.notify("Pipeline already completed.", "info");
            return;
          }
          if (state.pipelineStatus === "cancelled") {
            ctx.ui.notify("Pipeline was cancelled. Start a new pipeline with /ralph-works start.", "error");
            return;
          }

          const continueArgs = parseRalphFlags(parts.slice(1));
          if (continueArgs.errors.length) {
            ctx.ui.notify(continueArgs.errors.join("\n"), "error");
            return;
          }
          if (state.phaseStatus === VALIDATION_FAILED_PHASE_STATUS) {
            removePipelineLock(state.feature, state.workDir);
            createPipelineLock(state.feature, state.workDir);
            ctx.ui.notify(
              `Re-running validation for Phase ${(state.currentPhaseIndex ?? 0) + 1} (${PHASE_META[state.currentPhase ?? ""]?.name ?? state.currentPhase ?? "unknown"})`,
              "info",
            );
            await handlePhaseCompletion(pi, ctx);
            break;
          }
          const basePhases = state.phases?.length ? state.phases : DEFAULT_PHASES;
          let phases = [...basePhases];
          let targetIdx = state.currentPhaseIndex ?? 0;
          if (!validatePhaseIndex(targetIdx, phases)) {
            ctx.ui.notify(
              `⛔ Pipeline state corrupted: currentPhaseIndex=${targetIdx} out of bounds. Run /ralph-works cancel to reset.`,
              "error",
            );
            saveState(pi, { ...state, pipelineStatus: "failed", phaseStatus: "corrupted" });
            return;
          }
          let renderFromImplementCheckpoint = false;
          if (continueArgs.renderHtml && !phases.includes(RENDER_PHASE)) {
            renderFromImplementCheckpoint =
              state.waitingReason === IMPLEMENT_CHECKPOINT_WAIT_REASON && phases[targetIdx] === "implement";
            if (!renderFromImplementCheckpoint && !canAddRenderBeforeCurrentPhase(phases, targetIdx)) {
              ctx.ui.notify(
                `Cannot enable HTML rendering after the render point has passed. Current phase: ${phases[targetIdx] ?? "unknown"}.`,
                "error",
              );
              return;
            }
            phases = addRenderPhase(phases);
            targetIdx = renderFromImplementCheckpoint
              ? phases.indexOf(RENDER_PHASE)
              : resolveCurrentPhaseIndex(state, phases, targetIdx);
          }
          const validation = validatePhaseOrder(phases);
          if (!validation.valid) {
            ctx.ui.notify(`Invalid phase order: ${validation.error}`, "error");
            return;
          }
          const hasModelUpdate = Boolean(
            continueArgs.model || continueArgs.models || continueArgs.trustModelPlan || continueArgs.allowWeakModel,
          );
          const modelPlanResult = hasModelUpdate
            ? buildModelPlanFromOptions(continueArgs, phases, state.workDir, state.modelPlan)
            : { plan: state.modelPlan, errors: [], warnings: [] };
          for (const warning of modelPlanResult.warnings) ctx.ui.notify(warning, "warning");
          const modelPlanErrors = [
            ...modelPlanResult.errors,
            ...validateModelPlanSelectors(ctx, modelPlanResult.plan, phases),
          ];
          if (modelPlanErrors.length) {
            ctx.ui.notify(modelPlanErrors.join("\n"), "error");
            return;
          }

          const pk = phases[targetIdx];
          const yoloMode = state.yoloMode || continueArgs.yolo;
          const approvingImplementCheckpoint =
            state.waitingReason === IMPLEMENT_CHECKPOINT_WAIT_REASON &&
            (pk === "implement" || renderFromImplementCheckpoint);
          removePipelineLock(state.feature, state.workDir);
          createPipelineLock(state.feature, state.workDir);
          let updated = enterPhasePreHook(
            {
              ...state,
              phases,
              yoloMode,
              implementCheckpointApproved:
                state.implementCheckpointApproved || approvingImplementCheckpoint || yoloMode,
              modelPlan: modelPlanResult.plan,
              originalModel: state.originalModel ?? selectorFromCurrentModel(ctx.model, getCurrentThinkingLevel(pi)),
            },
            { phaseIndex: targetIdx, phase: pk },
          );
          if (hasModelUpdate) {
            updated = appendModelEventState(
              updated,
              createModelSwitchEvent("plan-update", resolvePhaseModelSelector(modelPlanResult.plan, pk), "success", {
                phaseKey: pk,
                reason: "/ralph-works continue model plan update",
              }),
            );
          }
          saveState(pi, updated);
          refreshWidget(ctx, updated);
          ctx.ui.notify(`Continuing Phase ${targetIdx + 1} (${PHASE_META[pk]?.name ?? pk})`, "info");
          await launchPhase(pi, ctx, updated);
          break;
        }
        case "resume": {
          const state = getState(ctx);
          if (!state) {
            ctx.ui.notify("No pipeline to resume.", "error");
            return;
          }
          if (state.pipelineStatus === "completed") {
            ctx.ui.notify("Pipeline already completed.", "info");
            return;
          }
          const pausedNonLaunchingState = restorePausedNonLaunchingState(state);
          if (pausedNonLaunchingState) {
            removePipelineLock(state.feature, state.workDir);
            createPipelineLock(state.feature, state.workDir);
            saveState(pi, pausedNonLaunchingState);
            if (pausedNonLaunchingState.phaseStatus === WAITING_FOR_USER_PHASE_STATUS) {
              setPipelineWaitingUi(ctx, pausedNonLaunchingState);
            }
            refreshWidget(ctx, pausedNonLaunchingState);
            ctx.ui.notify(
              `Resumed paused pipeline at Phase ${(pausedNonLaunchingState.currentPhaseIndex ?? 0) + 1} (${PHASE_META[pausedNonLaunchingState.currentPhase ?? ""]?.name ?? pausedNonLaunchingState.currentPhase ?? "unknown"})`,
              "info",
            );
            break;
          }
          // Remove stale lock or keep existing
          removePipelineLock(state.feature, state.workDir);
          createPipelineLock(state.feature, state.workDir);
          const phases = state.phases?.length ? state.phases : DEFAULT_PHASES;
          const resumePhase = parts[1];
          let targetIdx = state.currentPhaseIndex ?? 0;
          if (resumePhase) {
            const ri = phases.indexOf(resumePhase);
            if (ri >= 0) targetIdx = ri;
          }
          // Skip a phase that already wrote its completion marker before an interruption.
          if (phaseCompletionMarkerExists(state, phases[targetIdx])) {
            targetIdx = Math.min(targetIdx + 1, phases.length - 1);
          }
          const pk = phases[targetIdx];
          ctx.ui.notify(`Resuming at Phase ${targetIdx + 1} (${PHASE_META[pk]?.name ?? pk})`, "info");
          const updated = {
            ...enterPhasePreHook(
              {
                ...withoutPendingSteer(state),
                implementCheckpointApproved: state.implementCheckpointApproved || pk === "implement",
              },
              { phaseIndex: targetIdx, phase: pk },
            ),
            turnWriteCount: state.turnWriteCount,
            pausedFromPhaseStatus: undefined,
          };
          saveState(pi, updated);
          refreshWidget(ctx, updated);
          await launchPhase(pi, ctx, updated);
          break;
        }
        case "pause": {
          const state = getState(ctx);
          if (!state) {
            ctx.ui.notify("No active pipeline.", "info");
            return;
          }
          const pausedState = buildPausedState(state);
          const abortStatus = requestCurrentAgentAbort(ctx);
          saveState(pi, pausedState);
          refreshWidget(ctx, pausedState);
          ctx.ui.setStatus(UI_WIDGET_ID, undefined);
          ctx.ui.notify(formatPauseNotice(abortStatus), "warning");
          break;
        }
        case "set-workdir": {
          const state = getState(ctx);
          if (!state) {
            ctx.ui.notify("No active pipeline.", "error");
            return;
          }
          const requestedWorkDir = parts[1];
          if (!requestedWorkDir) {
            ctx.ui.notify("Usage: /ralph-works set-workdir <path>", "error");
            return;
          }
          const resolution = resolvePipelineWorkDir(state.workDir, requestedWorkDir, ctx.cwd);
          if (!resolution.ok || !resolution.workDir) {
            ctx.ui.notify(resolution.message, "error");
            return;
          }
          const updated: PipelineState = {
            ...state,
            workDir: resolution.workDir,
            turnWriteCount: 0,
            lastValidationFailure: undefined,
          };
          saveState(pi, updated);
          refreshWidget(ctx, updated);
          ctx.ui.notify(resolution.message, "info");
          break;
        }
        case "gate": {
          const state = getState(ctx) || { workDir: ctx.cwd };
          const results = runLintGates(state.workDir, parts.slice(1));
          const noConfiguredGates = results.every((r) => r.skipped);
          ctx.ui.notify(
            noConfiguredGates
              ? "No ralph-works gates configured"
              : results.every((r) => r.pass)
                ? "✅ All gates passed"
                : `❌ Failed: ${results
                    .filter((r) => !r.pass)
                    .map((r) => r.name)
                    .join(", ")}`,
            results.every((r) => r.pass) ? "info" : "error",
          );
          break;
        }
        case "status": {
          const state = getState(ctx);
          if (!state) {
            ctx.ui.notify("No active pipeline.", "info");
            return;
          }
          const phases = state.phases?.length ? state.phases : DEFAULT_PHASES;
          const idx = state.currentPhaseIndex ?? 0;
          const pk = phases[idx];
          const expectedArtifacts = formatExpectedArtifactPaths(getExpectedArtifactPaths(pk, state));
          const modelPlanSummary = formatModelPlanSummary(state.modelPlan);
          const currentSelector = pk ? resolvePhaseModelSelector(state.modelPlan, pk) : undefined;
          const lastApplied = state.lastAppliedModel
            ? `${state.lastAppliedModel.phaseKey} ${formatModelSelector({ ...state.lastAppliedModel, source: "cli" })}`
            : undefined;
          ctx.ui.notify(
            [
              `Feature: ${state.feature}`,
              `Status: ${state.pipelineStatus ?? "running"}`,
              `phaseStatus: ${state.phaseStatus ?? "executing"}`,
              `Current: Phase ${idx + 1} — ${PHASE_META[pk]?.name ?? pk}`,
              `WorkDir: ${state.workDir}`,
              expectedArtifacts,
              `Phases: ${phases.join(" → ")}`,
              modelPlanSummary ? `Model plan: ${modelPlanSummary}` : undefined,
              currentSelector ? `Current phase model: ${formatModelSelector(currentSelector)}` : undefined,
              lastApplied ? `Last applied model: ${lastApplied}` : undefined,
              state.modelPlan
                ? `Model config trust: ${state.modelPlan.trustApproved ? (state.modelPlan.trustSource ?? "approved") : "not using workspace config"}`
                : undefined,
              `reviewIterations: ${state.reviewIterations ?? 0}`,
              `phaseAttempts: ${state.phaseAttempts ?? 0}`,
              `Context clears: ${state.contextClearCount ?? 0}`,
              `Auto clear: ${isAutoClearContextEnabled(state) ? "ON" : "OFF"}`,
              `Yolo mode: ${(state.yoloMode ?? false) ? "ON" : "OFF"}`,
              state.lastValidationFailure ? `Last validation failure:\n${state.lastValidationFailure}` : "",
              `Started: ${new Date(state.startedAt).toISOString()}`,
            ]
              .filter(Boolean)
              .join("\n"),
            "info",
          );
          break;
        }
        case "cancel": {
          const state = getState(ctx);
          removePipelineLocks(ctx.cwd);
          if (state) {
            removePipelineLock(state.feature, state.workDir);
            if (state.workDir !== ctx.cwd) removePipelineLocks(state.workDir);
            const restoredState = await restoreOriginalModelForTerminal(pi, ctx, withoutPendingSteer(state));
            saveState(pi, {
              ...restoredState,
              pipelineStatus: "cancelled",
              phaseStatus: "post_hook",
              turnWriteCount: 0,
              waitingReason: undefined,
              readyToAdvancePhase: undefined,
            });
          }
          clearPipelineWidgetCache();
          ctx.ui.setStatus(UI_WIDGET_ID, "");
          ctx.ui.setWidget(UI_WIDGET_ID, []);
          ctx.ui.notify("Pipeline cancelled", "warning");
          break;
        }
        case "clear-context": {
          const cs = getState(ctx);
          if (!cs) {
            ctx.ui.notify("No active pipeline.", "error");
            return;
          }
          // Parse flags
          const flag = parts[1];
          if (flag && flag !== "--auto") {
            ctx.ui.notify("Unknown flag. Usage: /ralph-works clear-context [--auto]", "error");
            return;
          }
          const clearState = flag === "--auto" ? { ...cs, autoClearContext: true } : cs;
          if (flag === "--auto") {
            saveState(pi, clearState);
          }
          // Validate clear
          const check = canClearContext(clearState);
          if (!check.ok) {
            ctx.ui.notify("Cannot clear context: " + (check.reason ?? "unknown"), "error");
            return;
          }
          // Build artifact list for prompt augmentation
          const artifacts = resolveArtifactPaths(clearState);
          let artList = "";
          if (artifacts.length > 0) artList = "\nArtifacts on disk:\n" + artifacts.map((a) => "- " + a).join("\n");
          // Trigger compaction via ctx, then send steer message in onComplete
          setPipelineCompactingUi(ctx, clearState);
          ctx.compact({
            customInstructions:
              "Preserve pipeline phase context and file operations. Focus on current task instructions.",
            onComplete: (_result) => {
              try {
                // Re-validate cooldown before committing (race guard)
                if (!canClearContext(clearState).ok) {
                  setPipelineWorkingUi(ctx, clearState);
                  refreshWidget(ctx, clearState);
                  ctx.ui.notify("Context clear skipped — cooldown active", "info");
                  return;
                }
                const prompt = buildReorientationPrompt(clearState);
                const fullMsg = wrapSteerMessage(prompt + artList, MAX_STEER_SIZE);
                sendPipelineUserMessage(pi, ctx, fullMsg, { deliverAs: "steer", wrapSteer: false });
                // Increment counter only after successful send (not before)
                const updated = {
                  ...clearState,
                  contextClearCount: (clearState.contextClearCount ?? 0) + 1,
                  lastContextClearAt: Date.now(),
                };
                saveState(pi, updated);
                setPipelineWorkingUi(ctx, updated);
                refreshWidget(ctx, updated);
                ctx.ui.notify(
                  "Context cleared — Phase " +
                    ((clearState.currentPhaseIndex ?? 0) + 1) +
                    "/" +
                    (clearState.phases?.length ?? "?") +
                    " resumed",
                  "info",
                );
              } catch (e) {
                setPipelineWorkingUi(ctx, clearState);
                refreshWidget(ctx, clearState);
                ctx.ui.notify("Steer failed: " + String(e), "error");
              }
            },
            onError: (_err) => {
              // Fallback: send steer-only without compaction
              try {
                const prompt = buildReorientationPrompt(clearState);
                sendPipelineUserMessage(pi, ctx, prompt, { deliverAs: "steer" });
                const updated = {
                  ...clearState,
                  contextClearCount: (clearState.contextClearCount ?? 0) + 1,
                  lastContextClearAt: Date.now(),
                };
                saveState(pi, updated);
                setPipelineWorkingUi(ctx, updated);
                refreshWidget(ctx, updated);
                ctx.ui.notify("Context cleared (compaction fallback)", "warning");
              } catch (e) {
                setPipelineWorkingUi(ctx, clearState);
                refreshWidget(ctx, clearState);
                ctx.ui.notify("Clear failed entirely: " + String(e), "error");
              }
            },
          });
          break;
        }
        default: {
          ctx.ui.notify(
            cmd ? `Unknown /ralph-works command: ${cmd}\n${RALPH_USAGE}` : RALPH_USAGE,
            cmd ? "error" : "info",
          );
        }
      }
    },
  });

  pi.on("before_provider_request", async (event, ctx) => {
    const state = getState(ctx);
    if (!state || state.pipelineStatus !== "running") return;
    return failClosedProviderRequestOnDrift(pi, ctx, state, event.payload);
  });

  // ── Resources discovery ─────────────────────────────────
  pi.on("resources_discover", async () => ({ skillPaths: [SKILL_BASE] }));

  // ── Single-skill injection per phase ────────────────────
  pi.on("before_agent_start", async (event, ctx) => {
    const state = getState(ctx);
    if (!state || state.pipelineStatus !== "running") return;
    const guardedState = await enforcePhaseModelBeforeDispatch(pi, ctx, state);
    const pk = guardedState.currentPhase;
    if (!pk || !PHASE_CONFIGS[pk]) return;
    const skillPath = PHASE_CONFIGS[pk].skillPath;
    if (!fs.existsSync(skillPath)) return;
    try {
      const content = fs.readFileSync(skillPath, "utf-8");
      if (!event.systemPrompt.includes(pk + "-skill")) {
        return { systemPrompt: event.systemPrompt + `\n\n<ralph-${pk}-skill>\n${content}\n</ralph-${pk}-skill>` };
      }
    } catch {}
  });
}
