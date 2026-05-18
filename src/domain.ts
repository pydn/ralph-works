/**
 * Normalized result shape for every quality gate run by the extension.
 * `output` is already sanitized before it is exposed to the agent or UI.
 */
export interface GateResult {
  name: string;
  pass: boolean;
  output: string;
}

/**
 * Phase post-hooks use this shape to keep orchestration independent from the
 * concrete validation performed by each phase.
 */
export interface PostHookResult {
  pass: boolean;
  decision?: ReviewDecision;
  errors?: string[];
}

export interface ReviewDecision {
  status: "LGTM" | "CRITICAL";
  issues?: string[];
}

/**
 * Persisted pipeline state.
 *
 * Every field needed after session reload, context compaction, or process
 * restart belongs here. Extension code should update this object by copying it
 * and appending a fresh custom entry, not by mutating a loaded reference.
 */
export interface PipelineState {
  feature: string;
  workDir: string;
  phases: string[];
  maxIterations: number;
  startedAt: number;
  currentPhase?: string;
  currentPhaseIndex?: number;
  /** Lifecycle status for the active phase: pre_hook, executing, post_hook, waiting_for_user, etc. */
  phaseStatus?: string;
  reviewIterations?: number;
  /** Overall run status: running, completed, paused, failed, halted, or cancelled. */
  pipelineStatus?: string;
  phaseAttempts?: number;
  /** Consecutive write/edit count used by the auto-gate trigger. */
  turnWriteCount?: number;
  /** Optional expanded user prompt, including prompt-file contents when provided. */
  promptText?: string;
  /** Number of successful context compactions during this run. */
  contextClearCount?: number;
  autoClearContext?: boolean;
  lastContextClearAt?: number;
  /** Deduplication marker for queued steer/follow-up messages. */
  pendingSteerKey?: string;
  pendingSteerSentAt?: number;
  waitingReason?: string;
  yoloMode?: boolean;
  /** Set after the operator approves moving from planning into implementation. */
  implementCheckpointApproved?: boolean;
  /** Set by passing gates so agent_end can advance implement deterministically. */
  readyToAdvancePhase?: string;
}

export type PipelineDeliveryMode = "steer" | "followUp";
