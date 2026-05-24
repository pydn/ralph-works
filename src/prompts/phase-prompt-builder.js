import { readFileSync } from "node:fs";
import path from "node:path";

import { PHASE_COMPLETE_MARKER } from "../state/phase-completion.js";
import { getPhaseLabel } from "../state/phase-state.js";

function readSkill(extensionRoot, phase) {
  if (!phase.skillDirectory) {
    return "(No skill is associated with this phase.)";
  }

  try {
    return readFileSync(
      path.join(extensionRoot, "skills", phase.skillDirectory, "SKILL.md"),
      "utf8",
    ).trim();
  } catch {
    return `(Skill file not found: skills/${phase.skillDirectory}/SKILL.md)`;
  }
}

function phaseIndex(state) {
  const index = state.phases.findIndex(
    (phase) => phase.id === state.currentPhase,
  );
  return index === -1 ? 0 : index;
}

function artifactLines(state, phase) {
  const index = phaseIndex(state);
  const priorArtifacts = state.phases
    .slice(0, index)
    .filter((candidate) => candidate.artifactPath)
    .map(
      (candidate) => `- Prior ${candidate.label}: ${candidate.artifactPath}`,
    );
  const outputArtifact = phase.artifactPath
    ? [`- Current output: ${phase.artifactPath}`]
    : [];
  const recordedArtifacts = Object.entries(state.artifacts ?? {})
    .map(([key, value]) => `- Recorded ${key}: ${value}`);

  return [...priorArtifacts, ...outputArtifact, ...recordedArtifacts];
}

function phaseRules(phaseId) {
  if (phaseId === "review") {
    return [
      "- If the implementation is LGTM, end with a clear LGTM statement.",
      "- If critical issues remain, include `[CRITICAL]` findings or end with `RALPH_REVIEW_CHANGES_REQUESTED` so RalphWorks loops back to TDD.",
    ];
  }

  return [
    `- When this phase is complete, end the final assistant message with exactly \`${PHASE_COMPLETE_MARKER}\` on its own line.`,
  ];
}

export function buildPhasePrompt(state, { extensionRoot }) {
  const phase = state.phases.find(
    (candidate) => candidate.id === state.currentPhase,
  );
  if (!phase) {
    throw new Error(
      `Cannot build prompt for unknown phase: ${state.currentPhase}`,
    );
  }

  const artifacts = artifactLines(state, phase);
  return [
    `# ralph-works Phase: ${getPhaseLabel(phase.id)}`,
    "",
    `Feature: ${state.feature ?? "unspecified"}`,
    state.promptText ? `Prompt: ${state.promptText}` : "Prompt: not provided",
    "",
    "## Artifacts",
    artifacts.length
      ? artifacts.join("\n")
      : "- No phase artifacts are configured.",
    "",
    "## Skill Context",
    "<ralph-skill-instructions>",
    readSkill(extensionRoot, phase),
    "</ralph-skill-instructions>",
    "",
    "## Controller Rules",
    phaseRules(phase.id).join("\n"),
  ].join("\n");
}
