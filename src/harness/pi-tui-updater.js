import { getPhaseLabel, RALPH_WORKS_NAME } from "../state/phase-state.js";
import { renderWorkflowProgress } from "../tui/workflow-progress-view.js";

export function updateRalphWorksTui(ctx, state, activeModel) {
  if (!ctx.hasUI || !ctx.ui) {
    return;
  }

  const phaseLabel = getPhaseLabel(state.currentPhase);
  ctx.ui.setStatus(RALPH_WORKS_NAME, `${RALPH_WORKS_NAME}: ${phaseLabel}`);
  ctx.ui.setWidget(
    RALPH_WORKS_NAME,
    renderWorkflowProgress(state, { activeModel, color: true }),
  );
}
