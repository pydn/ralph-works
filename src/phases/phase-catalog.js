import { createTasksPhase } from "./create-tasks.js";
import { generateSpecPhase } from "./generate-spec.js";
import { hardenSpecPhase } from "./harden-spec.js";
import { redTeamPhase } from "./red-team.js";
import { renderHtmlPhase } from "./render-html.js";
import { reviewPhase } from "./review.js";
import { tddImplementPhase } from "./tdd-implement.js";

export const phaseCatalog = [
  generateSpecPhase,
  redTeamPhase,
  hardenSpecPhase,
  renderHtmlPhase,
  createTasksPhase,
  tddImplementPhase,
  reviewPhase,
];
