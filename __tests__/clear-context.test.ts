import { describe, it, expect } from "vitest";
import { canClearContext, buildReorientationPrompt, resolveArtifactPaths, MAX_STEER_SIZE } from "../src/steer";

// ── Phase 0: canClearContext() pure function ────────────────

describe("canClearContext", () => {
  const validState = {
    feature: "test-feature",
    workDir: "/tmp/project",
    phases: ["spec", "redteam", "harden", "implement", "review"],
    maxIterations: 3,
    startedAt: Date.now(),
    currentPhase: "implement",
    currentPhaseIndex: 3,
    pipelineStatus: "running" as const,
    phaseStatus: "executing" as const,
  };

  it("1. returns ok:true for valid running pipeline with all required fields", () => {
    const result = canClearContext(validState);
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("2. rejects when state is null", () => {
    const result = canClearContext(null);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("No active pipeline");
  });

  it("3. rejects when state missing feature field", () => {
    const missingFeature = { ...validState, feature: undefined };
    const result = canClearContext(missingFeature);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("feature");
  });

  it("4. rejects when state missing currentPhaseIndex field", () => {
    const missingIdx = { ...validState, currentPhaseIndex: undefined };
    const result = canClearContext(missingIdx);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("currentPhaseIndex");
  });

  it("5. rejects when pipelineStatus is completed", () => {
    const completed = { ...validState, pipelineStatus: "completed" as const };
    const result = canClearContext(completed);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("completed");
  });

  it("6. rejects when pipelineStatus is cancelled", () => {
    const cancelled = { ...validState, pipelineStatus: "cancelled" as const };
    const result = canClearContext(cancelled);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("cancelled");
  });

  it("7. rejects when pipelineStatus is failed", () => {
    const failed = { ...validState, pipelineStatus: "failed" as const };
    const result = canClearContext(failed);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("failed");
  });

  it("7b. rejects when pipelineStatus is halted", () => {
    const halted = { ...validState, pipelineStatus: "halted" as const };
    const result = canClearContext(halted);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("halted");
  });

  it("8. rejects when phaseStatus is pre_hook", () => {
    const preHook = { ...validState, phaseStatus: "pre_hook" as const };
    const result = canClearContext(preHook);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("pre_hook");
  });

  it("9. rejects when lastContextClearAt < 30 seconds ago (rate-limit cooldown)", () => {
    const recentlyCleared = { ...validState, lastContextClearAt: Date.now() - 10_000 };
    const result = canClearContext(recentlyCleared);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("cooldown");
  });

  it("10. allows clear after 30-second cooldown expires", () => {
    const oldClear = { ...validState, lastContextClearAt: Date.now() - 60_000 };
    const result = canClearContext(oldClear);
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });
});

// ── Phase 2: buildReorientationPrompt() & resolveArtifactPaths() ────────────────

describe("resolveArtifactPaths", () => {
  const validState = {
    feature: "test-feature",
    workDir: "/tmp/project",
  };

  it("20. computes candidate paths from feature name and workDir", () => {
    // Without existing files, returns empty array (all paths fail existsSync)
    const paths = resolveArtifactPaths(validState);
    expect(Array.isArray(paths)).toBe(true);
    // Each path should be a string starting with docs/
    for (const p of paths) {
      expect(p.startsWith("docs/")).toBe(true);
    }
  });
});

describe("buildReorientationPrompt", () => {
  const validState = {
    feature: "clear-context",
    workDir: "/tmp/project",
    phases: ["spec", "redteam", "harden", "implement", "review"],
    maxIterations: 3,
    startedAt: Date.now(),
    currentPhase: "implement",
    currentPhaseIndex: 3,
    pipelineStatus: "running" as const,
  };

  it("21. includes tier 1 header with phase info", () => {
    const prompt = buildReorientationPrompt(validState);
    expect(prompt).toContain("CONTEXT RESET");
    expect(prompt).toContain(validState.currentPhase);
    expect(prompt).toContain(validState.feature);
  });

  it("22. respects MAX_STEER_SIZE budget limit", () => {
    const prompt = buildReorientationPrompt(validState);
    // Prompt should not exceed MAX_STEER_SIZE + tolerance
    expect(prompt.length).toBeLessThanOrEqual(MAX_STEER_SIZE + 500);
  });

  it("23. includes tier 1 and tier 2 content within budget", () => {
    const prompt = buildReorientationPrompt(validState);
    // Tier 1 always included
    expect(prompt).toContain("CONTEXT RESET");
    // Tier 2 metadata (completed/remaining phases)
    expect(prompt).toContain("Completed phases");
    expect(prompt).toContain("Remaining phases");
  });
});
