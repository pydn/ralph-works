import { buildArtifactPath } from "../artifacts/artifact-paths.ts";
import { phaseCatalog } from "../phases/phase-catalog.ts";
import type {
  NowProvider,
  PhaseDefinition,
  PhaseId,
  WorkflowState,
} from "./phase-types.ts";

export type {
  ArtifactKey,
  GateResult,
  HandoffStatus,
  ImplementationStatus,
  NowProvider,
  PhaseDefinition,
  PhaseId,
  PhaseStatus,
  PipelineStatus,
  RalphWorksPhaseDefinition,
  RalphWorksPhaseId,
  SessionHandoffDescriptor,
  SessionHandoffEvent,
  TransitionKind,
  TransitionRecord,
  WorkflowState,
} from "./phase-types.ts";

export const RALPH_WORKS_NAME = "ralph-works";

const completePhase = {
  id: "complete",
  label: "Complete",
  skillDirectory: undefined,
  artifactKey: undefined,
  artifactPath: undefined,
} satisfies PhaseDefinition;

export const RALPH_WORKS_PHASES: PhaseDefinition[] = [
  ...phaseCatalog,
  completePhase,
];

export const RALPH_WORKS_PHASE_IDS: PhaseId[] = RALPH_WORKS_PHASES.map(
  (phase) => phase.id,
);

const RALPH_WORKS_PHASE_ID_SET = new Set<string>(RALPH_WORKS_PHASE_IDS);

export function isRalphWorksPhase(value: unknown): value is PhaseId {
  return typeof value === "string" && RALPH_WORKS_PHASE_ID_SET.has(value);
}

export function getPhaseDefinition(
  phaseId: PhaseId | string | undefined,
): PhaseDefinition | undefined {
  return RALPH_WORKS_PHASES.find((phase) => phase.id === phaseId);
}

export function getPhaseLabel(
  phaseId: PhaseId | string | undefined,
): string | undefined {
  return getPhaseDefinition(phaseId)?.label ?? phaseId;
}

function buildPhaseList(feature: string | undefined): PhaseDefinition[] {
  return RALPH_WORKS_PHASES.map((phase) => ({
    ...phase,
    artifactPath: phase.artifactPath
      ? buildArtifactPath(feature, phase.artifactPath)
      : undefined,
  }));
}

interface CreatePhaseStateOptions {
  feature?: string;
  promptText?: string;
  now?: NowProvider;
}

export function createPhaseState({
  feature,
  promptText,
  now = () => new Date().toISOString(),
}: CreatePhaseStateOptions = {}): WorkflowState {
  return {
    extensionName: RALPH_WORKS_NAME,
    feature,
    promptText,
    pipelineStatus: "running",
    phaseStatus: "executing",
    currentPhase: "generate_spec",
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
    phases: buildPhaseList(feature),
    loopbackCount: 0,
    gateResults: [],
    artifacts: {},
    tddCompletedTasks: 0,
    sessionHandoffEvents: [],
  };
}
