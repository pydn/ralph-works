export function createImplementationStatus({
  claimedTaskIds = [],
  completedTaskIds = [],
  gateResultsByTask = {},
} = {}) {
  return {
    claimedTaskIds: [...claimedTaskIds],
    completedTaskIds: [...completedTaskIds],
    gateResultsByTask: { ...gateResultsByTask },
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
      [taskId]: gateResults,
    },
  };
}
