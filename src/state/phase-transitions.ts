import { isRalphWorksPhase } from "./phase-state.ts";
import type { NowProvider, PhaseId, WorkflowState } from "./phase-types.ts";

const LEGAL_TRANSITIONS = {
  generate_spec: ["red_team"],
  red_team: ["harden_spec"],
  harden_spec: ["render_html_optional", "create_tasks"],
  render_html_optional: ["create_tasks"],
  create_tasks: ["tdd_implement"],
  tdd_implement: ["review"],
  review: ["complete", "tdd_implement"],
  complete: [],
} satisfies Record<PhaseId, PhaseId[]>;

export function getLegalNextPhases(
  phaseId: PhaseId | string | undefined,
): PhaseId[] {
  if (!isRalphWorksPhase(phaseId)) {
    return [];
  }
  return [...LEGAL_TRANSITIONS[phaseId]];
}

export function canTransitionToPhase(
  fromPhase: PhaseId | string | undefined,
  toPhase: PhaseId | string,
): boolean {
  return (
    isRalphWorksPhase(toPhase) &&
    getLegalNextPhases(fromPhase).includes(toPhase)
  );
}

interface TransitionToPhaseOptions {
  reason?: string;
  now?: NowProvider;
}

export function transitionToPhase(
  state: WorkflowState,
  toPhase: PhaseId | string,
  {
    reason = "manual",
    now = () => new Date().toISOString(),
  }: TransitionToPhaseOptions = {},
): WorkflowState {
  if (!isRalphWorksPhase(toPhase)) {
    throw new Error(`Unknown RalphWorks phase: ${toPhase}`);
  }

  const fromPhase = state.currentPhase;
  if (!canTransitionToPhase(fromPhase, toPhase)) {
    throw new Error(
      `Illegal RalphWorks transition: ${fromPhase} -> ${toPhase}`,
    );
  }

  const kind =
    fromPhase === "review" && toPhase === "tdd_implement"
      ? "loopback"
      : "advance";
  const completedPhases = state.completedPhases.includes(fromPhase)
    ? [...state.completedPhases]
    : [...state.completedPhases, fromPhase];

  return {
    ...state,
    currentPhase: toPhase,
    completedPhases,
    transitionHistory: [
      ...state.transitionHistory,
      {
        from: fromPhase,
        to: toPhase,
        reason,
        kind,
        at: now(),
      },
    ],
    loopbackCount:
      kind === "loopback" ? state.loopbackCount + 1 : state.loopbackCount,
  };
}

interface AdvancePhaseOptions extends TransitionToPhaseOptions {
  renderHtml?: boolean;
}

export function advancePhase(
  state: WorkflowState,
  { renderHtml = false, reason = "advance", now }: AdvancePhaseOptions = {},
): WorkflowState {
  const nextPhase =
    state.currentPhase === "harden_spec" && renderHtml === false
      ? "create_tasks"
      : getLegalNextPhases(state.currentPhase)[0];

  if (!nextPhase) {
    throw new Error(`No next RalphWorks phase from ${state.currentPhase}`);
  }

  return transitionToPhase(state, nextPhase, { reason, now });
}
