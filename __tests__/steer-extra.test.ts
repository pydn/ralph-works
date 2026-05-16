import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildReorientationPrompt,
  canClearContext,
  MAX_STEER_SIZE,
  resolveArtifactPaths,
  validatePhaseIndex,
  wrapSteerMessage,
} from "../src/steer";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("wrapSteerMessage additional edge cases", () => {
  it("truncates oversized text without a separator to the size budget", () => {
    const result = wrapSteerMessage("A".repeat(MAX_STEER_SIZE * 2), MAX_STEER_SIZE);
    expect(result.length).toBeLessThanOrEqual(MAX_STEER_SIZE + 500);
    expect(result).toContain("Truncated");
    expect(result).toContain("re-read");
  });
});

describe("validatePhaseIndex additional edge cases", () => {
  it("rejects fractional and NaN indexes", () => {
    expect(validatePhaseIndex(0.5, ["spec"])).toBe(false);
    expect(validatePhaseIndex(Number.NaN, ["spec"])).toBe(false);
  });
});

describe("canClearContext permissive defaults", () => {
  it("allows legacy running state when optional status fields are absent", () => {
    const result = canClearContext({ feature: "legacy", currentPhaseIndex: 0 });
    expect(result.ok).toBe(true);
  });
});

describe("resolveArtifactPaths", () => {
  it("returns only existing artifacts from sanitized feature naming conventions", () => {
    const workDir = makeTempDir("ralph-artifacts-");
    fs.mkdirSync(path.join(workDir, "docs", "specs"), { recursive: true });
    fs.mkdirSync(path.join(workDir, "docs", "security"), { recursive: true });
    fs.writeFileSync(path.join(workDir, "docs", "specs", "feature-name.md"), "# Spec", "utf-8");
    fs.writeFileSync(path.join(workDir, "docs", "specs", "feature-name-final.html"), "<html></html>", "utf-8");
    fs.writeFileSync(path.join(workDir, "docs", "security", "redteam-findings-feature-name.md"), "# Audit", "utf-8");

    expect(resolveArtifactPaths({ feature: "feature/name", workDir })).toEqual([
      "docs/specs/feature-name.md",
      "docs/specs/feature-name-final.html",
      "docs/security/redteam-findings-feature-name.md",
    ]);
  });
});

describe("buildReorientationPrompt defaults", () => {
  it("uses safe defaults when phase metadata is sparse", () => {
    const prompt = buildReorientationPrompt({ feature: "sparse-state" });
    expect(prompt).toContain("Phase 1");
    expect(prompt).toContain("unknown");
    expect(prompt).toContain("sparse-state");
  });
});
