export type RalphWorksPhaseId =
  | "generate_spec"
  | "red_team"
  | "harden_spec"
  | "render_html_optional"
  | "create_tasks"
  | "tdd_implement"
  | "review";

export type CompletePhaseId = "complete";
export type PhaseId = RalphWorksPhaseId | CompletePhaseId;

export type ArtifactKey =
  | "generatedSpec"
  | "redTeamFindings"
  | "hardenedSpec"
  | "hardenedSpecHtml"
  | "taskList"
  | "implementationStatus"
  | "reviewFindings";

export interface PhaseDefinition {
  id: PhaseId;
  label: string;
  skillDirectory?: string;
  artifactKey?: ArtifactKey;
  artifactPath?: string;
}

export interface RalphWorksPhaseDefinition extends PhaseDefinition {
  id: RalphWorksPhaseId;
  skillDirectory: string;
  artifactKey: ArtifactKey;
  artifactPath: string;
}

export type TransitionKind = "start" | "advance" | "loopback";

export interface TransitionRecord {
  from?: PhaseId;
  to: PhaseId;
  reason: string;
  kind: TransitionKind;
  at: string;
}

export type PipelineStatus = "running" | "blocked" | "completed";

export type PhaseStatus =
  | "executing"
  | "awaiting_harden_approval"
  | "handoff_pending"
  | "handoff_failed"
  | "post_hook";

export type HandoffStatus =
  | "pending"
  | "in_progress"
  | "ready_in_new_session"
  | "completed"
  | "failed";

export interface SessionHandoffDescriptor {
  id: string;
  boundary: string;
  reason: string;
  sourcePhase: string;
  targetPhase: string;
  taskId?: string;
  status: HandoffStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  readyAt?: string;
  failedAt?: string;
  completedAt?: string;
  replacementSessionFile?: string;
  errorMessage?: string;
}

export interface SessionHandoffEvent {
  id: string;
  boundary: string;
  reason: string;
  sourcePhase: string;
  targetPhase: string;
  taskId?: string;
  status: HandoffStatus;
  createdAt: string;
  completedAt?: string;
  replacementSessionFile?: string;
}

export interface GateResult {
  name?: string;
  passed?: boolean;
  required?: boolean;
  command?: string;
  code?: number | null;
  stdout?: string;
  stderr?: string;
  error?: string;
  [key: string]: unknown;
}

export interface WorkflowState {
  extensionName: string;
  feature?: string;
  promptText?: string;
  pipelineStatus: PipelineStatus;
  phaseStatus: PhaseStatus;
  currentPhase: PhaseId;
  completedPhases: PhaseId[];
  transitionHistory: TransitionRecord[];
  phases: PhaseDefinition[];
  loopbackCount: number;
  gateResults: GateResult[];
  artifacts: Record<string, string>;
  tddCompletedTasks: number;
  implementationStatus?: ImplementationStatus;
  sessionHandoffEvents: SessionHandoffEvent[];
  pendingHandoff?: SessionHandoffDescriptor;
}

export interface ImplementationStatus {
  claimedTaskIds: string[];
  completedTaskIds: string[];
  gateResultsByTask: Record<string, GateResult[]>;
  taskSummaries?: Record<string, unknown>;
}

export type NowProvider = () => string;
