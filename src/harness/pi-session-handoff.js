import {
  failSessionHandoff,
  HANDOFF_STATUS_IN_PROGRESS,
  HANDOFF_STATUS_PENDING,
  markSessionHandoffInProgress,
  validatePendingSessionHandoff,
} from "../state/session-handoff-state.js";
import {
  appendRalphWorksStateEntry,
  setupRalphWorksReplacementSession,
} from "./pi-state-persistence.js";

export const RALPH_WORKS_NEW_SESSION_NOTICE =
  "ralph-works is creating a new session with fresh context.";

function toError(value) {
  if (value instanceof Error) {
    return value;
  }
  return new Error(String(value ?? "unknown session handoff failure"));
}

async function notifyAndRecordFailure(
  ctx,
  state,
  handoffId,
  error,
  { now, onStateChange } = {},
) {
  const failedState = failSessionHandoff(state, handoffId, {
    error: toError(error),
    now,
  });
  await onStateChange?.(failedState);
  ctx?.ui?.notify?.(failedState.pendingHandoff.errorMessage, "error");
  return {
    failed: true,
    state: failedState,
    error: toError(error),
  };
}

export async function executeRalphWorksSessionHandoff(
  ctx,
  state,
  {
    handoffId,
    cwd = ctx?.cwd ?? process.cwd(),
    currentArtifacts,
    handoffSummary,
    limits,
    now = () => new Date().toISOString(),
    onStateChange,
    setupReplacementSession = setupRalphWorksReplacementSession,
    withReplacementSession,
  } = {},
) {
  const descriptor = validatePendingSessionHandoff(state, handoffId, {
    expectedStatuses: [HANDOFF_STATUS_PENDING, HANDOFF_STATUS_IN_PROGRESS],
  });
  const inProgressState = markSessionHandoffInProgress(state, descriptor.id, {
    now,
  });
  if (inProgressState !== state) {
    await onStateChange?.(inProgressState);
  }

  ctx?.ui?.notify?.(RALPH_WORKS_NEW_SESSION_NOTICE, "info");

  if (typeof ctx?.newSession !== "function") {
    return notifyAndRecordFailure(
      ctx,
      inProgressState,
      descriptor.id,
      new Error("RalphWorks session handoff requires ctx.newSession."),
      { now, onStateChange },
    );
  }

  const parentSession = ctx.sessionManager?.getSessionFile?.();
  let replacementState = inProgressState;
  let replacementSummary = handoffSummary;
  let enteredReplacementSession = false;
  let replacementFailure;

  try {
    const result = await ctx.newSession({
      parentSession,
      setup: async (sessionManager) => {
        const setupResult = await setupReplacementSession(
          sessionManager,
          inProgressState,
          {
            handoffId: descriptor.id,
            handoffSummary,
            cwd,
            currentArtifacts,
            limits,
            now,
          },
        );
        replacementState = setupResult.state;
        replacementSummary = setupResult.handoffSummary;
      },
      withSession: async (newCtx) => {
        enteredReplacementSession = true;
        try {
          await withReplacementSession?.(newCtx, {
            state: replacementState,
            handoffId: descriptor.id,
            handoffSummary: replacementSummary,
          });
        } catch (error) {
          replacementFailure = toError(error);
          const failedState = failSessionHandoff(
            replacementState,
            descriptor.id,
            {
              error: replacementFailure,
              now,
            },
          );
          replacementState = failedState;
          appendRalphWorksStateEntry(newCtx.sessionManager, failedState);
          newCtx.ui?.notify?.(failedState.pendingHandoff.errorMessage, "error");
        }
      },
    });

    if (result?.cancelled) {
      return notifyAndRecordFailure(
        ctx,
        inProgressState,
        descriptor.id,
        new Error("RalphWorks session handoff cancelled."),
        { now, onStateChange },
      );
    }

    if (replacementFailure) {
      return {
        failed: true,
        state: replacementState,
        error: replacementFailure,
        result,
      };
    }

    return {
      failed: false,
      state: replacementState,
      result,
    };
  } catch (error) {
    if (enteredReplacementSession) {
      return {
        failed: true,
        state: replacementState,
        error: toError(error),
      };
    }

    return notifyAndRecordFailure(ctx, inProgressState, descriptor.id, error, {
      now,
      onStateChange,
    });
  }
}
