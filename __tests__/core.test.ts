import { describe, it, expect } from "vitest";
import { validatePhaseOrder, sanitizeErrorOutput, PHASE_META, PHASE_ORDER, DEFAULT_PHASES, sanitizeFeatureName } from "../src/stateMachine";

describe("PHASE_ORDER", () => {
  it("contains all 6 phases in correct order (including render)", () => {
    expect(PHASE_ORDER).toEqual(["spec", "redteam", "harden", "render", "implement", "review"]);
  });

  it("has render at index 3 (between harden and implement)", () => {
    expect(PHASE_ORDER[3]).toBe("render");
  });
});

describe("PHASE_META", () => {
  it("has entries for all phases", () => {
    for (const phase of PHASE_ORDER) {
      expect(PHASE_META[phase]).toBeDefined();
      expect(PHASE_META[phase]?.name).toBeTruthy();
      expect(PHASE_META[phase]?.desc).toBeTruthy();
    }
  });
});

describe("validatePhaseOrder", () => {
  it("returns valid for canonical full pipeline order", () => {
    const result = validatePhaseOrder(["spec", "redteam", "harden", "implement", "review"]);
    expect(result.valid).toBe(true);
  });

  it("returns valid for single phase", () => {
    const result = validatePhaseOrder(["spec"]);
    expect(result.valid).toBe(true);
  });

  it("returns valid for subset of phases in correct order", () => {
    const result = validatePhaseOrder(["spec", "implement"]);
    expect(result.valid).toBe(true);
  });

  it("rejects unknown phase names", () => {
    const result = validatePhaseOrder(["unknown_phase"]);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Unknown phase");
  });

  it("rejects reverse order (review before spec)", () => {
    const result = validatePhaseOrder(["review", "spec"]);
    expect(result.valid).toBe(false);
  });

  it("rejects review without implement", () => {
    const result = validatePhaseOrder(["spec", "review"]);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("implement");
  });

  it("rejects redteam without spec", () => {
    const result = validatePhaseOrder(["redteam", "harden"]);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("spec");
  });

  it("rejects harden without spec", () => {
    const result = validatePhaseOrder(["implement", "harden"]);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("spec");
  });

  it("returns valid for full 6-phase order including render", () => {
    const result = validatePhaseOrder(["spec", "redteam", "harden", "render", "implement", "review"]);
    expect(result.valid).toBe(true);
  });

  it("rejects render without harden", () => {
    const result = validatePhaseOrder(["render", "implement"]);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("harden");
  });

  it("rejects render without harden even with spec present", () => {
    const result = validatePhaseOrder(["spec", "render"]);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("harden");
  });
});

describe("sanitizeErrorOutput", () => {
  it("masks absolute home paths", () => {
    const input = "File not found: /home/user/project/file.ts";
    const output = sanitizeErrorOutput(input);
    expect(output).not.toContain("/home/user");
    expect(output).toContain("[PATH]");
  });

  it("masks absolute system paths", () => {
    const input = "Error at /usr/local/lib/node_modules/pkg/index.js";
    const output = sanitizeErrorOutput(input);
    expect(output).not.toContain("/usr/local");
    expect(output).toContain("[PATH]");
  });

  it("strips environment variable lines", () => {
    const input = "PATH=/usr/bin\nHOME=/root\nNormal error message";
    const output = sanitizeErrorOutput(input);
    expect(output).not.toContain("PATH=");
    expect(output).not.toContain("HOME=");
    expect(output).toContain("Normal error message");
  });

  it("preserves normal messages", () => {
    const input = "TypeError: Cannot read property of undefined";
    const output = sanitizeErrorOutput(input);
    expect(output).toBe(input);
  });
});

describe("DEFAULT_PHASES", () => {
  it("equals PHASE_ORDER (single source of truth)", () => {
    expect(DEFAULT_PHASES).toEqual(Array.from(PHASE_ORDER));
  });

  it("has all 6 phases including render", () => {
    expect(DEFAULT_PHASES.length).toBe(6);
    expect(DEFAULT_PHASES).toContain("render");
  });
});

describe("sanitizeFeatureName", () => {
  it("strips forward slashes", () => {
    expect(sanitizeFeatureName("foo/bar")).toBe("foo-bar");
  });

  it("strips backslashes", () => {
    expect(sanitizeFeatureName("foo\\bar")).toBe("foo-bar");
  });

  it("strips double-dot traversal", () => {
    expect(sanitizeFeatureName("../secret")).toBe("--secret");
  });

  it("handles complex input with multiple separators", () => {
    expect(sanitizeFeatureName("foo/bar..baz/qux")).toBe("foo-bar-baz-qux");
  });

  it("passes through clean names unchanged", () => {
    expect(sanitizeFeatureName("add-auth")).toBe("add-auth");
  });
});
