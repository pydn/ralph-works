import { createPhaseState } from "../state/phase-state.js";

export const RALPH_WORKS_STATE_ENTRY_TYPE = "ralph-works-state";

export function restoreRalphWorksState(ctx) {
  const entries = ctx.sessionManager?.getEntries?.() ?? [];
  const restored = [...entries]
    .reverse()
    .find((entry) =>
      entry.type === "custom" &&
      entry.customType === RALPH_WORKS_STATE_ENTRY_TYPE
    );

  if (!restored?.data?.currentPhase) {
    return createPhaseState();
  }

  return {
    ...createPhaseState(),
    ...restored.data,
    phases: createPhaseState().phases,
  };
}

export function persistRalphWorksState(pi, state) {
  pi.appendEntry?.(RALPH_WORKS_STATE_ENTRY_TYPE, state);
}
