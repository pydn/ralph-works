import { readFileSync } from "node:fs";
import path from "node:path";

import {
  PHASE_COMPLETE_MARKER,
  TDD_TASK_COMPLETE_MARKER,
} from "../state/phase-completion.js";
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
  const recordedArtifacts = Object.entries(state.artifacts ?? {}).map(
    ([key, value]) => `- Recorded ${key}: ${value}`,
  );

  return [...priorArtifacts, ...outputArtifact, ...recordedArtifacts];
}

function phaseRules(phaseId) {
  if (phaseId === "review") {
    return [
      "- If the implementation is LGTM, end with exactly `LGTM`.",
      "- If critical issues remain, include `[CRITICAL]` findings or end with `RALPH_REVIEW_CHANGES_REQUESTED` so RalphWorks loops back to TDD.",
    ];
  }

  if (phaseId === "tdd_implement") {
    return [
      "- Inspect the task list and implementation status artifacts to choose the next incomplete task; RalphWorks does not parse the task list for you.",
      `- When one implementation task is complete and required gates pass, end the final assistant message with exactly \`${TDD_TASK_COMPLETE_MARKER} <task-id>\` on its own line.`,
      `- When all implementation tasks are complete and the phase is ready for review, end the final assistant message with exactly \`${PHASE_COMPLETE_MARKER}\` on its own line.`,
    ];
  }

  return [
    `- When this phase is complete, end the final assistant message with exactly \`${PHASE_COMPLETE_MARKER}\` on its own line.`,
  ];
}

function latestReviewLoopbackTransition(state) {
  const transition = state.transitionHistory.at(-1);
  if (
    state.currentPhase === "tdd_implement" &&
    transition?.from === "review" &&
    transition.to === "tdd_implement" &&
    transition.kind === "loopback"
  ) {
    return transition;
  }

  return undefined;
}

function reviewLoopbackContextLines(state) {
  const transition = latestReviewLoopbackTransition(state);
  if (!transition) {
    return [];
  }

  return [
    "## Review Loopback Context",
    "- Review requested changes; return to TDD implementation.",
    `- Loopback count: ${state.loopbackCount ?? 0}`,
    `- Review loopback reason: ${transition.reason}`,
    "- Address the review findings before returning to review.",
    "",
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
    ...reviewLoopbackContextLines(state),
    "## Skill Context",
    "<ralph-skill-instructions>",
    readSkill(extensionRoot, phase),
    "</ralph-skill-instructions>",
    "",
    "## Controller Rules",
    phaseRules(phase.id).join("\n"),
  ].join("\n");
}
