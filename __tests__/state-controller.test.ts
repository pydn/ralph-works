import { describe, expect, it } from "vitest";
import type { PipelineState } from "../src/domain";
import {
  enterImplementCheckpoint,
  enterPhaseExecution,
  enterPhasePreHook,
  enterValidationFailed,
  markPhaseValidated,
} from "../src/stateController";

function baseState(overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    feature: "feature-a",
    workDir: "/repo",
    phases: ["spec", "implement", "review"],
    maxIterations: 10,
    startedAt: 1,
    currentPhase: "implement",
    currentPhaseIndex: 1,
    phaseStatus: "pre_hook",
    pipelineStatus: "running",
    reviewIterations: 0,
    phaseAttempts: 2,
    turnWriteCount: 3,
    waitingReason: "old-wait",
    readyToAdvancePhase: "implement",
    lastValidationFailure: "old failure",
    ...overrides,
  };
}

describe("state controller transitions", () => {
  it("enters phase execution with transient controller fields reset", () => {
    const original = baseState();
    const updated = enterPhaseExecution(original);

    expect(updated).toMatchObject({
      phaseStatus: "executing",
      phaseAttempts: 0,
      turnWriteCount: 0,
      waitingReason: undefined,
      readyToAdvancePhase: undefined,
    });
    expect(original.phaseStatus).toBe("pre_hook");
    expect(original.phaseAttempts).toBe(2);
  });

  it("moves to a running phase pre-hook without carrying stale validation state", () => {
    const updated = enterPhasePreHook(baseState({ pipelineStatus: "paused" }), {
      phase: "review",
      phaseIndex: 2,
    });

    expect(updated).toMatchObject({
      currentPhase: "review",
      currentPhaseIndex: 2,
      phaseStatus: "pre_hook",
      pipelineStatus: "running",
      phaseAttempts: 0,
      turnWriteCount: 0,
      waitingReason: undefined,
      readyToAdvancePhase: undefined,
    });
  });

  it("enters the implement checkpoint waiting state from a pre-hook transition", () => {
    const updated = enterImplementCheckpoint(baseState({ currentPhase: "implement", currentPhaseIndex: 1 }));

    expect(updated).toMatchObject({
      phaseStatus: "waiting_for_user",
      waitingReason: "implement_checkpoint",
      turnWriteCount: 0,
      readyToAdvancePhase: undefined,
    });
  });

  it("records validation failure as an explicit nonterminal phase state", () => {
    const updated = enterValidationFailed(baseState({ phaseAttempts: 1 }), "gate failed");

    expect(updated).toMatchObject({
      phaseStatus: "validation_failed",
      phaseAttempts: 2,
      turnWriteCount: 0,
      readyToAdvancePhase: undefined,
      lastValidationFailure: "gate failed",
    });
  });

  it("marks a phase validated before advancement and clears stale failure details", () => {
    const updated = markPhaseValidated(baseState());

    expect(updated).toMatchObject({
      pipelineStatus: "running",
      phaseStatus: "post_hook",
      turnWriteCount: 0,
      waitingReason: undefined,
      readyToAdvancePhase: undefined,
      lastValidationFailure: undefined,
    });
  });
});
