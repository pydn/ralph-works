import { buildSessionHandoffSummary } from "../artifacts/session-handoff-summary.js";
import { createPhaseState } from "../state/phase-state.js";
import {
  markSessionHandoffReadyInNewSession,
  validatePendingSessionHandoff,
} from "../state/session-handoff-state.js";

export const RALPH_WORKS_STATE_ENTRY_TYPE = "ralph-works-state";
export const RALPH_WORKS_HANDOFF_MESSAGE_ENTRY_TYPE = "ralph-works-handoff";

export function restoreRalphWorksState(ctx) {
  const entries = ctx.sessionManager?.getEntries?.() ?? [];
  const restored = [...entries]
    .reverse()
    .find(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === RALPH_WORKS_STATE_ENTRY_TYPE,
    );

  if (!restored?.data?.currentPhase) {
    return undefined;
  }

  const baseState = createPhaseState({ feature: restored.data.feature });
  return {
    ...baseState,
    ...restored.data,
    phases: baseState.phases,
  };
}

export function appendRalphWorksStateEntry(sessionTarget, state) {
  if (typeof sessionTarget?.appendCustomEntry === "function") {
    return sessionTarget.appendCustomEntry(RALPH_WORKS_STATE_ENTRY_TYPE, state);
  }

  if (typeof sessionTarget?.appendEntry === "function") {
    return sessionTarget.appendEntry(RALPH_WORKS_STATE_ENTRY_TYPE, state);
  }

  throw new Error("RalphWorks cannot append durable state to this session.");
}

export function appendRalphWorksHandoffMessageEntry(
  sessionManager,
  handoffSummary,
  { display = true, details } = {},
) {
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

function handoffEntryDetails(descriptor) {
  return {
    handoffId: descriptor.id,
    boundary: descriptor.boundary,
    sourcePhase: descriptor.sourcePhase,
    targetPhase: descriptor.targetPhase,
  };
}

export function setupRalphWorksReplacementSession(
  sessionManager,
  state,
  {
    handoffId,
    handoffSummary,
    cwd = process.cwd(),
    currentArtifacts,
    limits,
    now = () => new Date().toISOString(),
  } = {},
) {
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
  const readyDescriptor = replacementState.pendingHandoff;
  const summary =
    handoffSummary ??
    buildSessionHandoffSummary(replacementState, {
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

export function persistRalphWorksState(pi, state) {
  pi.appendEntry?.(RALPH_WORKS_STATE_ENTRY_TYPE, state);
}
