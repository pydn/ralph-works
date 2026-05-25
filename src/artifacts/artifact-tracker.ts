import type { WorkflowState } from "../state/phase-types.ts";
import { buildArtifactPath } from "./artifact-paths.ts";

export interface ArtifactReference {
  key: string;
  path: string;
}

export function recordArtifact(
  state: WorkflowState,
  artifactKey: unknown,
  artifactPath: unknown,
): WorkflowState {
  if (typeof artifactKey !== "string" || artifactKey.trim() === "") {
    throw new Error("artifactKey must be a non-empty string.");
  }
  if (typeof artifactPath !== "string" || artifactPath.trim() === "") {
    throw new Error("artifactPath must be a non-empty string.");
  }

  return {
    ...state,
    artifacts: {
      ...state.artifacts,
      [artifactKey]: buildArtifactPath(state.feature, artifactPath),
    },
  };
}

export function listArtifactReferences(
  state: Pick<WorkflowState, "artifacts">,
): ArtifactReference[] {
  return Object.entries(state.artifacts).map(([key, value]) => ({
    key,
    path: value,
  }));
}
