import { getPhaseLabel, RALPH_WORKS_NAME } from "../state/phase-state.ts";
import type { WorkflowState } from "../state/phase-types.ts";
import { renderWorkflowProgress } from "../tui/workflow-progress-view.ts";
import type { RalphWorksContext } from "./pi-harness-types.ts";

export function updateRalphWorksTui(
  ctx: RalphWorksContext,
  state: WorkflowState,
  activeModel: string | undefined,
): void {
  if (!ctx.hasUI || !ctx.ui) {
    return;
  }

  const phaseLabel = getPhaseLabel(state.currentPhase);
  ctx.ui.setStatus?.(RALPH_WORKS_NAME, `${RALPH_WORKS_NAME}: ${phaseLabel}`);
  ctx.ui.setWidget?.(
    RALPH_WORKS_NAME,
    renderWorkflowProgress(state, { activeModel, color: true }),
  );
}
