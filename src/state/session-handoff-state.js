export const HANDOFF_PHASE_PENDING_STATUS = "handoff_pending";
export const HANDOFF_PHASE_FAILED_STATUS = "handoff_failed";

export const HANDOFF_STATUS_PENDING = "pending";
export const HANDOFF_STATUS_IN_PROGRESS = "in_progress";
export const HANDOFF_STATUS_READY_IN_NEW_SESSION = "ready_in_new_session";
export const HANDOFF_STATUS_COMPLETED = "completed";
export const HANDOFF_STATUS_FAILED = "failed";

const ACTIVE_HANDOFF_STATUSES = new Set([
  HANDOFF_STATUS_PENDING,
  HANDOFF_STATUS_IN_PROGRESS,
  HANDOFF_STATUS_READY_IN_NEW_SESSION,
]);

function timestamp(now) {
  return now();
}

function errorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error ?? "unknown handoff failure");
}

function hasCompletedHandoffEvent(state, handoffId) {
  return (state.sessionHandoffEvents ?? []).some(
    (event) =>
      event.id === handoffId && event.status === HANDOFF_STATUS_COMPLETED,
  );
}

function isActiveHandoff(descriptor) {
  return ACTIVE_HANDOFF_STATUSES.has(descriptor?.status);
}

function handoffMatches(left, right) {
  return (
    left.id === right.id &&
    left.boundary === right.boundary &&
    left.sourcePhase === right.sourcePhase &&
    left.targetPhase === right.targetPhase &&
    left.taskId === right.taskId
  );
}

function requireValue(name, value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`RalphWorks handoff requires ${name}.`);
  }
  return value;
}

function removePendingHandoff(state) {
  const next = { ...state };
  delete next.pendingHandoff;
  return next;
}

export function isHandoffPendingState(state) {
  return (
    state?.phaseStatus === HANDOFF_PHASE_PENDING_STATUS ||
    isActiveHandoff(state?.pendingHandoff)
  );
}

export function isHandoffFailedState(state) {
  return (
    state?.phaseStatus === HANDOFF_PHASE_FAILED_STATUS ||
    state?.pendingHandoff?.status === HANDOFF_STATUS_FAILED
  );
}

export function isHandoffBlockingState(state) {
  return isHandoffPendingState(state) || isHandoffFailedState(state);
}

export function createPendingSessionHandoff(
  state,
  {
    id,
    boundary,
    reason = "workflow boundary",
    sourcePhase = state?.currentPhase,
    targetPhase,
    taskId,
    now = () => new Date().toISOString(),
  } = {},
) {
  if (!state) {
    throw new Error("RalphWorks handoff requires workflow state.");
  }

  const at = timestamp(now);
  const descriptor = {
    id: requireValue("id", id),
    boundary: requireValue("boundary", boundary),
    reason,
    sourcePhase: requireValue("sourcePhase", sourcePhase),
    targetPhase: requireValue("targetPhase", targetPhase),
    taskId,
    status: HANDOFF_STATUS_PENDING,
    createdAt: at,
    updatedAt: at,
  };

  if (isActiveHandoff(state.pendingHandoff)) {
    if (handoffMatches(state.pendingHandoff, descriptor)) {
      return state;
    }
    throw new Error(
      `RalphWorks handoff already pending: ${state.pendingHandoff.id}`,
    );
  }

  if (isHandoffFailedState(state)) {
    throw new Error(
      `RalphWorks handoff already failed: ${state.pendingHandoff?.id ?? "unknown"}`,
    );
  }

  return {
    ...state,
    pipelineStatus: state.pipelineStatus ?? "running",
    phaseStatus: HANDOFF_PHASE_PENDING_STATUS,
    pendingHandoff: descriptor,
    sessionHandoffEvents: state.sessionHandoffEvents ?? [],
  };
}

export function validatePendingSessionHandoff(
  state,
  handoffId,
  {
    expectedSourcePhase,
    expectedTargetPhase,
    expectedStatuses,
    expectedStatus,
  } = {},
) {
  const descriptor = state?.pendingHandoff;
  if (!descriptor) {
    throw new Error("No RalphWorks handoff is pending.");
  }

  if (handoffId !== undefined && descriptor.id !== handoffId) {
    throw new Error(
      `RalphWorks handoff id mismatch: expected ${handoffId}, found ${descriptor.id}.`,
    );
  }

  if (
    expectedSourcePhase !== undefined &&
    descriptor.sourcePhase !== expectedSourcePhase
  ) {
    throw new Error(
      `RalphWorks handoff source phase mismatch: expected ${expectedSourcePhase}, found ${descriptor.sourcePhase}.`,
    );
  }

  if (
    expectedTargetPhase !== undefined &&
    descriptor.targetPhase !== expectedTargetPhase
  ) {
    throw new Error(
      `RalphWorks handoff target phase mismatch: expected ${expectedTargetPhase}, found ${descriptor.targetPhase}.`,
    );
  }

  const statuses =
    expectedStatuses ??
    (expectedStatus === undefined ? undefined : [expectedStatus]);
  if (statuses !== undefined && !statuses.includes(descriptor.status)) {
    throw new Error(
      `RalphWorks handoff status mismatch: expected ${statuses.join(
        " or ",
      )}, found ${descriptor.status}.`,
    );
  }

  return descriptor;
}

export function markSessionHandoffInProgress(
  state,
  handoffId,
  { now = () => new Date().toISOString() } = {},
) {
  const descriptor = validatePendingSessionHandoff(state, handoffId, {
    expectedStatuses: [HANDOFF_STATUS_PENDING, HANDOFF_STATUS_IN_PROGRESS],
  });
  if (descriptor.status === HANDOFF_STATUS_IN_PROGRESS) {
    return state;
  }

  const at = timestamp(now);
  return {
    ...state,
    phaseStatus: HANDOFF_PHASE_PENDING_STATUS,
    pendingHandoff: {
      ...descriptor,
      status: HANDOFF_STATUS_IN_PROGRESS,
      startedAt: at,
      updatedAt: at,
    },
  };
}

export function markSessionHandoffReadyInNewSession(
  state,
  handoffId,
  { now = () => new Date().toISOString(), replacementSessionFile } = {},
) {
  const descriptor = validatePendingSessionHandoff(state, handoffId, {
    expectedStatuses: [
      HANDOFF_STATUS_PENDING,
      HANDOFF_STATUS_IN_PROGRESS,
      HANDOFF_STATUS_READY_IN_NEW_SESSION,
    ],
  });
  if (descriptor.status === HANDOFF_STATUS_READY_IN_NEW_SESSION) {
    return state;
  }

  const at = timestamp(now);
  return {
    ...state,
    phaseStatus: HANDOFF_PHASE_PENDING_STATUS,
    pendingHandoff: {
      ...descriptor,
      status: HANDOFF_STATUS_READY_IN_NEW_SESSION,
      readyAt: at,
      updatedAt: at,
      replacementSessionFile:
        replacementSessionFile ?? descriptor.replacementSessionFile,
    },
  };
}

export function completeSessionHandoff(
  state,
  handoffId,
  {
    now = () => new Date().toISOString(),
    phaseStatus = "executing",
    replacementSessionFile,
  } = {},
) {
  if (hasCompletedHandoffEvent(state, handoffId)) {
    return state;
  }

  const descriptor = validatePendingSessionHandoff(state, handoffId, {
    expectedStatuses: [
      HANDOFF_STATUS_PENDING,
      HANDOFF_STATUS_IN_PROGRESS,
      HANDOFF_STATUS_READY_IN_NEW_SESSION,
    ],
  });
  const completedAt = timestamp(now);
  const next = removePendingHandoff(state);
  const completedEvent = {
    id: descriptor.id,
    boundary: descriptor.boundary,
    reason: descriptor.reason,
    sourcePhase: descriptor.sourcePhase,
    targetPhase: descriptor.targetPhase,
    taskId: descriptor.taskId,
    status: HANDOFF_STATUS_COMPLETED,
    createdAt: descriptor.createdAt,
    completedAt,
    replacementSessionFile:
      replacementSessionFile ?? descriptor.replacementSessionFile,
  };

  return {
    ...next,
    phaseStatus,
    pipelineStatus:
      state.pipelineStatus === "blocked" ? "running" : state.pipelineStatus,
    sessionHandoffEvents: [
      ...(state.sessionHandoffEvents ?? []),
      completedEvent,
    ],
  };
}

export function failSessionHandoff(
  state,
  handoffId,
  { error, now = () => new Date().toISOString() } = {},
) {
  const descriptor = validatePendingSessionHandoff(state, handoffId);
  if (descriptor.status === HANDOFF_STATUS_FAILED) {
    return state;
  }

  const failedAt = timestamp(now);
  return {
    ...state,
    pipelineStatus: "blocked",
    phaseStatus: HANDOFF_PHASE_FAILED_STATUS,
    pendingHandoff: {
      ...descriptor,
      status: HANDOFF_STATUS_FAILED,
      failedAt,
      updatedAt: failedAt,
      errorMessage: errorMessage(error),
    },
    sessionHandoffEvents: state.sessionHandoffEvents ?? [],
  };
}
