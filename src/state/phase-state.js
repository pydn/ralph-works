import { phaseCatalog } from "../phases/phase-catalog.js";

export const RALPH_WORKS_NAME = "ralph-works";

export const RALPH_WORKS_PHASES = [
  ...phaseCatalog,
  {
    id: "complete",
    label: "Complete",
    skillDirectory: undefined,
    artifactKey: undefined,
    artifactPath: undefined,
  },
];

export const RALPH_WORKS_PHASE_IDS = RALPH_WORKS_PHASES.map((phase) => phase.id);

export function isRalphWorksPhase(value) {
  return RALPH_WORKS_PHASE_IDS.includes(value);
}

export function getPhaseDefinition(phaseId) {
  return RALPH_WORKS_PHASES.find((phase) => phase.id === phaseId);
}

export function getPhaseLabel(phaseId) {
  return getPhaseDefinition(phaseId)?.label ?? phaseId;
}

export function createPhaseState({ now = () => new Date().toISOString() } = {}) {
  return {
    extensionName: RALPH_WORKS_NAME,
    currentPhase: "generate_spec",
    phases: RALPH_WORKS_PHASES.map((phase) => ({ ...phase })),
    completedPhases: [],
    transitionHistory: [
      {
        from: undefined,
        to: "generate_spec",
        reason: "start",
        kind: "start",
        at: now(),
      },
    ],
    loopbackCount: 0,
    gateResults: [],
    artifacts: {},
    tddCompletedTasks: 0,
    compactionEvents: [],
  };
}
