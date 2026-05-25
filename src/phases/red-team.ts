import type { RalphWorksPhaseDefinition } from "../state/phase-types.ts";

export const redTeamPhase = {
  id: "red_team",
  label: "Red Team Pass",
  skillDirectory: "red-team-pass",
  artifactKey: "redTeamFindings",
  artifactPath: "red-team-findings.md",
} satisfies RalphWorksPhaseDefinition;
