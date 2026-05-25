function uniqueStrings(values = []) {
  return Array.from(
    new Set(values.filter((value) => typeof value === "string" && value)),
  );
}

function finiteNumber(value) {
  return Number.isFinite(value) ? value : undefined;
}

function omitUndefined(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined),
  );
}

export function summarizeTaskGateResults(gateResults = []) {
  return (Array.isArray(gateResults) ? gateResults : []).map((result) =>
    omitUndefined({
      name: result.name,
      command: result.command,
      required: result.required !== false,
      code: finiteNumber(result.code),
      passed: result.passed === true,
      blocksTransition: result.blocksTransition === true,
      killed: result.killed === true,
    }),
  );
}

function normalizeGateResultsByTask(gateResultsByTask = {}) {
  return Object.fromEntries(
    Object.entries(gateResultsByTask).map(([taskId, results]) => [
      taskId,
      summarizeTaskGateResults(results),
    ]),
  );
}

export function createImplementationStatus({
  claimedTaskIds = [],
  completedTaskIds = [],
  gateResultsByTask = {},
  feature,
  status,
  updatedAt,
  tasks,
} = {}) {
  return omitUndefined({
    feature,
    status,
    updatedAt,
    tasks,
    claimedTaskIds: uniqueStrings(claimedTaskIds),
    completedTaskIds: uniqueStrings(completedTaskIds),
    gateResultsByTask: normalizeGateResultsByTask(gateResultsByTask),
  });
}

export function buildImplementationStatusDocument(
  implementationStatus = {},
  {
    feature,
    workflowStatus = "in_progress",
    updatedAt = new Date().toISOString(),
    previous = {},
  } = {},
) {
  const previousDocument =
    previous && typeof previous === "object" && !Array.isArray(previous)
      ? previous
      : {};
  const nextStatus = createImplementationStatus({
    ...previousDocument,
    ...implementationStatus,
    feature:
      feature ?? implementationStatus.feature ?? previousDocument.feature,
    status:
      workflowStatus ?? implementationStatus.status ?? previousDocument.status,
    updatedAt,
    gateResultsByTask: {
      ...(previousDocument.gateResultsByTask ?? {}),
      ...(implementationStatus.gateResultsByTask ?? {}),
    },
  });

  return {
    ...previousDocument,
    ...nextStatus,
  };
}

export function claimTask(status, taskId) {
  if (status.claimedTaskIds.includes(taskId)) {
    return status;
  }

  return {
    ...status,
    claimedTaskIds: [...status.claimedTaskIds, taskId],
  };
}

export function markTaskComplete(status, taskId, { gateResults = [] } = {}) {
  const claimedTaskIds = status.claimedTaskIds.filter((id) => id !== taskId);
  const completedTaskIds = status.completedTaskIds.includes(taskId)
    ? [...status.completedTaskIds]
    : [...status.completedTaskIds, taskId];

  return {
    ...status,
    claimedTaskIds,
    completedTaskIds,
    gateResultsByTask: {
      ...status.gateResultsByTask,
      [taskId]: summarizeTaskGateResults(gateResults),
    },
  };
}
