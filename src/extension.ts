/**
 * Ralph Loop Extension — Phase-state-machine pipeline inside pi.
 *
 * Deterministic state machine with pre-hook → execution → post-hook lifecycle.
 * Single-skill injection, structured review decisions, crash recovery.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
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
  RENDER_HTML_ALIASES,
  RENDER_PHASE,
  SKILL_BASE,
  UI_WIDGET_ID,
  WAITING_FOR_USER_PHASE_STATUS,
  YOLO_FLAG,
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
} from "./stateMachine";
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

/** Only non-terminal persisted states should prevent a fresh `/ralph start`. */
function blocksNewPipelineStart(state: PipelineState | null): boolean {
  if (!state) return false;
  return !["completed", "cancelled", "failed", "halted"].includes(state.pipelineStatus ?? "running");
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
  const checkpointState: PipelineState = {
    ...st,
    phaseStatus: WAITING_FOR_USER_PHASE_STATUS,
    waitingReason: IMPLEMENT_CHECKPOINT_WAIT_REASON,
    turnWriteCount: 0,
    readyToAdvancePhase: undefined,
  };
  saveState(pi, checkpointState);
  setPipelineWaitingUi(ctx, checkpointState);
  refreshWidget(ctx, checkpointState);
  const renderOption = st.phases?.includes(RENDER_PHASE)
    ? ""
    : " Or run /ralph continue --render-html (or /ralph continue html) to render the spec to HTML first.";
  ctx.ui.notify(
    `Review the completed planning phases before TDD implementation. Run /ralph continue to approve.${renderOption} Start with --yolo to run straight through next time.`,
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
const PROVIDER_DRIFT_BLOCK_MESSAGE = "Ralph blocked this provider request because the active model drifted.";

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
          reason: "active model no longer matches last Ralph-applied model",
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
  ctx.ui.notify(message ?? `✅ Ralph loop complete for "${state.feature}"`, "info");
  ctx.ui.setStatus(UI_WIDGET_ID, undefined);
  writeDevCycleSummary(completedState);
  writeMetrics(completedState);
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
    const failureMessage = [`Pre-hook failed for phase "${pk}". Fix prerequisites and /ralph resume.`, workDirWarning]
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

  const executingState: PipelineState = {
    ...state,
    phaseStatus: "executing",
    phaseAttempts: 0,
    turnWriteCount: 0,
    waitingReason: undefined,
    readyToAdvancePhase: undefined,
  };
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
  const u: PipelineState = {
    ...state,
    currentPhaseIndex: nextIdx,
    currentPhase: nextPhase,
    phaseStatus: "pre_hook",
    phaseAttempts: 0,
    turnWriteCount: 0,
    waitingReason: undefined,
    readyToAdvancePhase: undefined,
  };

  if (shouldPauseBeforeImplementCheckpoint(state, phases, idx, nextIdx, nextPhase)) {
    enterImplementCheckpoint(pi, ctx, u);
    return;
  }

  saveState(pi, u);
  refreshWidget(ctx, u);

  // Auto-clear at phase boundary (except implement→review transition)
  // Check BEFORE pre_hook blocks it: pass "executing" so cooldown/status gates still apply
  const prevPhase = phases[idx];
  if (state.autoClearContext && !(prevPhase === "implement" && nextPhase === "review")) {
    const autoCheckState = { ...u, phaseStatus: "executing" } as PipelineState;
    const autoCheck = canClearContext(autoCheckState);
    if (autoCheck.ok) {
      setPipelineCompactingUi(ctx, u);
      ctx.compact({
        customInstructions: "Preserve pipeline phase context. Focus on transitioning to the new phase.",
        onComplete: () => {
          try {
            // Re-validate cooldown before committing (race guard)
            if (!canClearContext(autoCheckState).ok) {
              setPipelineWorkingUi(ctx, u);
              refreshWidget(ctx, u);
              return; // skip — manual clear raced ahead
            }
            const updated = { ...u, contextClearCount: (u.contextClearCount ?? 0) + 1, lastContextClearAt: Date.now() };
            void launchPhase(pi, ctx, updated, {
              asFollowUp: true,
              prefixText: `⛔ CONTEXT RESET — Continue with Phase ${nextIdx + 1}: ${meta?.name ?? nextPhase}.`,
            });
          } catch {
            // Silent failure — auto-clear is best-effort
          }
        },
        onError: () => {
          void launchPhase(pi, ctx, u, { asFollowUp: true });
        },
      });
      return;
    }
  }

  await launchPhase(pi, ctx, u, { asFollowUp: true });
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
    await completePipeline(pi, ctx, state, `✅ Ralph review LGTM. Loop complete for "${state.feature}"`);
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
    const phases = state.phases ?? DEFAULT_PHASES;
    const implIdx = phases.indexOf("implement");
    const u: PipelineState = {
      ...state,
      currentPhaseIndex: implIdx >= 0 ? implIdx : 3,
      currentPhase: "implement",
      phaseStatus: "pre_hook",
      reviewIterations: iter + 1,
      phaseAttempts: 0,
      turnWriteCount: 0,
      waitingReason: undefined,
      implementCheckpointApproved: true,
      readyToAdvancePhase: undefined,
    };
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
  if (state.phaseStatus !== "executing")
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
        ? "Fix failures and call the registered `ralph_gate_check` tool after; do not run it in `bash`."
        : "Fix the expected phase artifacts under the persisted workDir, then retry phase completion.";
    sendPipelineUserMessage(pi, ctx, `⛔ Phase validation failed:\n\n${failureDetails}\n\n${retryInstruction}`, {
      deliverAs: "steer",
    });
    const updatedState: PipelineState = {
      ...state,
      phaseAttempts: attempts + 1,
      turnWriteCount: 0,
      lastValidationFailure: failureDetails,
    };
    saveState(pi, updatedState);
    refreshWidget(ctx, updatedState);
    return { ok: false, message: failureDetails };
  }

  writePhaseCompletionMarker(pk, state.workDir);
  await advancePhase(pi, ctx, {
    ...state,
    pipelineStatus: "running",
    phaseStatus: "post_hook",
    turnWriteCount: 0,
    waitingReason: undefined,
    readyToAdvancePhase: undefined,
    lastValidationFailure: undefined,
  });
  return { ok: true, message: `Phase "${pk}" completion recorded.` };
}

/**
 * Interpret the assistant's finished turn without treating every turn as a
 * phase boundary. Non-review phases advance only through explicit completion;
 * implement can also advance after a passing registered gate check.
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
  if (state.currentPhase === "review" && state.phaseStatus === "executing" && isLgtmReviewText(assistantText)) {
    await completePipeline(
      pi,
      ctx,
      state,
      `✅ Ralph review LGTM: no critical bugs found. Loop complete for "${state.feature}"`,
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

  if (
    state.currentPhase === "implement" &&
    state.phaseStatus === "executing" &&
    state.readyToAdvancePhase === "implement"
  ) {
    await handlePhaseCompletion(pi, ctx);
    return;
  }

  if (state.currentPhase === "implement" && state.phaseStatus === "executing") {
    sendDedupedPipelineUserMessage(
      pi,
      ctx,
      state,
      "Implementation is still in the TDD phase. Call the registered `ralph_gate_check` tool now if implementation is complete. Do not run `ralph_gate_check` in `bash`; it is a Pi extension tool, not a shell command. If work remains, continue the Red-Green-Refactor cycle and call the tool when ready.",
      { deliverAs: "steer", dedupeKey: `implement-gate:${idx}` },
    );
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
      ctx.ui.notify("TDD implementation is waiting for review approval. Run /ralph continue to launch it.", "warning");
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
    ctx.ui.notify(`Ralph loop: ${state.feature} (${phases.join(", ")})`, "info");
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
        `⛔ Pipeline state corrupted: currentPhaseIndex=${currentIdx} out of bounds. Run /ralph cancel to reset.`,
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
        // Passing gates mark implement as ready; agent_end performs the actual phase completion.
        saveState(pi, { ...state, turnWriteCount: 0 });
        ctx.ui.notify("🚧 Auto-gate: running lint checks...", "info");
        const results = runLintGates(state.workDir);
        if (results.every((r) => r.pass)) {
          ctx.ui.notify("✅ All gates passed", "info");
          if (state.currentPhase === "implement")
            saveState(pi, { ...state, turnWriteCount: 0, readyToAdvancePhase: "implement" });
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
    label: "Ralph Set WorkDir",
    description: "Update the active Ralph run root when work moves into a dedicated git worktree.",
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
    label: "Ralph Gate Check",
    description: "Run quality gates (tsc --noEmit, vitest run). Use after every implementation step.",
    promptSnippet: "Run lint gates — use after implementation/remediation",
    parameters: Type.Object({ paths: Type.Optional(Type.Array(Type.String())) }),
    async execute(_id, params, _sig, onUpdate, ctx) {
      const state = getState(ctx);
      if (!state) return { content: [{ type: "text", text: "No active pipeline." }], details: {} };
      // Pi's callback type is generic, but this tool only streams text updates.
      const update = onUpdate as undefined | ((value: { content: Array<{ type: "text"; text: string }> }) => void);
      update?.({ content: [{ type: "text", text: "🚧 Running lint gates..." }] });
      const results = runLintGates(state.workDir, params.paths);
      const allPass = results.every((r) => r.pass);
      saveState(pi, {
        ...state,
        turnWriteCount: 0,
        readyToAdvancePhase: allPass && state.currentPhase === "implement" ? "implement" : undefined,
      });
      const failed = results.filter((r) => !r.pass);
      const report = [
        `## ${allPass ? "✅ All Gates Passed" : "❌ Gate Failures"}`,
        "",
        `| Gate | Status |`,
        `|------|--------|`,
        ...results.map((r) => `| ${r.name} | ${r.pass ? "✅ PASS" : "❌ FAIL"} |`),
        "",
      ];
      for (const f of failed) report.push(`\`${f.output.slice(0, 3000)}\``);
      report.push(allPass ? "All gates passed. Proceed to next phase." : "Fix failures and re-run ralph_gate_check.");
      ctx.ui.setStatus(UI_WIDGET_ID, allPass ? `✅ Gates clear` : `❌ Gates: ${failed.map((f) => f.name).join(", ")}`);
      return { content: [{ type: "text", text: report.join("\n") }], details: { results, allPass } };
    },
  });

  // ── Tool: ralph_review_decision ────────────────────────
  pi.registerTool({
    name: "ralph_review_decision",
    label: "Ralph Review Decision",
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

  // ── Command: /ralph ────────────────────────────────────
  pi.registerCommand("ralph", {
    description: "Dev-cycle pipeline (start | status | cancel | gate | set-workdir | continue | resume | pause)",
    getArgumentCompletions: (prefix: string) => {
      const items = [
        "start",
        "status",
        "cancel",
        "gate",
        "continue",
        "resume",
        "pause",
        "set-workdir",
        "clear-context",
        ...RENDER_HTML_ALIASES,
        YOLO_FLAG,
        "spec",
        "redteam",
        "harden",
        "render",
        "implement",
        "review",
      ].map((v) => ({ value: v, label: v }));
      return items.filter((i) => i.value.startsWith(prefix));
    },
    handler: async (args, ctx) => {
      const parts = parseCommandArgs(args.trim());
      const cmd = parts[0]?.toLowerCase();
      switch (cmd) {
        case "start": {
          if (blocksNewPipelineStart(getState(ctx))) {
            ctx.ui.notify("Pipeline already running. /ralph cancel first.", "error");
            return;
          }
          const feature = parts[1];
          if (!feature) {
            ctx.ui.notify(
              "Usage: /ralph start <feature> [prompt] [phases] [--model provider/model[:thinking]] [--models phase=provider/model[:thinking],...] [--trust-model-plan] [--render-html|html] [--yolo]",
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
            ctx.ui.notify("Pipeline already running — /ralph cancel first.", "error");
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
            ctx.ui.notify("Pipeline was cancelled. Start a new pipeline with /ralph start.", "error");
            return;
          }

          const continueArgs = parseRalphFlags(parts.slice(1));
          if (continueArgs.errors.length) {
            ctx.ui.notify(continueArgs.errors.join("\n"), "error");
            return;
          }
          const basePhases = state.phases?.length ? state.phases : DEFAULT_PHASES;
          let phases = [...basePhases];
          let targetIdx = state.currentPhaseIndex ?? 0;
          if (!validatePhaseIndex(targetIdx, phases)) {
            ctx.ui.notify(
              `⛔ Pipeline state corrupted: currentPhaseIndex=${targetIdx} out of bounds. Run /ralph cancel to reset.`,
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
          let updated: PipelineState = {
            ...state,
            phases,
            currentPhaseIndex: targetIdx,
            currentPhase: pk,
            phaseStatus: "pre_hook",
            pipelineStatus: "running",
            phaseAttempts: 0,
            turnWriteCount: 0,
            waitingReason: undefined,
            yoloMode,
            implementCheckpointApproved: state.implementCheckpointApproved || approvingImplementCheckpoint || yoloMode,
            readyToAdvancePhase: undefined,
            modelPlan: modelPlanResult.plan,
            originalModel: state.originalModel ?? selectorFromCurrentModel(ctx.model, getCurrentThinkingLevel(pi)),
          };
          if (hasModelUpdate) {
            updated = appendModelEventState(
              updated,
              createModelSwitchEvent("plan-update", resolvePhaseModelSelector(modelPlanResult.plan, pk), "success", {
                phaseKey: pk,
                reason: "/ralph continue model plan update",
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
          const updated: PipelineState = {
            ...state,
            currentPhaseIndex: targetIdx,
            currentPhase: pk,
            phaseStatus: "pre_hook",
            pipelineStatus: "running",
            phaseAttempts: 0,
            waitingReason: undefined,
            implementCheckpointApproved: state.implementCheckpointApproved || pk === "implement",
            readyToAdvancePhase: undefined,
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
          const pausedState: PipelineState = { ...state, pipelineStatus: "paused", phaseStatus: "post_hook" };
          saveState(pi, pausedState);
          refreshWidget(ctx, pausedState);
          ctx.ui.setStatus(UI_WIDGET_ID, undefined);
          ctx.ui.notify(`Pipeline paused. Use /ralph resume to continue.`, "warning");
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
            ctx.ui.notify("Usage: /ralph set-workdir <path>", "error");
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
          ctx.ui.notify(
            results.every((r) => r.pass)
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
              `Auto clear: ${(state.autoClearContext ?? false) ? "ON" : "OFF"}`,
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
            ctx.ui.notify("Unknown flag. Usage: /ralph clear-context [--auto]", "error");
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
          if (cmd && !cmd.startsWith("-")) {
            // Shorthand: /ralph <feature>
            if (!blocksNewPipelineStart(getState(ctx))) {
              const feature = cmd;
              const state: PipelineState = {
                feature,
                workDir: ctx.cwd,
                phases: [...DEFAULT_PHASES],
                maxIterations: 10,
                startedAt: Date.now(),
                currentPhaseIndex: 0,
                currentPhase: "spec",
                phaseStatus: "executing",
                pipelineStatus: "running",
                reviewIterations: 0,
                phaseAttempts: 0,
                turnWriteCount: 0,
                autoClearContext: true,
              };
              saveState(pi, state);
              refreshWidget(ctx, state);
              createPipelineLock(feature, ctx.cwd);
              sendPipelineUserMessage(pi, ctx, buildPhasePrompt("spec", state));
            }
          } else {
            ctx.ui.notify(
              "Usage: /ralph start <feature> [--render-html|html] [--yolo] | status | cancel | gate | set-workdir <path> | continue [--render-html|html] [--yolo] | resume | pause | clear-context [--auto]",
              "info",
            );
          }
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
