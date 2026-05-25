import type { RalphWorksPhaseDefinition } from "../state/phase-types.ts";

export const reviewPhase = {
  id: "review",
  label: "Review",
  skillDirectory: "review",
  artifactKey: "reviewFindings",
  artifactPath: "review-findings.md",
} satisfies RalphWorksPhaseDefinition;
