export interface GateResult {
  name: string;
  pass: boolean;
  output: string;
}
export interface PostHookResult {
  pass: boolean;
  decision?: ReviewDecision;
  errors?: string[];
}
export interface ReviewDecision {
  status: "LGTM" | "CRITICAL";
  issues?: string[];
}

export interface PipelineState {
  feature: string;
  workDir: string;
  phases: string[];
  maxIterations: number;
  startedAt: number;
  currentPhase?: string;
  currentPhaseIndex?: number;
  phaseStatus?: string;
  reviewIterations?: number;
  pipelineStatus?: string;
  phaseAttempts?: number;
  turnWriteCount?: number;
  promptText?: string;
  contextClearCount?: number;
  autoClearContext?: boolean;
  lastContextClearAt?: number;
  pendingSteerKey?: string;
  pendingSteerSentAt?: number;
  waitingReason?: string;
  yoloMode?: boolean;
  implementCheckpointApproved?: boolean;
  readyToAdvancePhase?: string;
}

export type PipelineDeliveryMode = "steer" | "followUp";
