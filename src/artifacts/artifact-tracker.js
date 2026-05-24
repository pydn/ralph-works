export function recordArtifact(state, artifactKey, artifactPath) {
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
      [artifactKey]: artifactPath,
    },
  };
}

export function listArtifactReferences(state) {
  return Object.entries(state.artifacts).map(([key, value]) => ({
    key,
    path: value,
  }));
}
