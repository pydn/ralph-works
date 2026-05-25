import type { GateResult, ImplementationStatus } from "../state/phase-types.ts";

interface CreateImplementationStatusOptions {
  claimedTaskIds?: string[];
  completedTaskIds?: string[];
  gateResultsByTask?: Record<string, GateResult[]>;
}

export function createImplementationStatus({
  claimedTaskIds = [],
  completedTaskIds = [],
  gateResultsByTask = {},
}: CreateImplementationStatusOptions = {}): ImplementationStatus {
  return {
    claimedTaskIds: [...claimedTaskIds],
    completedTaskIds: [...completedTaskIds],
    gateResultsByTask: { ...gateResultsByTask },
  };
}

export function claimTask(
  status: ImplementationStatus,
  taskId: string,
): ImplementationStatus {
  if (status.claimedTaskIds.includes(taskId)) {
    return status;
  }

  return {
    ...status,
    claimedTaskIds: [...status.claimedTaskIds, taskId],
  };
}

export function markTaskComplete(
  status: ImplementationStatus,
  taskId: string,
  { gateResults = [] }: { gateResults?: GateResult[] } = {},
): ImplementationStatus {
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
