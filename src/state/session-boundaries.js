const PENDING_BOUNDARY_STATUSES = new Set([
  "pending",
  "launching",
  "cancelled",
  "fallback_unavailable",
  "followup_failed",
]);

function assignDefined(target, values) {
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      target[key] = value;
    }
  }
  return target;
}

export function createSessionBoundaryEvent({
  id,
  boundaryType,
  boundary,
  reason = "workflow boundary",
  fromPhase,
  toPhase,
  taskId,
  nextTaskId,
  reviewFeedback,
  status = "pending",
  freshSessionAttempted = false,
  freshSessionCreated = false,
  fallbackUsed = false,
  elapsedMs,
  previousSessionId,
  replacementSessionId,
  now = () => new Date().toISOString(),
} = {}) {
  if (!id) {
    throw new Error("Session boundary event requires an id.");
  }

  const resolvedBoundaryType = boundaryType ?? boundary;
  if (!resolvedBoundaryType) {
    throw new Error("Session boundary event requires a boundary type.");
  }

  return assignDefined(
    {
      id,
      boundaryType: resolvedBoundaryType,
      reason,
      timestamp: now(),
      status,
      freshSessionAttempted,
      freshSessionCreated,
      fallbackUsed,
    },
    {
      fromPhase,
      toPhase,
      taskId,
      nextTaskId,
      reviewFeedback,
      elapsedMs,
      previousSessionId,
      replacementSessionId,
    },
  );
}

export function getSessionBoundaryEvents(state) {
  return Array.isArray(state?.sessionBoundaryEvents)
    ? state.sessionBoundaryEvents
    : [];
}

export function appendSessionBoundaryEvent(state, event) {
  const events = getSessionBoundaryEvents(state);
  if (events.some((existing) => existing.id === event.id)) {
    return {
      ...state,
      sessionBoundaryEvents: events,
    };
  }

  return {
    ...state,
    sessionBoundaryEvents: [...events, event],
  };
}

export function findSessionBoundaryEvent(state, boundaryId) {
  return getSessionBoundaryEvents(state).find(
    (event) => event.id === boundaryId,
  );
}

export function findPendingSessionBoundaryEvent(state, boundaryId) {
  const event = findSessionBoundaryEvent(state, boundaryId);
  return PENDING_BOUNDARY_STATUSES.has(event?.status) ? event : undefined;
}

export function findReusableUnresolvedPhaseBoundaryEvent(state) {
  const currentPhase = state?.currentPhase;
  if (!currentPhase) {
    return undefined;
  }

  return [...getSessionBoundaryEvents(state)]
    .reverse()
    .find(
      (event) =>
        event.boundaryType === "phase" &&
        event.toPhase === currentPhase &&
        PENDING_BOUNDARY_STATUSES.has(event.status),
    );
}

export function updateSessionBoundaryEvent(state, boundaryId, updates) {
  let found = false;
  const events = getSessionBoundaryEvents(state).map((event) => {
    if (event.id !== boundaryId) {
      return event;
    }

    found = true;
    const resolvedUpdates =
      typeof updates === "function" ? updates(event) : updates;
    return {
      ...event,
      ...resolvedUpdates,
      id: event.id,
    };
  });

  if (!found) {
    return state;
  }

  return {
    ...state,
    sessionBoundaryEvents: events,
  };
}

export function updatePendingSessionBoundaryEvent(state, boundaryId, updates) {
  if (!findPendingSessionBoundaryEvent(state, boundaryId)) {
    return state;
  }

  return updateSessionBoundaryEvent(state, boundaryId, updates);
}
