import { listArtifactReferences } from "./artifact-tracker.js";

export function buildCompactionSummary(
  state,
  { boundary, reason = "workflow boundary" } = {},
) {
  const lines = [
    "## Goal",
    "Continue the RalphWorks Pi extension workflow.",
    "",
    "## Critical Context",
    `Extension: ${state.extensionName}`,
    `Boundary: ${boundary ?? "unspecified"}`,
    `Reason: ${reason}`,
    `Current phase: ${state.currentPhase}`,
    `Completed phases: ${
      state.completedPhases.length > 0 ? state.completedPhases.join(", ") : "none"
    }`,
    `Loopbacks: ${state.loopbackCount}`,
    `TDD completed tasks: ${state.tddCompletedTasks}`,
    "",
    "## Artifacts",
  ];

  const artifactReferences = listArtifactReferences(state);
  if (artifactReferences.length === 0) {
    lines.push("- none recorded");
  } else {
    for (const artifact of artifactReferences) {
      lines.push(`- ${artifact.key}: ${artifact.path}`);
    }
  }

  lines.push("", "## Transition History");
  for (const entry of state.transitionHistory) {
    const from = entry.from ?? "start";
    lines.push(`- ${from} -> ${entry.to} (${entry.reason})`);
  }

  if (state.gateResults.length > 0) {
    lines.push("", "## Gate Results");
    for (const result of state.gateResults) {
      const status = result.passed ? "passed" : "failed";
      lines.push(`- ${result.name}: ${status}`);
    }
  }

  return lines.join("\n");
}

export function recordCompactionEvent(
  state,
  { boundary, reason, now = () => new Date().toISOString() } = {},
) {
  return {
    ...state,
    compactionEvents: [
      ...state.compactionEvents,
      {
        boundary,
        reason,
        at: now(),
      },
    ],
  };
}
