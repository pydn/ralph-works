import { describe, it, expect } from "vitest";
import { wrapSteerMessage, MAX_STEER_SIZE, validatePhaseIndex } from "../src/steer";

describe("wrapSteerMessage", () => {
  const SMALL_TEXT = `⛔ SESSION RELOAD — Resuming Phase 2: Red Team Audit.

You were interrupted mid-phase. The phase-specific instructions are below — follow them completely before the extension advances you to the next phase.

---

# ralph-works Pipeline — Phase: Red Team Audit

Some skill content here.`;

  const OVERSIZED_TEXT =
    `⛔ SESSION RELOAD — Resuming Phase 2: TDD Implement.\n\n` +
    "You were interrupted mid-phase.\n\n---\n\n" +
    "A".repeat(MAX_STEER_SIZE * 2); // Deliberately > MAX_STEER_SIZE

  // ── Test #1: Under budget → returned unchanged ──────────────
  it("returns text unchanged when input length < maxSize", () => {
    const result = wrapSteerMessage(SMALL_TEXT, MAX_STEER_SIZE);
    expect(result).toBe(SMALL_TEXT);
  });

  // ── Test #2: Over budget → truncated with re-read instruction ────
  it("truncates to summary header + re-read instruction when input length > maxSize", () => {
    const result = wrapSteerMessage(OVERSIZED_TEXT, MAX_STEER_SIZE);
    expect(result.length).toBeLessThanOrEqual(MAX_STEER_SIZE + 500); // budget + small overhead for summary
    expect(result).toContain("SESSION RELOAD");
    expect(result).toContain("re-read");
    expect(result).not.toContain("A".repeat(100)); // bulk content should be stripped
  });

  // ── Test #3: Empty string → returned unchanged ────────
  it("returns empty string for empty input", () => {
    const result = wrapSteerMessage("", MAX_STEER_SIZE);
    expect(result).toBe("");
  });

  // ── Test #4: Truncated output is shorter than original ──
  it("truncated output is strictly shorter than original oversized input", () => {
    const result = wrapSteerMessage(OVERSIZED_TEXT, MAX_STEER_SIZE);
    expect(result.length).toBeLessThan(OVERSIZED_TEXT.length);
  });

  // ── Test #5: Exactly at boundary → returned unchanged (edge case) ────
  it("returns text unchanged when input length equals maxSize exactly", () => {
    const exactSize = "X".repeat(MAX_STEER_SIZE);
    const result = wrapSteerMessage(exactSize, MAX_STEER_SIZE);
    expect(result).toBe(exactSize);
  });
});

const PHASES = ["spec", "redteam", "harden", "implement", "review"];

describe("validatePhaseIndex", () => {
  it("returns true for valid index 0", () => {
    expect(validatePhaseIndex(0, PHASES)).toBe(true);
  });

  it("returns true for last valid index (phases.length - 1)", () => {
    expect(validatePhaseIndex(PHASES.length - 1, PHASES)).toBe(true);
  });

  it("returns false for negative index", () => {
    expect(validatePhaseIndex(-1, PHASES)).toBe(false);
  });

  it("returns false for index equal to phases.length", () => {
    expect(validatePhaseIndex(PHASES.length, PHASES)).toBe(false);
  });

  it("returns false for index beyond phases.length", () => {
    expect(validatePhaseIndex(PHASES.length + 5, PHASES)).toBe(false);
  });

  it("returns false for empty phase array (any non-negative index)", () => {
    expect(validatePhaseIndex(0, [])).toBe(false);
  });
});
