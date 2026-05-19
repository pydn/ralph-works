import {
  IMPLEMENT_CHECKPOINT_WAIT_REASON,
  VALIDATION_FAILED_PHASE_STATUS,
  WAITING_FOR_USER_PHASE_STATUS,
} from "./config";
import type { PipelineState } from "./domain";

export interface PhaseTarget {
  phase: string;
  phaseIndex: number;
}

/** Prepare a phase for agent execution after pre-hook validation passes. */
export function enterPhaseExecution(state: PipelineState): PipelineState {
  return {
    ...state,
    phaseStatus: "executing",
    phaseAttempts: 0,
    turnWriteCount: 0,
    waitingReason: undefined,
    readyToAdvancePhase: undefined,
  };
}

/** Move the pipeline to a phase pre-hook boundary while clearing transient phase state. */
export function enterPhasePreHook(state: PipelineState, target: PhaseTarget): PipelineState {
  return {
    ...state,
    currentPhaseIndex: target.phaseIndex,
    currentPhase: target.phase,
    phaseStatus: "pre_hook",
    pipelineStatus: "running",
    phaseAttempts: 0,
    turnWriteCount: 0,
    waitingReason: undefined,
    readyToAdvancePhase: undefined,
  };
}

/** Pause at the conservative implementation review checkpoint. */
export function enterImplementCheckpoint(state: PipelineState): PipelineState {
  return {
    ...state,
    phaseStatus: WAITING_FOR_USER_PHASE_STATUS,
    waitingReason: IMPLEMENT_CHECKPOINT_WAIT_REASON,
    turnWriteCount: 0,
    readyToAdvancePhase: undefined,
  };
}

/** Persist a nonterminal post-hook failure without making the phase look like normal execution. */
export function enterValidationFailed(state: PipelineState, failureDetails: string): PipelineState {
  return {
    ...state,
    phaseStatus: VALIDATION_FAILED_PHASE_STATUS,
    phaseAttempts: (state.phaseAttempts ?? 0) + 1,
    turnWriteCount: 0,
    readyToAdvancePhase: undefined,
    lastValidationFailure: failureDetails,
  };
}

/** Mark phase validation as passed before advancing to the next phase boundary. */
export function markPhaseValidated(state: PipelineState): PipelineState {
  return {
    ...state,
    pipelineStatus: "running",
    phaseStatus: "post_hook",
    turnWriteCount: 0,
    waitingReason: undefined,
    readyToAdvancePhase: undefined,
    lastValidationFailure: undefined,
  };
}
