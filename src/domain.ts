/**
 * Normalized result shape for every quality gate run by the extension.
 * `output` is already sanitized before it is exposed to the agent or UI.
 */
export interface GateResult {
  name: string;
  pass: boolean;
  output: string;
  command?: string;
  source?: string;
  skipped?: boolean;
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

export type ModelThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type RalphModelSelectorSource = "cli" | "workspace-config" | "user-config" | "current";

export interface RalphModelSelector {
  provider: string;
  model: string;
  displayName?: string;
  thinkingLevel?: ModelThinkingLevel;
  source: RalphModelSelectorSource;
  explicit?: boolean;
}

export interface RalphModelPlan {
  default?: RalphModelSelector;
  phases?: Partial<Record<string, RalphModelSelector>>;
  restoreOriginalOnComplete?: boolean;
  strict?: boolean;
  trustApproved?: boolean;
  trustSource?: "cli-flag" | "provider-allowlist" | "user-config";
  allowWeakModel?: boolean;
}

export interface ModelSwitchEvent {
  event: "apply" | "reapply" | "mismatch" | "restore" | "skipped-restore" | "failure" | "plan-update";
  phaseKey?: string;
  provider?: string;
  model?: string;
  thinkingLevel?: ModelThinkingLevel;
  source?: RalphModelSelectorSource;
  result: "success" | "failure" | "skipped" | "blocked";
  reason?: string;
  nonce?: string;
  occurredAt: number;
}

export interface LastAppliedModel {
  phaseKey: string;
  provider: string;
  model: string;
  thinkingLevel?: ModelThinkingLevel;
  appliedAt: number;
  nonce: string;
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
  /** Original phaseStatus captured when `/ralph-works pause` records pipelineStatus: paused. */
  pausedFromPhaseStatus?: string;
  yoloMode?: boolean;
  /** Set after the operator approves moving from planning into implementation. */
  implementCheckpointApproved?: boolean;
  /** Set by passing gates so agent_end can advance implement deterministically. */
  readyToAdvancePhase?: string;
  /** Latest full validation failure details for /ralph-works status and persisted history. */
  lastValidationFailure?: string;
  modelPlan?: RalphModelPlan;
  originalModel?: RalphModelSelector;
  lastAppliedModel?: LastAppliedModel;
  modelSwitchHistory?: ModelSwitchEvent[];
  phaseModelNonce?: string;
}

export type PipelineDeliveryMode = "steer" | "followUp";
