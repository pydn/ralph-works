import type {
  HandoffStatus,
  NowProvider,
  PhaseStatus,
  SessionHandoffDescriptor,
  SessionHandoffEvent,
  WorkflowState,
} from "./phase-types.ts";

export const HANDOFF_PHASE_PENDING_STATUS = "handoff_pending";
export const HANDOFF_PHASE_FAILED_STATUS = "handoff_failed";

export const HANDOFF_STATUS_PENDING = "pending";
export const HANDOFF_STATUS_IN_PROGRESS = "in_progress";
export const HANDOFF_STATUS_READY_IN_NEW_SESSION = "ready_in_new_session";
export const HANDOFF_STATUS_COMPLETED = "completed";
export const HANDOFF_STATUS_FAILED = "failed";

const ACTIVE_HANDOFF_STATUSES = new Set<HandoffStatus>([
  HANDOFF_STATUS_PENDING,
  HANDOFF_STATUS_IN_PROGRESS,
  HANDOFF_STATUS_READY_IN_NEW_SESSION,
]);

type HandoffStateLike = Partial<WorkflowState> | null | undefined;

function timestamp(now: NowProvider): string {
  return now();
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error ?? "unknown handoff failure");
}

function hasCompletedHandoffEvent(
  state: HandoffStateLike,
  handoffId: string,
): boolean {
  return (state?.sessionHandoffEvents ?? []).some(
    (event) =>
      event.id === handoffId && event.status === HANDOFF_STATUS_COMPLETED,
  );
}

function isActiveHandoff(
  descriptor: SessionHandoffDescriptor | undefined,
): descriptor is SessionHandoffDescriptor {
  return (
    descriptor !== undefined && ACTIVE_HANDOFF_STATUSES.has(descriptor.status)
  );
}

function handoffMatches(
  left: SessionHandoffDescriptor,
  right: SessionHandoffDescriptor,
): boolean {
  return (
    left.id === right.id &&
    left.boundary === right.boundary &&
    left.sourcePhase === right.sourcePhase &&
    left.targetPhase === right.targetPhase &&
    left.taskId === right.taskId
  );
}

function requireValue(name: string, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`RalphWorks handoff requires ${name}.`);
  }
  return value;
}

function removePendingHandoff(state: WorkflowState): WorkflowState {
  const next = { ...state };
  delete next.pendingHandoff;
  return next;
}

export function isHandoffPendingState(state: HandoffStateLike): boolean {
  return (
    state?.phaseStatus === HANDOFF_PHASE_PENDING_STATUS ||
    isActiveHandoff(state?.pendingHandoff)
  );
}

export function isHandoffFailedState(state: HandoffStateLike): boolean {
  return (
    state?.phaseStatus === HANDOFF_PHASE_FAILED_STATUS ||
    state?.pendingHandoff?.status === HANDOFF_STATUS_FAILED
  );
}

export function isHandoffBlockingState(state: HandoffStateLike): boolean {
  return isHandoffPendingState(state) || isHandoffFailedState(state);
}

interface CreatePendingSessionHandoffOptions {
  id?: string;
  boundary?: string;
  reason?: string;
  sourcePhase?: string;
  targetPhase?: string;
  taskId?: string;
  now?: NowProvider;
}

export function createPendingSessionHandoff(
  state: WorkflowState | undefined,
  {
    id,
    boundary,
    reason = "workflow boundary",
    sourcePhase = state?.currentPhase,
    targetPhase,
    taskId,
    now = () => new Date().toISOString(),
  }: CreatePendingSessionHandoffOptions = {},
): WorkflowState {
  if (!state) {
    throw new Error("RalphWorks handoff requires workflow state.");
  }

  const at = timestamp(now);
  const descriptor: SessionHandoffDescriptor = {
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

  const existingHandoff = state.pendingHandoff;
  if (isActiveHandoff(existingHandoff)) {
    if (handoffMatches(existingHandoff, descriptor)) {
      return state;
    }
    throw new Error(
      `RalphWorks handoff already pending: ${existingHandoff.id}`,
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

interface ValidatePendingSessionHandoffOptions {
  expectedSourcePhase?: string;
  expectedTargetPhase?: string;
  expectedStatuses?: readonly HandoffStatus[];
  expectedStatus?: HandoffStatus;
}

export function validatePendingSessionHandoff(
  state: HandoffStateLike,
  handoffId?: string,
  {
    expectedSourcePhase,
    expectedTargetPhase,
    expectedStatuses,
    expectedStatus,
  }: ValidatePendingSessionHandoffOptions = {},
): SessionHandoffDescriptor {
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
  state: WorkflowState,
  handoffId: string,
  { now = () => new Date().toISOString() }: { now?: NowProvider } = {},
): WorkflowState {
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

interface MarkSessionHandoffReadyOptions {
  now?: NowProvider;
  replacementSessionFile?: string;
}

export function markSessionHandoffReadyInNewSession(
  state: WorkflowState,
  handoffId: string,
  {
    now = () => new Date().toISOString(),
    replacementSessionFile,
  }: MarkSessionHandoffReadyOptions = {},
): WorkflowState {
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

interface CompleteSessionHandoffOptions {
  now?: NowProvider;
  phaseStatus?: PhaseStatus;
  replacementSessionFile?: string;
}

export function completeSessionHandoff(
  state: WorkflowState,
  handoffId: string,
  {
    now = () => new Date().toISOString(),
    phaseStatus = "executing",
    replacementSessionFile,
  }: CompleteSessionHandoffOptions = {},
): WorkflowState {
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
  const completedEvent: SessionHandoffEvent = {
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

interface FailSessionHandoffOptions {
  error?: unknown;
  now?: NowProvider;
}

export function failSessionHandoff(
  state: WorkflowState,
  handoffId: string,
  {
    error,
    now = () => new Date().toISOString(),
  }: FailSessionHandoffOptions = {},
): WorkflowState {
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
