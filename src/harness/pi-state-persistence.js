import { readFileSync } from "node:fs";
import path from "node:path";
import { createPhaseState } from "../state/phase-state.js";
import { createImplementationStatus } from "../tasks/task-status-updater.js";

export const RALPH_WORKS_STATE_ENTRY_TYPE = "ralph-works-state";

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function implementationStatusArtifactPath(ctx, state) {
  if (state.artifacts?.implementationStatus) {
    return state.artifacts.implementationStatus;
  }

  return ctx.cwd
    ? state.phases.find((phase) => phase.id === "tdd_implement")?.artifactPath
    : undefined;
}

function readImplementationStatusArtifact(ctx, state) {
  const artifactPath = implementationStatusArtifactPath(ctx, state);
  if (!artifactPath) {
    return undefined;
  }

  try {
    if (!ctx.cwd && !path.isAbsolute(artifactPath)) {
      return undefined;
    }
    const absolutePath = path.isAbsolute(artifactPath)
      ? artifactPath
      : path.resolve(ctx.cwd, artifactPath);
    const document = JSON.parse(readFileSync(absolutePath, "utf8"));
    return isObject(document) ? { artifactPath, document } : undefined;
  } catch {
    return undefined;
  }
}

function uniqueStrings(...groups) {
  return Array.from(
    new Set(
      groups.flatMap((values) =>
        Array.isArray(values)
          ? values.filter((value) => typeof value === "string" && value)
          : [],
      ),
    ),
  );
}

function mergeImplementationStatus(stateStatus, artifactStatus) {
  const stateDocument = isObject(stateStatus) ? stateStatus : {};
  const artifactDocument = isObject(artifactStatus) ? artifactStatus : {};
  const stateNormalized = createImplementationStatus(stateDocument);
  const artifactNormalized = createImplementationStatus(artifactDocument);
  const tasks = {
    ...(isObject(stateDocument.tasks) ? stateDocument.tasks : {}),
    ...(isObject(artifactDocument.tasks) ? artifactDocument.tasks : {}),
  };

  return {
    ...stateDocument,
    ...artifactDocument,
    ...createImplementationStatus({
      ...stateDocument,
      ...artifactDocument,
      tasks: Object.keys(tasks).length > 0 ? tasks : undefined,
      claimedTaskIds: uniqueStrings(
        stateNormalized.claimedTaskIds,
        artifactNormalized.claimedTaskIds,
      ),
      completedTaskIds: uniqueStrings(
        stateNormalized.completedTaskIds,
        artifactNormalized.completedTaskIds,
      ),
      gateResultsByTask: {
        ...stateNormalized.gateResultsByTask,
        ...artifactNormalized.gateResultsByTask,
      },
    }),
  };
}

function restoreImplementationStatusFromArtifact(ctx, state) {
  const artifact = readImplementationStatusArtifact(ctx, state);
  if (!artifact) {
    return state;
  }

  return {
    ...state,
    artifacts: {
      ...state.artifacts,
      implementationStatus:
        state.artifacts?.implementationStatus ?? artifact.artifactPath,
    },
    implementationStatus: mergeImplementationStatus(
      state.implementationStatus,
      artifact.document,
    ),
  };
}

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
  const restoredState = {
    ...baseState,
    ...restored.data,
    phases: baseState.phases,
  };

  return restoreImplementationStatusFromArtifact(ctx, {
    ...restoredState,
    sessionBoundaryEvents: Array.isArray(restoredState.sessionBoundaryEvents)
      ? restoredState.sessionBoundaryEvents
      : [],
    compactionEvents: Array.isArray(restoredState.compactionEvents)
      ? restoredState.compactionEvents
      : [],
  });
}

export function persistRalphWorksState(pi, state) {
  pi.appendEntry?.(RALPH_WORKS_STATE_ENTRY_TYPE, state);
}
