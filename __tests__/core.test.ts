import { describe, it, expect } from "vitest";
import { validatePhaseOrder, sanitizeErrorOutput, PHASE_META, PHASE_ORDER, DEFAULT_PHASES, sanitizeFeatureName, detectProjectStack, loadGateConfig, resolveGates, GATE_COMMAND_WHITELIST, isValidGateCommand, isValidTargetPath, resolvePhaseCompletion, resolveSessionStartAction, hasPhaseCompletionMarker, PHASE_COMPLETE_MARKER } from "../src/stateMachine";

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

describe("resolvePhaseCompletion", () => {
  it("does not auto-complete a phase on agent_end", () => {
    const result = resolvePhaseCompletion(["spec", "redteam", "harden"], 0, "agent_end");
    expect(result.action).toBe("wait_for_explicit_completion");
  });

  it("queues the next phase after explicit completion of a non-final phase", () => {
    const result = resolvePhaseCompletion(["spec", "redteam", "harden"], 1, "explicit_signal");
    expect(result.action).toBe("queue_next_phase");
    expect(result.nextPhaseIndex).toBe(2);
    expect(result.nextPhase).toBe("harden");
  });

  it("completes the pipeline after explicit completion of the final phase", () => {
    const result = resolvePhaseCompletion(["spec", "redteam", "harden"], 2, "explicit_signal");
    expect(result.action).toBe("complete_pipeline");
  });
});

describe("hasPhaseCompletionMarker", () => {
  it("returns true when the final non-empty line is the exact marker", () => {
    const text = `Implemented the spec and wrote the files.\n\n${PHASE_COMPLETE_MARKER}`;
    expect(hasPhaseCompletionMarker(text)).toBe(true);
  });

  it("returns false when the marker is only mentioned in prose", () => {
    const text = `I will call ${PHASE_COMPLETE_MARKER} after the next step.`;
    expect(hasPhaseCompletionMarker(text)).toBe(false);
  });

  it("returns false for empty text", () => {
    expect(hasPhaseCompletionMarker("")).toBe(false);
  });
});

describe("resolveSessionStartAction", () => {
  it("resumes the current phase when the pipeline was executing", () => {
    expect(resolveSessionStartAction({ pipelineStatus: "running", phaseStatus: "executing" })).toBe("resume_execution");
  });

  it("launches the queued phase when the pipeline was left in pre_hook", () => {
    expect(resolveSessionStartAction({ pipelineStatus: "running", phaseStatus: "pre_hook" })).toBe("launch_pending_phase");
  });

  it("does not auto-resume when the pipeline is paused", () => {
    expect(resolveSessionStartAction({ pipelineStatus: "paused", phaseStatus: "pre_hook" })).toBe("none");
  });
});

// ── Gate Check: detectProjectStack ──────────────────────────

function makeFsMock(files: Set<string>) {
  return {
    existsSync(path: string): boolean { return files.has(path); },
    readFileSync(_path: string, _enc: string): string { throw new Error("not mocked"); },
  };
}

describe("detectProjectStack", () => {
  it("returns typescript when tsconfig.json + package.json present", () => {
    const fs = makeFsMock(new Set(["/tmp/test-project/tsconfig.json", "/tmp/test-project/package.json"]));
    const result = detectProjectStack("/tmp/test-project", fs);
    expect(result.language).toBe("typescript");
  });

  it("returns javascript when only package.json present", () => {
    const fs = makeFsMock(new Set(["/tmp/test-project/package.json"]));
    const result = detectProjectStack("/tmp/test-project", fs);
    expect(result.language).toBe("javascript");
  });

  it("returns python when pyproject.toml present", () => {
    const fs = makeFsMock(new Set(["/tmp/test-project/pyproject.toml"]));
    const result = detectProjectStack("/tmp/test-project", fs);
    expect(result.language).toBe("python");
  });

  it("returns python when requirements.txt present (no pyproject.toml)", () => {
    const fs = makeFsMock(new Set(["/tmp/test-project/requirements.txt"]));
    const result = detectProjectStack("/tmp/test-project", fs);
    expect(result.language).toBe("python");
  });

  it("returns unknown when no language markers found", () => {
    const fs = makeFsMock(new Set());
    const result = detectProjectStack("/tmp/test-project", fs);
    expect(result.language).toBe("unknown");
  });

  it("returns unknown for polyglot (tsconfig.json + pyproject.toml)", () => {
    const fs = makeFsMock(new Set([
      "/tmp/test-project/tsconfig.json",
      "/tmp/test-project/package.json",
      "/tmp/test-project/pyproject.toml",
    ]));
    const result = detectProjectStack("/tmp/test-project", fs);
    expect(result.language).toBe("unknown");
  });
});

// ── Gate Check: loadGateConfig ───────────────────────────────

describe("loadGateConfig", () => {
  it("returns parsed config for valid JSON with correct version", () => {
    const validConfig = JSON.stringify({
      version: "1.0",
      name: "custom-stack",
      language: "typescript",
      gates: [
        { name: "type-check", command: "npx tsc --noEmit", timeoutMs: 60000 },
        { name: "lint", command: "npx eslint .", timeoutMs: 60000 },
        { name: "test", command: "npx vitest run", timeoutMs: 300000 },
      ],
    });
    const fs = {
      existsSync: (_p: string) => true,
      readFileSync: () => validConfig,
    };
    const config = loadGateConfig("/tmp/test-project", fs);
    expect(config).not.toBeNull();
    expect(config?.name).toBe("custom-stack");
    expect(config?.gates?.length).toBe(3);
  });

  it("returns null for malformed JSON", () => {
    const fs = {
      existsSync: (_p: string) => true,
      readFileSync: () => "{ invalid json }",
    };
    const config = loadGateConfig("/tmp/test-project", fs);
    expect(config).toBeNull();
  });

  it("returns null for unknown version", () => {
    const badVersion = JSON.stringify({
      version: "9.0",
      name: "future-stack",
      gates: [{ name: "x", command: "echo x" }],
    });
    const fs = {
      existsSync: (_p: string) => true,
      readFileSync: () => badVersion,
    };
    const config = loadGateConfig("/tmp/test-project", fs);
    expect(config).toBeNull();
  });

  it("returns null for empty gates array", () => {
    const noGates = JSON.stringify({
      version: "1.0",
      name: "empty-stack",
      gates: [],
    });
    const fs = {
      existsSync: (_p: string) => true,
      readFileSync: () => noGates,
    };
    const config = loadGateConfig("/tmp/test-project", fs);
    expect(config).toBeNull();
  });

  it("returns null when config file does not exist", () => {
    const fs = {
      existsSync: (_p: string) => false,
      readFileSync: () => "",
    };
    const config = loadGateConfig("/tmp/test-project", fs);
    expect(config).toBeNull();
  });
});

// ── Gate Check: resolveGates ─────────────────────────────────

describe("resolveGates", () => {
  it("returns gates from config when valid config present", () => {
    const validConfig = JSON.stringify({
      version: "1.0",
      name: "custom-stack",
      language: "typescript",
      gates: [
        { name: "type-check", command: "npx tsc --noEmit", timeoutMs: 60000 },
        { name: "lint", command: "npx eslint .", timeoutMs: 60000 },
        { name: "test", command: "npx vitest run", timeoutMs: 300000 },
      ],
    });
    const fs = {
      existsSync: (_p: string) => true,
      readFileSync: () => validConfig,
    };
    const gates = resolveGates("/tmp/test-project", undefined, fs);
    expect(gates.length).toBe(3);
    expect(gates[0].name).toBe("type-check");
  });

  it("returns tsc+eslint+vitest defaults for TypeScript stack (no config)", () => {
    const fs = makeFsMock(new Set([
      "/tmp/test-project/tsconfig.json",
      "/tmp/test-project/package.json",
    ]));
    const gates = resolveGates("/tmp/test-project", undefined, fs);
    expect(gates.length).toBeGreaterThanOrEqual(2);
    expect(gates.some((g) => g.name.toLowerCase().includes("tsc") || g.command.includes("tsc"))).toBe(true);
  });

  it("returns ruff+ruff+pytest defaults for Python stack (no config)", () => {
    const fs = makeFsMock(new Set([
      "/tmp/test-project/pyproject.toml",
    ]));
    const gates = resolveGates("/tmp/test-project", undefined, fs);
    expect(gates.length).toBeGreaterThanOrEqual(2);
    expect(gates.some((g) => g.command.includes("ruff") || g.command.includes("pytest"))).toBe(true);
  });

  it("falls back to auto-detect when config has non-whitelisted command", () => {
    const badConfig = JSON.stringify({
      version: "1.0",
      name: "evil-stack",
      gates: [{ name: "evil", command: "rm -rf /", timeoutMs: 5000 }],
    });
    const fs = {
      existsSync: (p: string) => p.includes("gate-config") || p.endsWith("tsconfig.json") || p.endsWith("package.json"),
      readFileSync: () => badConfig,
    };
    const gates = resolveGates("/tmp/test-project", undefined, fs);
    expect(gates.some((g) => g.command === "rm -rf /")).toBe(false);
  });

  it("accepts whitelisted compound command (uv run ruff)", () => {
    const uvConfig = JSON.stringify({
      version: "1.0",
      name: "uv-stack",
      language: "python",
      gates: [
        { name: "lint", command: "uv run ruff check .", timeoutMs: 60000 },
        { name: "test", command: "uv run pytest tests/", timeoutMs: 300000 },
      ],
    });
    const fs = {
      existsSync: (_p: string) => true,
      readFileSync: () => uvConfig,
    };
    const gates = resolveGates("/tmp/test-project", undefined, fs);
    expect(gates.length).toBe(2);
    expect(gates[0].command).toBe("uv run ruff check .");
  });
});

// ── Gate Check: concurrency lock (verify via resolveGates idempotency) ─

describe("gate resolution idempotency", () => {
  it("returns consistent results for repeated calls (lock safety)", () => {
    const fs = makeFsMock(new Set([
      "/tmp/test-project/tsconfig.json",
      "/tmp/test-project/package.json",
    ]));
    const gates1 = resolveGates("/tmp/test-project", undefined, fs);
    const gates2 = resolveGates("/tmp/test-project", undefined, fs);
    expect(gates1.length).toBe(gates2.length);
    expect(gates1.map(g => g.command)).toEqual(gates2.map(g => g.command));
  });

  it("returns same defaults for unknown stack (fallback consistency)", () => {
    const fs = makeFsMock(new Set());
    const gates1 = resolveGates("/tmp/test-project", undefined, fs);
    const gates2 = resolveGates("/tmp/test-project", undefined, fs);
    expect(gates1).toEqual(gates2);
  });
});

describe("GATE_COMMAND_WHITELIST", () => {
  it("includes all standard gate tools", () => {
    const expected = ["tsc", "eslint", "vitest", "jest", "ruff", "pytest", "npx", "uv", "node"];
    for (const tool of expected) {
      expect(GATE_COMMAND_WHITELIST.has(tool)).toBe(true);
    }
  });
});

// ── Gate Check: command/path sanitization ────────────────────

describe("isValidGateCommand", () => {
  it("accepts simple tool commands", () => {
    expect(isValidGateCommand("npx tsc --noEmit")).toBe(true);
    expect(isValidGateCommand("ruff check .")).toBe(true);
    expect(isValidGateCommand("pytest tests/")).toBe(true);
    expect(isValidGateCommand("uv run ruff check .")).toBe(true);
  });

  it("rejects semicolon injection", () => {
    expect(isValidGateCommand("tsc; cat /etc/passwd")).toBe(false);
  });

  it("rejects pipe injection", () => {
    expect(isValidGateCommand("tsc | grep error")).toBe(false);
  });

  it("rejects backtick injection", () => {
    expect(isValidGateCommand("tsc; `whoami`")).toBe(false);
  });

  it("rejects dollar-sign substitution", () => {
    expect(isValidGateCommand("tsc $(whoami)")).toBe(false);
  });

  it("rejects ampersand chaining", () => {
    expect(isValidGateCommand("tsc && rm -rf /")).toBe(false);
  });

  it("rejects newline injection", () => {
    expect(isValidGateCommand("tsc\nrm -rf /")).toBe(false);
  });

  it("rejects redirect injection", () => {
    expect(isValidGateCommand("tsc > /tmp/evil")).toBe(false);
  });

  it("rejects comment injection", () => {
    expect(isValidGateCommand("tsc # comment")).toBe(false);
  });
});

describe("isValidTargetPath", () => {
  it("accepts normal file paths", () => {
    expect(isValidTargetPath("src/foo.ts")).toBe(true);
    expect(isValidTargetPath("lib/bar/baz.tsx")).toBe(true);
    expect(isValidTargetPath("tests/core.test.ts")).toBe(true);
  });

  it("rejects paths with shell metacharacters", () => {
    expect(isValidTargetPath("src/foo.ts; rm -rf /")).toBe(false);
    expect(isValidTargetPath("src/$(whoami).ts")).toBe(false);
    expect(isValidTargetPath("src/foo|bar.ts")).toBe(false);
  });
});

describe("resolveGates rejects shell injection in config", () => {
  it("falls back to defaults when config has semicolon injection", () => {
    const injectedConfig = JSON.stringify({
      version: "1.0",
      name: "injected",
      gates: [{ name: "evil", command: "tsc; cat /etc/passwd", timeoutMs: 5000 }],
    });
    const fs = {
      existsSync: (p: string) => p.includes("gate-config") || p.endsWith("tsconfig.json") || p.endsWith("package.json"),
      readFileSync: () => injectedConfig,
    };
    const gates = resolveGates("/tmp/test-project", undefined, fs);
    // Should have fallen back to TS defaults, not used the injected command
    expect(gates.some((g) => g.command.includes(";"))).toBe(false);
    expect(gates.some((g) => g.command.includes("tsc") || g.name.toLowerCase().includes("type"))).toBe(true);
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
