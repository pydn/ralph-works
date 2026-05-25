import { recordFallbackCompactionEvent } from "../artifacts/compaction-summary.js";
import {
  appendSessionBoundaryEvent,
  createSessionBoundaryEvent,
  findSessionBoundaryEvent,
  updateSessionBoundaryEvent,
} from "../state/session-boundaries.js";
import { triggerRalphWorksCompaction } from "./pi-compaction-trigger.js";
import { RALPH_WORKS_STATE_ENTRY_TYPE } from "./pi-state-persistence.js";
import { formatSessionBoundaryDiagnostic } from "./session-boundary-diagnostics.js";

export const RALPH_WORKS_SESSION_BOUNDARY_PLAN_ENTRY_TYPE =
  "ralph-works-session-boundary-plan";

function getSessionIdentifier(sessionManager) {
  if (!sessionManager) {
    return undefined;
  }

  return (
    sessionManager.getSessionFile?.() ??
    sessionManager.getSessionId?.() ??
    undefined
  );
}

function notify(ctx, message, level = "info") {
  ctx?.ui?.notify?.(message, level);
}

function boundaryDiagnostic(plan) {
  return formatSessionBoundaryDiagnostic({
    boundaryId: plan.boundaryId,
    reason: plan.reason,
  });
}

function elapsedSince(startedAt, now) {
  const finishedAt = now();
  return Number.isFinite(finishedAt) && Number.isFinite(startedAt)
    ? Math.max(0, finishedAt - startedAt)
    : undefined;
}

function ensureBoundaryEvent(state, plan) {
  if (findSessionBoundaryEvent(state, plan.boundaryId)) {
    return state;
  }

  return appendSessionBoundaryEvent(
    state,
    createSessionBoundaryEvent({
      id: plan.boundaryId,
      boundaryType: plan.boundaryType,
      reason: plan.reason,
      fromPhase: state.currentPhase,
      toPhase: plan.nextState?.currentPhase,
      nextTaskId: plan.taskDetails?.id,
    }),
  );
}

function buildBoundaryPlanEntry(plan) {
  return {
    boundaryId: plan.boundaryId,
    boundaryType: plan.boundaryType,
    reason: plan.reason,
    nextActionType: plan.nextActionType,
    artifactPaths: plan.artifactPaths ?? [],
    selectedModelTarget: plan.selectedModelTarget,
    taskDetails: plan.taskDetails,
    latestGateSummary: plan.latestGateSummary,
    reviewFeedback: plan.reviewFeedback,
    resumeContext: plan.resumeContext,
  };
}

function appendReplacementState(ctx, state) {
  try {
    ctx?.sessionManager?.appendCustomEntry?.(
      RALPH_WORKS_STATE_ENTRY_TYPE,
      state,
    );
  } catch {
    // State persistence during replacement diagnostics is best-effort.
  }
}

function appendSetupEntries(sessionManager, state, plan) {
  sessionManager.appendCustomEntry?.(RALPH_WORKS_STATE_ENTRY_TYPE, state);

  if (plan.customMessage) {
    sessionManager.appendCustomMessageEntry?.(
      plan.customMessage.customType,
      plan.customMessage.content,
      plan.customMessage.display === true,
      plan.customMessage.details,
    );
  }

  sessionManager.appendCustomEntry?.(
    RALPH_WORKS_SESSION_BOUNDARY_PLAN_ENTRY_TYPE,
    buildBoundaryPlanEntry(plan),
  );

  const modelTarget = plan.selectedModelTarget;
  const modelId = modelTarget?.id ?? modelTarget?.modelId;
  if (modelTarget?.provider && modelId) {
    sessionManager.appendModelChange?.(modelTarget.provider, modelId);
  }
}

async function sendFallbackKickoff(plan, sendFallbackPrompt) {
  if (!plan.kickoffPrompt || typeof sendFallbackPrompt !== "function") {
    return;
  }

  await sendFallbackPrompt(plan.kickoffPrompt, { deliverAs: "followUp" });
}

function createStateUpdater(initialState, boundaryId, onStateChange) {
  let currentState = initialState;

  return {
    get state() {
      return currentState;
    },
    update(updates) {
      currentState = updateSessionBoundaryEvent(
        currentState,
        boundaryId,
        updates,
      );
      onStateChange?.(currentState);
      return currentState;
    },
    replace(nextState) {
      currentState = nextState;
      onStateChange?.(currentState);
      return currentState;
    },
  };
}

function createResult(status, state, extra = {}) {
  return {
    status,
    state,
    freshSessionCreated: false,
    fallbackUsed: false,
    cancelled: false,
    ...extra,
  };
}

async function runCompactionFallback({
  ctx,
  plan,
  updater,
  startedAt,
  now,
  attemptedFreshSession,
  error,
  sendFallbackPrompt,
  applyFallbackModel,
}) {
  if (typeof applyFallbackModel === "function") {
    await applyFallbackModel();
  }

  if (typeof ctx?.compact !== "function") {
    const unavailableState = updater.update({
      status: "fallback_unavailable",
      freshSessionAttempted: attemptedFreshSession,
      freshSessionCreated: false,
      fallbackUsed: false,
      elapsedMs: elapsedSince(startedAt, now),
    });
    notify(
      ctx,
      `ralph-works unable to launch ${boundaryDiagnostic(plan)}: new session unavailable and compaction fallback unavailable.`,
      "error",
    );
    return createResult("fallback_unavailable", unavailableState, {
      error,
    });
  }

  const fallbackState = updater.update({
    status: "fallback_compaction",
    freshSessionAttempted: attemptedFreshSession,
    freshSessionCreated: false,
    fallbackUsed: true,
    elapsedMs: elapsedSince(startedAt, now),
  });

  let continued = false;
  const continueAfterFallback = async () => {
    if (continued) {
      return;
    }
    continued = true;
    try {
      await sendFallbackKickoff(plan, sendFallbackPrompt);
    } catch {
      notify(
        ctx,
        `ralph-works fallback follow-up failed for ${boundaryDiagnostic(plan)}; seeded state remains available for resume.`,
        "error",
      );
    }
  };

  const fallbackStateWithCompactionEvent = updater.replace(
    recordFallbackCompactionEvent(fallbackState, {
      boundary: plan.boundaryType,
      reason: plan.reason,
    }),
  );

  const compactStarted = triggerRalphWorksCompaction(
    ctx,
    fallbackStateWithCompactionEvent,
    plan.boundaryType,
    plan.reason,
    {
      onComplete: continueAfterFallback,
      onError: continueAfterFallback,
    },
  );

  if (!compactStarted) {
    const unavailableState = updater.update({
      status: "fallback_unavailable",
      freshSessionAttempted: attemptedFreshSession,
      freshSessionCreated: false,
      fallbackUsed: false,
      elapsedMs: elapsedSince(startedAt, now),
    });
    notify(
      ctx,
      `ralph-works unable to launch ${boundaryDiagnostic(plan)}: new session unavailable and compaction fallback unavailable.`,
      "error",
    );
    return createResult("fallback_unavailable", unavailableState, {
      error,
    });
  }

  notify(
    ctx,
    `ralph-works using fallback compaction for ${boundaryDiagnostic(plan)}.`,
    "warning",
  );
  return createResult("fallback_compaction", updater.state, {
    fallbackUsed: true,
    error,
  });
}

export async function launchPiSessionBoundary(
  ctx,
  state,
  plan,
  {
    now = () => Date.now(),
    onStateChange,
    sendFallbackPrompt,
    applyFallbackModel,
    onReplacementReady,
  } = {},
) {
  if (!plan?.boundaryId) {
    throw new Error("Session boundary launch requires a boundary plan id.");
  }
  if (!plan?.boundaryType) {
    throw new Error("Session boundary launch requires a boundary type.");
  }

  const startedAt = now();
  const previousSessionId = getSessionIdentifier(ctx?.sessionManager);
  const updater = createStateUpdater(
    ensureBoundaryEvent(state, plan),
    plan.boundaryId,
    onStateChange,
  );

  if (typeof ctx?.newSession !== "function") {
    return runCompactionFallback({
      ctx,
      plan,
      updater,
      startedAt,
      now,
      attemptedFreshSession: false,
      sendFallbackPrompt,
      applyFallbackModel,
    });
  }

  updater.update({
    status: "launching",
    freshSessionAttempted: true,
    freshSessionCreated: false,
    fallbackUsed: false,
    previousSessionId,
  });

  let setupCompleted = false;
  let replacementSessionId;
  let followupError;
  let replacementCtxForNotify;

  try {
    await ctx.waitForIdle?.();

    const result = await ctx.newSession({
      parentSession: previousSessionId,
      setup: async (sessionManager) => {
        replacementSessionId = getSessionIdentifier(sessionManager);
        const setupState = updater.update({
          status: "created",
          freshSessionAttempted: true,
          freshSessionCreated: true,
          fallbackUsed: false,
          elapsedMs: elapsedSince(startedAt, now),
          previousSessionId,
          replacementSessionId,
        });
        appendSetupEntries(sessionManager, setupState, plan);
        setupCompleted = true;
      },
      withSession: async (replacementCtx) => {
        replacementCtxForNotify = replacementCtx;
        replacementSessionId =
          getSessionIdentifier(replacementCtx?.sessionManager) ??
          replacementSessionId;

        await onReplacementReady?.(replacementCtx, updater.state, plan);

        if (!plan.kickoffPrompt) {
          return;
        }

        try {
          await replacementCtx.sendUserMessage(plan.kickoffPrompt, {
            deliverAs: "followUp",
          });
        } catch (error) {
          followupError = error;
          const failedState = updater.update({
            status: "followup_failed",
            freshSessionAttempted: true,
            freshSessionCreated: true,
            fallbackUsed: false,
            elapsedMs: elapsedSince(startedAt, now),
            previousSessionId,
            replacementSessionId,
          });
          appendReplacementState(replacementCtx, failedState);
          notify(
            replacementCtx,
            `ralph-works follow-up failed for ${boundaryDiagnostic(plan)}; seeded replacement state remains available for resume.`,
            "error",
          );
        }
      },
    });

    if (result?.cancelled) {
      const cancelledState = updater.update({
        status: "cancelled",
        freshSessionAttempted: true,
        freshSessionCreated: false,
        fallbackUsed: false,
        elapsedMs: elapsedSince(startedAt, now),
        previousSessionId,
      });
      notify(
        ctx,
        `ralph-works new-session launch cancelled for ${boundaryDiagnostic(plan)}.`,
        "warning",
      );
      return createResult("cancelled", cancelledState, {
        cancelled: true,
      });
    }

    if (followupError) {
      return createResult("followup_failed", updater.state, {
        freshSessionCreated: true,
        error: followupError,
      });
    }

    const createdState = updater.update({
      status: "created",
      freshSessionAttempted: true,
      freshSessionCreated: true,
      fallbackUsed: false,
      elapsedMs: elapsedSince(startedAt, now),
      previousSessionId,
      replacementSessionId,
    });
    return createResult("created", createdState, {
      freshSessionCreated: true,
    });
  } catch (error) {
    if (setupCompleted || replacementCtxForNotify) {
      const failedState = updater.update({
        status: "followup_failed",
        freshSessionAttempted: true,
        freshSessionCreated: setupCompleted,
        fallbackUsed: false,
        elapsedMs: elapsedSince(startedAt, now),
        previousSessionId,
        replacementSessionId,
      });
      appendReplacementState(replacementCtxForNotify, failedState);
      notify(
        replacementCtxForNotify ?? ctx,
        `ralph-works follow-up failed for ${boundaryDiagnostic(plan)}; seeded replacement state remains available for resume.`,
        "error",
      );
      return createResult("followup_failed", failedState, {
        freshSessionCreated: setupCompleted,
        error,
      });
    }

    return runCompactionFallback({
      ctx,
      plan,
      updater,
      startedAt,
      now,
      attemptedFreshSession: true,
      error,
      sendFallbackPrompt,
      applyFallbackModel,
    });
  }
}
