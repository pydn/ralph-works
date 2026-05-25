import type {
  ArtifactInventoryLimits,
  ExplicitArtifact,
} from "../artifacts/session-handoff-summary.ts";
import type { NowProvider, WorkflowState } from "../state/phase-types.ts";
import {
  failSessionHandoff,
  HANDOFF_STATUS_IN_PROGRESS,
  HANDOFF_STATUS_PENDING,
  markSessionHandoffInProgress,
  validatePendingSessionHandoff,
} from "../state/session-handoff-state.ts";
import type {
  RalphWorksContext,
  RalphWorksNewSessionResult,
  RalphWorksSessionManager,
} from "./pi-harness-types.ts";
import {
  appendRalphWorksStateEntry,
  setupRalphWorksReplacementSession,
} from "./pi-state-persistence.ts";

export const RALPH_WORKS_NEW_SESSION_NOTICE =
  "ralph-works is creating a new session with fresh context.";

interface SessionHandoffContinuationContext {
  state: WorkflowState;
  handoffId: string;
  handoffSummary: string | undefined;
}

interface ExecuteSessionHandoffOptions {
  handoffId?: string;
  cwd?: string;
  currentArtifacts?: ExplicitArtifact[];
  handoffSummary?: string;
  limits?: Partial<ArtifactInventoryLimits>;
  now?: NowProvider;
  onStateChange?: (state: WorkflowState) => void | Promise<void>;
  setupReplacementSession?: typeof setupRalphWorksReplacementSession;
  withReplacementSession?: (
    ctx: RalphWorksContext,
    context: SessionHandoffContinuationContext,
  ) => void | Promise<void>;
}

interface NotifyFailureOptions {
  now?: NowProvider;
  onStateChange?: (state: WorkflowState) => void | Promise<void>;
}

export interface SessionHandoffExecutionResult {
  failed: boolean;
  state: WorkflowState;
  error?: Error;
  result?: RalphWorksNewSessionResult;
}

function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  return new Error(String(value ?? "unknown session handoff failure"));
}

async function notifyAndRecordFailure(
  ctx: Partial<RalphWorksContext> | undefined,
  state: WorkflowState,
  handoffId: string,
  error: unknown,
  { now, onStateChange }: NotifyFailureOptions = {},
): Promise<SessionHandoffExecutionResult> {
  const normalizedError = toError(error);
  const failedState = failSessionHandoff(state, handoffId, {
    error: normalizedError,
    now,
  });
  const failedDescriptor = validatePendingSessionHandoff(
    failedState,
    handoffId,
  );
  await onStateChange?.(failedState);
  ctx?.ui?.notify?.(
    failedDescriptor.errorMessage ?? normalizedError.message,
    "error",
  );
  return {
    failed: true,
    state: failedState,
    error: normalizedError,
  };
}

export async function executeRalphWorksSessionHandoff(
  ctx: Partial<RalphWorksContext> | undefined,
  state: WorkflowState,
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
  }: ExecuteSessionHandoffOptions = {},
): Promise<SessionHandoffExecutionResult> {
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
  let replacementFailure: Error | undefined;

  try {
    const result = await ctx.newSession({
      parentSession,
      setup: async (sessionManager: RalphWorksSessionManager) => {
        const setupResult = setupReplacementSession(
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
      withSession: async (newCtx: RalphWorksContext) => {
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
          const failedDescriptor = validatePendingSessionHandoff(
            failedState,
            descriptor.id,
          );
          newCtx.ui?.notify?.(
            failedDescriptor.errorMessage ?? replacementFailure.message,
            "error",
          );
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
