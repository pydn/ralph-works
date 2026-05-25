import type { RalphWorksPhaseDefinition } from "../state/phase-types.ts";
import { createTasksPhase } from "./create-tasks.ts";
import { generateSpecPhase } from "./generate-spec.ts";
import { hardenSpecPhase } from "./harden-spec.ts";
import { redTeamPhase } from "./red-team.ts";
import { renderHtmlPhase } from "./render-html.ts";
import { reviewPhase } from "./review.ts";
import { tddImplementPhase } from "./tdd-implement.ts";

export const phaseCatalog: RalphWorksPhaseDefinition[] = [
  generateSpecPhase,
  redTeamPhase,
  hardenSpecPhase,
  renderHtmlPhase,
  createTasksPhase,
  tddImplementPhase,
  reviewPhase,
];
