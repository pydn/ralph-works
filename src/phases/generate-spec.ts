import type { RalphWorksPhaseDefinition } from "../state/phase-types.ts";

export const generateSpecPhase = {
  id: "generate_spec",
  label: "Generate Spec",
  skillDirectory: "generate-spec",
  artifactKey: "generatedSpec",
  artifactPath: "generated-spec.md",
} satisfies RalphWorksPhaseDefinition;
