import {
  type ArtifactInventoryLimits,
  buildSessionHandoffSummary,
  type ExplicitArtifact,
  type HandoffSummaryState,
} from "../artifacts/session-handoff-summary.ts";
import { createPhaseState } from "../state/phase-state.ts";
import type {
  NowProvider,
  SessionHandoffDescriptor,
  WorkflowState,
} from "../state/phase-types.ts";
import {
  markSessionHandoffReadyInNewSession,
  validatePendingSessionHandoff,
} from "../state/session-handoff-state.ts";
import type {
  PersistedSessionEntry,
  RalphWorksPiApi,
  RalphWorksSessionManager,
} from "./pi-harness-types.ts";

export const RALPH_WORKS_STATE_ENTRY_TYPE = "ralph-works-state";
export const RALPH_WORKS_HANDOFF_MESSAGE_ENTRY_TYPE = "ralph-works-handoff";

interface PersistedWorkflowState extends Partial<WorkflowState> {
  currentPhase: WorkflowState["currentPhase"];
}

interface AppendHandoffMessageOptions {
  display?: boolean;
  details?: Record<string, unknown>;
}

interface SetupReplacementSessionOptions {
  handoffId?: string;
  handoffSummary?: string;
  cwd?: string;
  currentArtifacts?: ExplicitArtifact[];
  limits?: Partial<ArtifactInventoryLimits>;
  now?: NowProvider;
}

function isPersistedWorkflowState(
  data: unknown,
): data is PersistedWorkflowState {
  return (
    data !== null &&
    typeof data === "object" &&
    "currentPhase" in data &&
    Boolean((data as { currentPhase?: unknown }).currentPhase)
  );
}

function findRestoredStateEntry(
  entries: readonly PersistedSessionEntry[],
): PersistedSessionEntry | undefined {
  return [...entries]
    .reverse()
    .find(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === RALPH_WORKS_STATE_ENTRY_TYPE,
    );
}

export function restoreRalphWorksState(ctx: {
  sessionManager?: RalphWorksSessionManager;
}): WorkflowState | undefined {
  const entries = ctx.sessionManager?.getEntries?.() ?? [];
  const restored = findRestoredStateEntry(entries);
  if (!isPersistedWorkflowState(restored?.data)) {
    return undefined;
  }

  const baseState = createPhaseState({ feature: restored.data.feature });
  return {
    ...baseState,
    ...restored.data,
    phases: baseState.phases,
  };
}

export function appendRalphWorksStateEntry(
  sessionTarget: RalphWorksSessionManager | undefined,
  state: WorkflowState,
): unknown {
  if (typeof sessionTarget?.appendCustomEntry === "function") {
    return sessionTarget.appendCustomEntry(RALPH_WORKS_STATE_ENTRY_TYPE, state);
  }

  if (typeof sessionTarget?.appendEntry === "function") {
    return sessionTarget.appendEntry(RALPH_WORKS_STATE_ENTRY_TYPE, state);
  }

  throw new Error("RalphWorks cannot append durable state to this session.");
}

export function appendRalphWorksHandoffMessageEntry(
  sessionManager: RalphWorksSessionManager | undefined,
  handoffSummary: string,
  { display = true, details }: AppendHandoffMessageOptions = {},
): unknown {
  if (typeof sessionManager?.appendCustomMessageEntry !== "function") {
    throw new Error(
      "RalphWorks cannot append handoff context to this session.",
    );
  }

  return sessionManager.appendCustomMessageEntry(
    RALPH_WORKS_HANDOFF_MESSAGE_ENTRY_TYPE,
    handoffSummary,
    display,
    details,
  );
}

function handoffEntryDetails(
  descriptor: SessionHandoffDescriptor,
): Record<string, unknown> {
  return {
    handoffId: descriptor.id,
    boundary: descriptor.boundary,
    sourcePhase: descriptor.sourcePhase,
    targetPhase: descriptor.targetPhase,
  };
}

export function setupRalphWorksReplacementSession(
  sessionManager: RalphWorksSessionManager | undefined,
  state: WorkflowState,
  {
    handoffId,
    handoffSummary,
    cwd = process.cwd(),
    currentArtifacts,
    limits,
    now = () => new Date().toISOString(),
  }: SetupReplacementSessionOptions = {},
): { state: WorkflowState; handoffSummary: string } {
  const descriptor = validatePendingSessionHandoff(state, handoffId);
  const replacementSessionFile = sessionManager?.getSessionFile?.();
  const replacementState = markSessionHandoffReadyInNewSession(
    state,
    descriptor.id,
    {
      now,
      replacementSessionFile,
    },
  );
  const readyDescriptor = validatePendingSessionHandoff(
    replacementState,
    descriptor.id,
  );
  const summary =
    handoffSummary ??
    buildSessionHandoffSummary(replacementState as HandoffSummaryState, {
      cwd,
      currentArtifacts,
      limits,
      boundary: readyDescriptor.boundary,
      handoffId: readyDescriptor.id,
      reason: readyDescriptor.reason,
      sourcePhase: readyDescriptor.sourcePhase,
      targetPhase: readyDescriptor.targetPhase,
    });

  appendRalphWorksStateEntry(sessionManager, replacementState);
  appendRalphWorksHandoffMessageEntry(sessionManager, summary, {
    display: true,
    details: handoffEntryDetails(readyDescriptor),
  });

  return {
    state: replacementState,
    handoffSummary: summary,
  };
}

export function persistRalphWorksState(
  pi: Pick<RalphWorksPiApi, "appendEntry">,
  state: WorkflowState,
): void {
  pi.appendEntry?.(RALPH_WORKS_STATE_ENTRY_TYPE, state);
}
