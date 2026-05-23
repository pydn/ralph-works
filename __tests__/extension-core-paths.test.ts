import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PHASE_COMPLETE_MARKER } from "../src/stateMachine";

interface FakeEntry {
  type: string;
  customType?: string;
  data?: unknown;
}

interface FakeTool {
  execute: (...args: any[]) => unknown;
}

function makeFakePi(branch: FakeEntry[]) {
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const commands = new Map<string, (args: string, ctx: any) => unknown>();
  const completions = new Map<string, (prefix: string) => Array<{ value: string; label: string }>>();
  const tools = new Map<string, FakeTool>();
  const sendUserMessages: Array<{ content: unknown; options?: { deliverAs?: string } }> = [];

  const pi = {
    on(event: string, handler: (event: any, ctx: any) => unknown): void {
      handlers.set(event, handler);
    },
    registerTool(tool: { name: string; execute: (...args: any[]) => unknown }): void {
      tools.set(tool.name, tool);
    },
    registerCommand(
      name: string,
      config: {
        handler: (args: string, ctx: any) => unknown;
        getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }>;
      },
    ): void {
      commands.set(name, config.handler);
      if (config.getArgumentCompletions) completions.set(name, config.getArgumentCompletions);
    },
    appendEntry(customType: string, data?: unknown): void {
      branch.push({ type: "custom", customType, data });
    },
    sendUserMessage(content: unknown, options?: { deliverAs?: string }): void {
      sendUserMessages.push({ content, options });
    },
  };

  return { pi, handlers, commands, completions, tools, sendUserMessages };
}

function makeFakeContext(branch: FakeEntry[], cwd: string, options?: { idle?: boolean }) {
  return {
    cwd,
    isIdle: () => options?.idle ?? false,
    sessionManager: {
      getBranch: () => branch,
    },
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      setWorkingVisible: vi.fn(),
      setWorkingMessage: vi.fn(),
      setWorkingIndicator: vi.fn(),
      theme: {
        fg: (_tone: string, text: string) => text,
      },
    },
    compact: vi.fn(),
  };
}

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function writePassingGateConfig(workDir: string): void {
  fs.mkdirSync(path.join(workDir, ".ralph"), { recursive: true });
  fs.writeFileSync(path.join(workDir, "pass-gate.js"), "process.exit(0);\n", "utf-8");
  fs.writeFileSync(
    path.join(workDir, ".ralph", "gate-config.json"),
    JSON.stringify({
      version: "1.0",
      name: "test-gates",
      gates: [{ name: "Passing Script", command: "node pass-gate.js" }],
    }),
    "utf-8",
  );
}

function seedSkill(skillBase: string, skillName: string): void {
  const dir = path.join(skillBase, skillName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `# ${skillName}`, "utf-8");
}

function seedDefaultPhaseSkills(skillBase: string): void {
  seedSkill(skillBase, "generate-spec");
  seedSkill(skillBase, "red-team-audit");
  seedSkill(skillBase, "harden-spec");
  seedSkill(skillBase, "tasks");
  seedSkill(skillBase, "tdd-implement");
  seedSkill(skillBase, "pi-skills/pr-reviewer");
}

function pushState(branch: FakeEntry[], workDir: string, overrides: Record<string, unknown> = {}): void {
  branch.push({
    type: "custom",
    customType: "ralph-loop-state",
    data: {
      feature: "feature-a",
      workDir,
      phases: ["spec", "redteam", "harden", "render", "implement", "review"],
      maxIterations: 10,
      startedAt: Date.now(),
      currentPhase: "spec",
      currentPhaseIndex: 0,
      phaseStatus: "executing",
      pipelineStatus: "running",
      reviewIterations: 0,
      phaseAttempts: 0,
      turnWriteCount: 0,
      autoClearContext: false,
      ...overrides,
    },
  });
}

function latestState<T extends Record<string, unknown>>(branch: FakeEntry[]): T {
  return branch[branch.length - 1]?.data as T;
}

afterEach(() => {
  delete process.env.PI_SKILL_BASE;
  vi.resetModules();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("/ralph-works start command", () => {
  it("opts users out of HTML rendering for default starts", async () => {
    const workDir = makeTempDir("ralph-default-no-render-");
    const skillBase = makeTempDir("ralph-default-no-render-skills-");
    process.env.PI_SKILL_BASE = skillBase;
    seedSkill(skillBase, "generate-spec");
    seedSkill(skillBase, "red-team-audit");
    seedSkill(skillBase, "harden-spec");
    seedSkill(skillBase, "tasks");
    seedSkill(skillBase, "tdd-implement");
    seedSkill(skillBase, "pi-skills/pr-reviewer");

    const branch: FakeEntry[] = [];
    const { default: registerExtension } = await import("../index");
    const { pi, commands, sendUserMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    await commands.get("ralph-works")?.("start feature-a", makeFakeContext(branch, workDir));

    const state = latestState<{ promptText?: string; phases?: string[]; currentPhase?: string }>(branch);
    expect(state.phases).toEqual(["spec", "redteam", "harden", "tasks", "implement", "review"]);
    expect(state.phases).not.toContain("render");
    expect(state.currentPhase).toBe("spec");
    expect(state.promptText).toBeUndefined();
    expect(sendUserMessages).toHaveLength(1);
    expect(String(sendUserMessages[0]?.content)).not.toContain("Render Markdown");
  });

  it("allows users to opt in to HTML rendering on start", async () => {
    const workDir = makeTempDir("ralph-start-render-opt-in-");
    const skillBase = makeTempDir("ralph-start-render-opt-in-skills-");
    process.env.PI_SKILL_BASE = skillBase;
    seedSkill(skillBase, "generate-spec");
    seedSkill(skillBase, "red-team-audit");
    seedSkill(skillBase, "harden-spec");
    seedSkill(skillBase, "tasks");
    seedSkill(skillBase, "markdown-to-html");
    seedSkill(skillBase, "tdd-implement");
    seedSkill(skillBase, "pi-skills/pr-reviewer");

    const branch: FakeEntry[] = [];
    const { default: registerExtension } = await import("../index");
    const { pi, commands, sendUserMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    await commands.get("ralph-works")?.("start feature-a --render-html", makeFakeContext(branch, workDir));

    const state = latestState<{ promptText?: string; phases?: string[]; currentPhase?: string }>(branch);
    expect(state.phases).toEqual(["spec", "redteam", "harden", "tasks", "render", "implement", "review"]);
    expect(state.currentPhase).toBe("spec");
    expect(state.promptText).toBeUndefined();
    expect(sendUserMessages).toHaveLength(1);
  });

  it("allows users to opt in to HTML rendering on start with the html alias", async () => {
    const workDir = makeTempDir("ralph-start-html-alias-");
    const skillBase = makeTempDir("ralph-start-html-alias-skills-");
    process.env.PI_SKILL_BASE = skillBase;
    seedSkill(skillBase, "generate-spec");
    seedSkill(skillBase, "red-team-audit");
    seedSkill(skillBase, "harden-spec");
    seedSkill(skillBase, "tasks");
    seedSkill(skillBase, "markdown-to-html");
    seedSkill(skillBase, "tdd-implement");
    seedSkill(skillBase, "pi-skills/pr-reviewer");

    const branch: FakeEntry[] = [];
    const { default: registerExtension } = await import("../index");
    const { pi, commands } = makeFakePi(branch);
    registerExtension(pi as any);

    await commands.get("ralph-works")?.("start feature-a html", makeFakeContext(branch, workDir));

    const state = latestState<{ phases?: string[]; currentPhase?: string }>(branch);
    expect(state.phases).toEqual(["spec", "redteam", "harden", "tasks", "render", "implement", "review"]);
    expect(state.currentPhase).toBe("spec");
  });

  it("rejects direct implement starts without the required tasks phase", async () => {
    const workDir = makeTempDir("ralph-implement-tool-prompt-");
    writePassingGateConfig(workDir);
    const skillBase = makeTempDir("ralph-implement-tool-prompt-skills-");
    process.env.PI_SKILL_BASE = skillBase;

    const branch: FakeEntry[] = [];
    const { default: registerExtension } = await import("../index");
    const { pi, commands, sendUserMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    await commands.get("ralph-works")?.("start feature-a implement", makeFakeContext(branch, workDir));

    expect(sendUserMessages).toHaveLength(0);
    expect(latestState(branch)).toBeUndefined();
  });

  it("persists yolo mode from the start command", async () => {
    const workDir = makeTempDir("ralph-start-yolo-");
    const skillBase = makeTempDir("ralph-start-yolo-skills-");
    process.env.PI_SKILL_BASE = skillBase;
    seedSkill(skillBase, "generate-spec");
    seedSkill(skillBase, "red-team-audit");
    seedSkill(skillBase, "harden-spec");
    seedSkill(skillBase, "tasks");
    seedSkill(skillBase, "tdd-implement");
    seedSkill(skillBase, "pi-skills/pr-reviewer");

    const branch: FakeEntry[] = [];
    const { default: registerExtension } = await import("../index");
    const { pi, commands, sendUserMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    await commands.get("ralph-works")?.("start feature-a --yolo", makeFakeContext(branch, workDir));

    const state = latestState<{ yoloMode?: boolean; phases?: string[]; promptText?: string }>(branch);
    expect(state.yoloMode).toBe(true);
    expect(state.phases).toEqual(["spec", "redteam", "harden", "tasks", "implement", "review"]);
    expect(state.promptText).toBeUndefined();
    expect(sendUserMessages).toHaveLength(1);
  });

  it("rejects the removed /ralph-works <feature> shorthand instead of starting a pipeline", async () => {
    const workDir = makeTempDir("ralph-no-shorthand-");
    const branch: FakeEntry[] = [];
    const { default: registerExtension } = await import("../index");
    const { pi, commands, sendUserMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    const ctx = makeFakeContext(branch, workDir);
    await commands.get("ralph-works")?.("feature-a --yolo", ctx);

    expect(branch).toHaveLength(0);
    expect(sendUserMessages).toHaveLength(0);
    expect(fs.existsSync(path.join(workDir, ".ralph", "pipeline-lock-feature-a"))).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Unknown /ralph-works command: feature-a"),
      "error",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Usage: /ralph-works start <feature>"), "error");
  });

  it("only advertises valid top-level /ralph-works subcommands in argument completions", async () => {
    const branch: FakeEntry[] = [];
    const { default: registerExtension } = await import("../index");
    const { pi, completions } = makeFakePi(branch);
    registerExtension(pi as any);

    const values = completions
      .get("ralph-works")?.("")
      .map((item) => item.value);

    expect(values).toEqual([
      "start",
      "status",
      "cancel",
      "gate",
      "continue",
      "resume",
      "pause",
      "set-workdir",
      "clear-context",
    ]);
    expect(values).not.toContain("spec");
    expect(values).not.toContain("html");
    expect(values).not.toContain("--yolo");
  });

  it("reads prompt text from a workspace file and applies an explicit phase list", async () => {
    const workDir = makeTempDir("ralph-start-work-");
    const skillBase = makeTempDir("ralph-start-skills-");
    process.env.PI_SKILL_BASE = skillBase;
    seedSkill(skillBase, "generate-spec");
    seedSkill(skillBase, "red-team-audit");
    fs.writeFileSync(path.join(workDir, "requirements.md"), "Detailed build requirements", "utf-8");

    const branch: FakeEntry[] = [];
    const { default: registerExtension } = await import("../index");
    const { pi, commands, sendUserMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    const ralph = commands.get("ralph-works");
    expect(ralph).toBeTypeOf("function");
    await ralph?.("start feature-a requirements.md spec,redteam", makeFakeContext(branch, workDir));

    const state = latestState<{ promptText?: string; phases?: string[]; phaseStatus?: string }>(branch);
    expect(state.promptText).toBe("Detailed build requirements");
    expect(state.phases).toEqual(["spec", "redteam"]);
    expect(state.phaseStatus).toBe("executing");
    expect(sendUserMessages).toHaveLength(1);
    expect(String(sendUserMessages[0]?.content)).toContain("Detailed build requirements");
  });

  it("preserves quoted inline prompt text with spaces", async () => {
    const workDir = makeTempDir("ralph-start-quoted-prompt-");
    const skillBase = makeTempDir("ralph-start-quoted-prompt-skills-");
    process.env.PI_SKILL_BASE = skillBase;
    seedDefaultPhaseSkills(skillBase);

    const branch: FakeEntry[] = [];
    const { default: registerExtension } = await import("../index");
    const { pi, commands, sendUserMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    await commands.get("ralph-works")?.(
      'start hello-world "Write a hello world script in python"',
      makeFakeContext(branch, workDir),
    );

    const state = latestState<{ promptText?: string; phases?: string[] }>(branch);
    expect(state.promptText).toBe("Write a hello world script in python");
    expect(state.phases).toEqual(["spec", "redteam", "harden", "tasks", "implement", "review"]);
    expect(sendUserMessages).toHaveLength(1);
    expect(String(sendUserMessages[0]?.content)).toContain("Write a hello world script in python");
  });

  it("preserves quoted prompt text when phases and flags follow it", async () => {
    const workDir = makeTempDir("ralph-start-quoted-prompt-phases-");
    const skillBase = makeTempDir("ralph-start-quoted-prompt-phases-skills-");
    process.env.PI_SKILL_BASE = skillBase;
    seedSkill(skillBase, "generate-spec");
    seedSkill(skillBase, "red-team-audit");

    const branch: FakeEntry[] = [];
    const { default: registerExtension } = await import("../index");
    const { pi, commands, sendUserMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    await commands.get("ralph-works")?.(
      'start feature-a "Detailed prompt with spaces" spec,redteam --yolo',
      makeFakeContext(branch, workDir),
    );

    const state = latestState<{ promptText?: string; phases?: string[]; yoloMode?: boolean }>(branch);
    expect(state.promptText).toBe("Detailed prompt with spaces");
    expect(state.phases).toEqual(["spec", "redteam"]);
    expect(state.yoloMode).toBe(true);
    expect(sendUserMessages).toHaveLength(1);
    expect(String(sendUserMessages[0]?.content)).toContain("Detailed prompt with spaces");
  });

  it("reads prompt text from .txt and .html workspace files", async () => {
    const cases = [
      { fileName: "requirements.txt", content: "Plain text requirements" },
      { fileName: "requirements.html", content: "<main>HTML requirements</main>" },
    ];

    for (const promptFile of cases) {
      const workDir = makeTempDir("ralph-start-prompt-file-");
      const skillBase = makeTempDir("ralph-start-prompt-file-skills-");
      process.env.PI_SKILL_BASE = skillBase;
      seedSkill(skillBase, "generate-spec");
      fs.writeFileSync(path.join(workDir, promptFile.fileName), promptFile.content, "utf-8");

      const branch: FakeEntry[] = [];
      const { default: registerExtension } = await import("../index");
      const { pi, commands, sendUserMessages } = makeFakePi(branch);
      registerExtension(pi as any);

      await commands.get("ralph-works")?.(
        `start feature-a ${promptFile.fileName} spec`,
        makeFakeContext(branch, workDir),
      );

      const state = latestState<{ promptText?: string; phases?: string[] }>(branch);
      expect(state.promptText).toBe(promptFile.content);
      expect(state.phases).toEqual(["spec"]);
      expect(sendUserMessages).toHaveLength(1);
      expect(String(sendUserMessages[0]?.content)).toContain(promptFile.content);

      delete process.env.PI_SKILL_BASE;
      vi.resetModules();
    }
  });

  it("does not read prompt file contents outside the workspace or from sensitive files", async () => {
    const workDir = makeTempDir("ralph-start-safe-prompt-file-");
    const outsideDir = makeTempDir("ralph-start-outside-prompt-file-");
    const skillBase = makeTempDir("ralph-start-safe-prompt-file-skills-");
    process.env.PI_SKILL_BASE = skillBase;
    seedSkill(skillBase, "generate-spec");
    fs.writeFileSync(path.join(outsideDir, "requirements.md"), "Outside workspace secret", "utf-8");
    fs.writeFileSync(path.join(workDir, ".env"), "WORKSPACE_SECRET=1", "utf-8");

    const outsideBranch: FakeEntry[] = [];
    const { default: registerExtension } = await import("../index");
    const outsidePi = makeFakePi(outsideBranch);
    registerExtension(outsidePi.pi as any);

    const outsidePath = path.join(outsideDir, "requirements.md");
    await outsidePi.commands.get("ralph-works")?.(
      `start feature-a ${outsidePath} spec`,
      makeFakeContext(outsideBranch, workDir),
    );

    const outsideState = latestState<{ promptText?: string }>(outsideBranch);
    expect(outsideState.promptText).toBe(outsidePath);
    expect(String(outsidePi.sendUserMessages[0]?.content)).not.toContain("Outside workspace secret");

    delete process.env.PI_SKILL_BASE;
    vi.resetModules();
    process.env.PI_SKILL_BASE = skillBase;

    const sensitiveBranch: FakeEntry[] = [];
    const { default: freshRegisterExtension } = await import("../index");
    const sensitivePi = makeFakePi(sensitiveBranch);
    freshRegisterExtension(sensitivePi.pi as any);

    await sensitivePi.commands.get("ralph-works")?.(
      "start feature-b .env spec",
      makeFakeContext(sensitiveBranch, workDir),
    );

    const sensitiveState = latestState<{ promptText?: string }>(sensitiveBranch);
    expect(sensitiveState.promptText).toBe(".env");
    expect(String(sensitivePi.sendUserMessages[0]?.content)).not.toContain("WORKSPACE_SECRET=1");
  });

  it("checks all selected phase skills before saving state or launching work", async () => {
    const workDir = makeTempDir("ralph-start-missing-skill-");
    const skillBase = makeTempDir("ralph-start-missing-skills-");
    process.env.PI_SKILL_BASE = skillBase;
    seedSkill(skillBase, "generate-spec");

    const branch: FakeEntry[] = [];
    const { default: registerExtension } = await import("../index");
    const { pi, commands, sendUserMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    const ctx = makeFakeContext(branch, workDir);
    await commands.get("ralph-works")?.("start feature-a spec,redteam", ctx);

    expect(branch).toHaveLength(0);
    expect(sendUserMessages).toHaveLength(0);
    expect(fs.existsSync(path.join(workDir, ".ralph", "pipeline-lock-feature-a"))).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Missing ralph-works phase skill prerequisites"),
      "error",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining(path.join(skillBase, "red-team-audit", "SKILL.md")),
      "error",
    );
  });

  it("rejects invalid phase combinations before saving state or launching work", async () => {
    const workDir = makeTempDir("ralph-invalid-start-");
    const branch: FakeEntry[] = [];

    const { default: registerExtension } = await import("../index");
    const { pi, commands, sendUserMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    const ctx = makeFakeContext(branch, workDir);
    await commands.get("ralph-works")?.("start feature-a review", ctx);

    expect(branch).toHaveLength(0);
    expect(sendUserMessages).toHaveLength(0);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Invalid phase order"), "error");
  });

  it("does not start a second pipeline when state already exists", async () => {
    const workDir = makeTempDir("ralph-existing-start-");
    const branch: FakeEntry[] = [];
    pushState(branch, workDir);

    const { default: registerExtension } = await import("../index");
    const { pi, commands, sendUserMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    const ctx = makeFakeContext(branch, workDir);
    await commands.get("ralph-works")?.("start another-feature", ctx);

    expect(sendUserMessages).toHaveLength(0);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("already running"), "error");
  });

  it("shows the persisted workDir and expected artifact path in status", async () => {
    const workDir = makeTempDir("ralph-status-workdir-");
    const branch: FakeEntry[] = [];
    pushState(branch, workDir, {
      phases: ["spec"],
      currentPhase: "spec",
      currentPhaseIndex: 0,
    });

    const { default: registerExtension } = await import("../index");
    const { pi, commands } = makeFakePi(branch);
    registerExtension(pi as any);

    const ctx = makeFakeContext(branch, workDir);
    await commands.get("ralph-works")?.("status", ctx);

    const notification = String(ctx.ui.notify.mock.calls[0]?.[0]);
    expect(notification).toContain(`WorkDir: ${workDir}`);
    expect(notification).toContain(path.join(workDir, "docs", "specs", "feature-a.md"));
  });

  it("lets the agent explicitly update the run workDir after creating a worktree", async () => {
    const originalWorkDir = makeTempDir("ralph-original-workdir-");
    const worktreeDir = makeTempDir("ralph-agent-worktree-");
    const branch: FakeEntry[] = [];
    pushState(branch, originalWorkDir);

    const { default: registerExtension } = await import("../index");
    const { pi, tools } = makeFakePi(branch);
    registerExtension(pi as any);

    const result = (await tools
      .get("ralph_set_workdir")
      ?.execute(
        "set-workdir-1",
        { workDir: worktreeDir },
        undefined,
        vi.fn(),
        makeFakeContext(branch, originalWorkDir),
      )) as {
      content: Array<{ text: string }>;
    };

    const state = latestState<{ workDir?: string; lastValidationFailure?: string }>(branch);
    expect(state.workDir).toBe(worktreeDir);
    expect(state.lastValidationFailure).toBeUndefined();
    expect(result.content[0]?.text).toContain(worktreeDir);
  });

  it("allows a new start after canceling the persisted active pipeline", async () => {
    const workDir = makeTempDir("ralph-cancel-new-start-");
    const skillBase = makeTempDir("ralph-cancel-new-start-skills-");
    process.env.PI_SKILL_BASE = skillBase;
    seedSkill(skillBase, "generate-spec");
    fs.mkdirSync(path.join(workDir, ".ralph"), { recursive: true });
    fs.writeFileSync(path.join(workDir, ".ralph", "pipeline-lock-feature-a"), "{}", "utf-8");

    const branch: FakeEntry[] = [];
    pushState(branch, workDir, {
      feature: "feature-a",
      phases: ["spec"],
      currentPhase: "spec",
      currentPhaseIndex: 0,
      pendingSteerKey: "phase-transition:0:spec",
      pendingSteerSentAt: Date.now(),
    });

    const { default: registerExtension } = await import("../index");
    const { pi, commands, sendUserMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    const ctx = makeFakeContext(branch, workDir);
    await commands.get("ralph-works")?.("cancel", ctx);
    await commands.get("ralph-works")?.("start feature-b spec", ctx);

    expect(fs.existsSync(path.join(workDir, ".ralph", "pipeline-lock-feature-a"))).toBe(false);
    expect(sendUserMessages).toHaveLength(1);
    const state = latestState<{
      feature?: string;
      pipelineStatus?: string;
      phaseStatus?: string;
      pendingSteerKey?: string;
      pendingSteerSentAt?: number;
    }>(branch);
    expect(state.feature).toBe("feature-b");
    expect(state.pipelineStatus).toBe("running");
    expect(state.phaseStatus).toBe("executing");
    expect(state.pendingSteerKey).toBeUndefined();
    expect(state.pendingSteerSentAt).toBeUndefined();
  });

  it("clears orphaned pipeline locks on cancel so the same feature can restart", async () => {
    const workDir = makeTempDir("ralph-cancel-orphan-lock-");
    const skillBase = makeTempDir("ralph-cancel-orphan-lock-skills-");
    process.env.PI_SKILL_BASE = skillBase;
    seedSkill(skillBase, "generate-spec");
    fs.mkdirSync(path.join(workDir, ".ralph"), { recursive: true });
    fs.writeFileSync(path.join(workDir, ".ralph", "pipeline-lock-feature-a"), "{}", "utf-8");

    const branch: FakeEntry[] = [];
    const { default: registerExtension } = await import("../index");
    const { pi, commands, sendUserMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    const ctx = makeFakeContext(branch, workDir);
    await commands.get("ralph-works")?.("cancel", ctx);
    await commands.get("ralph-works")?.("start feature-a spec", ctx);
    await commands.get("ralph-works")?.("cancel", ctx);
    await commands.get("ralph-works")?.("start feature-a spec", ctx);

    expect(sendUserMessages).toHaveLength(2);
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("already running"), "error");
    expect(latestState<{ feature?: string; pipelineStatus?: string }>(branch)).toMatchObject({
      feature: "feature-a",
      pipelineStatus: "running",
    });
  });
});

describe("extension event guards", () => {
  it("guards skill injection when there is no active pipeline and avoids duplicate phase skill tags", async () => {
    const workDir = makeTempDir("ralph-skill-work-");
    const skillBase = makeTempDir("ralph-skill-base-");
    process.env.PI_SKILL_BASE = skillBase;
    seedSkill(skillBase, "generate-spec");

    const branch: FakeEntry[] = [];
    const { default: registerExtension } = await import("../index");
    const { pi, handlers } = makeFakePi(branch);
    registerExtension(pi as any);

    const beforeAgentStart = handlers.get("before_agent_start");
    expect(await beforeAgentStart?.({ systemPrompt: "base" }, makeFakeContext(branch, workDir))).toBeUndefined();

    pushState(branch, workDir, { currentPhase: "spec", currentPhaseIndex: 0, pipelineStatus: "cancelled" });
    expect(await beforeAgentStart?.({ systemPrompt: "base" }, makeFakeContext(branch, workDir))).toBeUndefined();

    pushState(branch, workDir, { currentPhase: "spec", currentPhaseIndex: 0 });
    const injected = await beforeAgentStart?.({ systemPrompt: "base" }, makeFakeContext(branch, workDir));
    expect((injected as { systemPrompt?: string })?.systemPrompt).toContain("<ralph-spec-skill>");

    const duplicate = await beforeAgentStart?.(
      { systemPrompt: "base\nralph-spec-skill" },
      makeFakeContext(branch, workDir),
    );
    expect(duplicate).toBeUndefined();
  });

  it("marks corrupted persisted phase indexes as failed on session start", async () => {
    const workDir = makeTempDir("ralph-corrupt-work-");
    const branch: FakeEntry[] = [];
    pushState(branch, workDir, {
      phases: ["spec", "redteam"],
      currentPhase: "redteam",
      currentPhaseIndex: 99,
      phaseStatus: "executing",
    });

    const { default: registerExtension } = await import("../index");
    const { pi, handlers, sendUserMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    const ctx = makeFakeContext(branch, workDir);
    await handlers.get("session_start")?.({}, ctx);

    const state = latestState<{ pipelineStatus?: string; phaseStatus?: string }>(branch);
    expect(state.pipelineStatus).toBe("failed");
    expect(state.phaseStatus).toBe("corrupted");
    expect(sendUserMessages).toHaveLength(0);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("currentPhaseIndex=99"), "error");
  });

  it("clears pending steer metadata and returns waiting phases to executing on assistant start", async () => {
    const workDir = makeTempDir("ralph-message-start-");
    const branch: FakeEntry[] = [];
    pushState(branch, workDir, {
      phaseStatus: "waiting_for_user",
      pendingSteerKey: "phase-transition:0:spec",
      pendingSteerSentAt: Date.now(),
      turnWriteCount: 2,
    });

    const { default: registerExtension } = await import("../index");
    const { pi, handlers } = makeFakePi(branch);
    registerExtension(pi as any);

    await handlers.get("message_start")?.({ message: { role: "assistant" } }, makeFakeContext(branch, workDir));

    const state = latestState<{
      phaseStatus?: string;
      pendingSteerKey?: string;
      pendingSteerSentAt?: number;
      turnWriteCount?: number;
    }>(branch);
    expect(state.phaseStatus).toBe("executing");
    expect(state.pendingSteerKey).toBeUndefined();
    expect(state.pendingSteerSentAt).toBeUndefined();
    expect(state.turnWriteCount).toBe(0);
  });

  it("pauses without overwriting phase status, clears pending steer metadata, and aborts when available", async () => {
    const workDir = makeTempDir("ralph-pause-hard-");
    const branch: FakeEntry[] = [];
    pushState(branch, workDir, {
      currentPhase: "implement",
      currentPhaseIndex: 3,
      phaseStatus: "executing",
      pendingSteerKey: "implement-gate:3",
      pendingSteerSentAt: Date.now(),
      readyToAdvancePhase: "implement",
      turnWriteCount: 2,
    });

    const { default: registerExtension } = await import("../index");
    const { pi, commands } = makeFakePi(branch);
    registerExtension(pi as any);

    const ctx = makeFakeContext(branch, workDir) as ReturnType<typeof makeFakeContext> & {
      abort: ReturnType<typeof vi.fn>;
      signal: AbortSignal;
    };
    ctx.abort = vi.fn();
    ctx.signal = new AbortController().signal;

    await commands.get("ralph-works")?.("pause", ctx);

    const state = latestState<{
      pipelineStatus?: string;
      phaseStatus?: string;
      pausedFromPhaseStatus?: string;
      pendingSteerKey?: string;
      pendingSteerSentAt?: number;
      readyToAdvancePhase?: string;
      turnWriteCount?: number;
    }>(branch);
    expect(state.pipelineStatus).toBe("paused");
    expect(state.phaseStatus).toBe("executing");
    expect(state.pausedFromPhaseStatus).toBe("executing");
    expect(state.pendingSteerKey).toBeUndefined();
    expect(state.pendingSteerSentAt).toBeUndefined();
    expect(state.readyToAdvancePhase).toBeUndefined();
    expect(state.turnWriteCount).toBe(0);
    expect(ctx.abort).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("abort requested"), "warning");
  });

  it("states soft-pause limitations when no abort API is available", async () => {
    const workDir = makeTempDir("ralph-pause-soft-");
    const branch: FakeEntry[] = [];
    pushState(branch, workDir, {
      currentPhase: "implement",
      currentPhaseIndex: 3,
      phaseStatus: "executing",
    });

    const { default: registerExtension } = await import("../index");
    const { pi, commands } = makeFakePi(branch);
    registerExtension(pi as any);

    const ctx = makeFakeContext(branch, workDir);
    await commands.get("ralph-works")?.("pause", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("current assistant turn may continue"),
      "warning",
    );
  });

  it("resumes a paused waiting checkpoint without relaunching the phase", async () => {
    const workDir = makeTempDir("ralph-resume-paused-waiting-");
    const branch: FakeEntry[] = [];
    pushState(branch, workDir, {
      phases: ["spec", "implement", "review"],
      currentPhase: "implement",
      currentPhaseIndex: 1,
      phaseStatus: "waiting_for_user",
      pausedFromPhaseStatus: "waiting_for_user",
      waitingReason: "implement_checkpoint",
      pipelineStatus: "paused",
      pendingSteerKey: "phase-transition:1:implement",
      pendingSteerSentAt: Date.now(),
    });

    const { default: registerExtension } = await import("../index");
    const { pi, commands, sendUserMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    const ctx = makeFakeContext(branch, workDir);
    await commands.get("ralph-works")?.("resume", ctx);

    const state = latestState<{
      pipelineStatus?: string;
      phaseStatus?: string;
      pausedFromPhaseStatus?: string;
      waitingReason?: string;
      pendingSteerKey?: string;
      pendingSteerSentAt?: number;
    }>(branch);
    expect(state.pipelineStatus).toBe("running");
    expect(state.phaseStatus).toBe("waiting_for_user");
    expect(state.pausedFromPhaseStatus).toBeUndefined();
    expect(state.waitingReason).toBe("implement_checkpoint");
    expect(state.pendingSteerKey).toBeUndefined();
    expect(state.pendingSteerSentAt).toBeUndefined();
    expect(sendUserMessages).toHaveLength(0);
  });
});

describe("gate tool and auto-gate paths", () => {
  it("resets the consecutive write counter after auto-gating on the threshold write", async () => {
    const workDir = makeTempDir("ralph-autogate-work-");
    writePassingGateConfig(workDir);
    const branch: FakeEntry[] = [];
    pushState(branch, workDir, {
      phases: ["implement", "review"],
      currentPhase: "implement",
      currentPhaseIndex: 0,
      turnWriteCount: 2,
    });

    const { default: registerExtension } = await import("../index");
    const { pi, handlers, sendUserMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    const ctx = makeFakeContext(branch, workDir);
    await handlers.get("tool_result")?.({ toolName: "write" }, ctx);

    const state = latestState<{ turnWriteCount?: number }>(branch);
    expect(state.turnWriteCount).toBe(0);
    expect(sendUserMessages).toHaveLength(0);
    expect(ctx.ui.notify).toHaveBeenCalledWith("🚧 Auto-gate: running lint checks...", "info");
    expect(ctx.ui.notify).toHaveBeenCalledWith("✅ All gates passed", "info");
  });

  it("resets the write counter on non-write tools during gate phases", async () => {
    const workDir = makeTempDir("ralph-tool-reset-");
    const branch: FakeEntry[] = [];
    pushState(branch, workDir, {
      phases: ["implement", "review"],
      currentPhase: "implement",
      currentPhaseIndex: 0,
      turnWriteCount: 2,
    });

    const { default: registerExtension } = await import("../index");
    const { pi, handlers } = makeFakePi(branch);
    registerExtension(pi as any);

    await handlers.get("tool_result")?.({ toolName: "read" }, makeFakeContext(branch, workDir));

    expect(latestState<{ turnWriteCount?: number }>(branch).turnWriteCount).toBe(0);
  });

  it("manual ralph_gate_check returns structured results and clears the write counter", async () => {
    const workDir = makeTempDir("ralph-manual-gate-");
    writePassingGateConfig(workDir);
    const branch: FakeEntry[] = [];
    pushState(branch, workDir, {
      phases: ["implement", "review"],
      currentPhase: "implement",
      currentPhaseIndex: 0,
      turnWriteCount: 2,
    });

    const { default: registerExtension } = await import("../index");
    const { pi, tools } = makeFakePi(branch);
    registerExtension(pi as any);

    const ctx = makeFakeContext(branch, workDir);
    const onUpdate = vi.fn();
    const result = (await tools
      .get("ralph_gate_check")
      ?.execute("gate-1", { paths: ["src/file.ts", "src/file.ts;rm"] }, undefined, onUpdate, ctx)) as {
      content?: Array<{ text?: string }>;
      details?: { allPass?: boolean };
    };

    expect(result.details?.allPass).toBe(true);
    expect(onUpdate).toHaveBeenCalled();
    expect(latestState<{ turnWriteCount?: number }>(branch).turnWriteCount).toBe(0);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("ralph-loop", "✅ Gates clear");
    expect(result.content?.[0]?.text).toContain("node pass-gate.js");
    expect(result.content?.[0]?.text).toContain(".ralph/gate-config.json");
  });

  it("manual ralph_gate_check reports no configured gates without marking implement ready", async () => {
    const workDir = makeTempDir("ralph-manual-no-gates-");
    const branch: FakeEntry[] = [];
    pushState(branch, workDir, {
      phases: ["implement", "review"],
      currentPhase: "implement",
      currentPhaseIndex: 0,
      turnWriteCount: 2,
    });

    const { default: registerExtension } = await import("../index");
    const { pi, tools } = makeFakePi(branch);
    registerExtension(pi as any);

    const ctx = makeFakeContext(branch, workDir);
    const result = (await tools.get("ralph_gate_check")?.execute("gate-1", {}, undefined, vi.fn(), ctx)) as {
      content?: Array<{ text?: string }>;
      details?: { allPass?: boolean };
    };

    expect(result.details?.allPass).toBe(true);
    expect(result.content?.[0]?.text).toContain("No ralph-works Gates Configured");
    expect(result.content?.[0]?.text).toContain("No configured ralph-works gates were run");
    expect(
      latestState<{ readyToAdvancePhase?: string; turnWriteCount?: number }>(branch).readyToAdvancePhase,
    ).toBeUndefined();
    expect(latestState<{ readyToAdvancePhase?: string; turnWriteCount?: number }>(branch).turnWriteCount).toBe(0);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("ralph-loop", "No ralph-works gates configured");
  });

  it("manual ralph_gate_check reports nonzero gate commands as failures", async () => {
    const workDir = makeTempDir("ralph-manual-gate-fails-");
    fs.mkdirSync(path.join(workDir, ".ralph"), { recursive: true });
    fs.writeFileSync(path.join(workDir, "fail-gate.js"), "process.exit(2);\n", "utf-8");
    fs.writeFileSync(
      path.join(workDir, ".ralph", "gate-config.json"),
      JSON.stringify({
        version: "1.0",
        name: "controlled-failure",
        gates: [{ name: "Failing Script", command: "node fail-gate.js" }],
      }),
      "utf-8",
    );

    const branch: FakeEntry[] = [];
    pushState(branch, workDir, {
      phases: ["implement", "review"],
      currentPhase: "implement",
      currentPhaseIndex: 0,
      turnWriteCount: 2,
    });

    const { default: registerExtension } = await import("../index");
    const { pi, tools } = makeFakePi(branch);
    registerExtension(pi as any);

    const ctx = makeFakeContext(branch, workDir);
    const result = (await tools.get("ralph_gate_check")?.execute("gate-1", {}, undefined, vi.fn(), ctx)) as {
      content?: Array<{ text?: string }>;
      details?: { allPass?: boolean };
    };

    expect(result.details?.allPass).toBe(false);
    expect(result.content?.[0]?.text).toContain("Gate Failures");
    expect(latestState<{ readyToAdvancePhase?: string }>(branch).readyToAdvancePhase).toBeUndefined();
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("ralph-loop", expect.stringContaining("Failing Script"));
  });
});

describe("review decision and completion paths", () => {
  it("pauses before first implementation when earlier phases already ran", async () => {
    const workDir = makeTempDir("ralph-implement-checkpoint-");
    fs.mkdirSync(path.join(workDir, "docs", "specs"), { recursive: true });
    fs.writeFileSync(
      path.join(workDir, "docs", "specs", "feature-a.md"),
      `# Feature A\n\n${"Spec body.\n".repeat(256)}`,
      "utf-8",
    );

    const branch: FakeEntry[] = [];
    pushState(branch, workDir, {
      phases: ["spec", "implement", "review"],
      currentPhase: "spec",
      currentPhaseIndex: 0,
      phaseStatus: "executing",
    });

    const { default: registerExtension } = await import("../index");
    const { pi, handlers, sendUserMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    const ctx = makeFakeContext(branch, workDir);
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: `Spec complete.\n\n${PHASE_COMPLETE_MARKER}` }],
          },
        ],
      },
      ctx,
    );

    const state = latestState<{
      currentPhase?: string;
      currentPhaseIndex?: number;
      phaseStatus?: string;
      waitingReason?: string;
    }>(branch);
    expect(state.currentPhase).toBe("implement");
    expect(state.currentPhaseIndex).toBe(1);
    expect(state.phaseStatus).toBe("waiting_for_user");
    expect(state.waitingReason).toBe("implement_checkpoint");
    expect(sendUserMessages).toHaveLength(0);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Review the completed planning phases"),
      "warning",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("/ralph-works continue --render-html"),
      "warning",
    );
  });

  it("auto-compacts before the pre-implementation checkpoint when enabled", async () => {
    const workDir = makeTempDir("ralph-implement-checkpoint-compact-");
    fs.mkdirSync(path.join(workDir, "docs", "specs"), { recursive: true });
    fs.writeFileSync(
      path.join(workDir, "docs", "specs", "feature-a.md"),
      `# Feature A\n\n${"Spec body.\n".repeat(256)}`,
      "utf-8",
    );

    const branch: FakeEntry[] = [];
    pushState(branch, workDir, {
      phases: ["spec", "implement", "review"],
      currentPhase: "spec",
      currentPhaseIndex: 0,
      phaseStatus: "executing",
      autoClearContext: true,
    });

    const { default: registerExtension } = await import("../index");
    const { pi, handlers, sendUserMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    const ctx = makeFakeContext(branch, workDir);
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: `Spec complete.\n\n${PHASE_COMPLETE_MARKER}` }],
          },
        ],
      },
      ctx,
    );

    expect(ctx.compact).toHaveBeenCalledTimes(1);
    expect(sendUserMessages).toHaveLength(0);
    const compactOptions = ctx.compact.mock.calls[0]?.[0] as { onComplete?: () => void };
    compactOptions.onComplete?.();

    const state = latestState<{
      currentPhase?: string;
      phaseStatus?: string;
      waitingReason?: string;
      contextClearCount?: number;
    }>(branch);
    expect(state.currentPhase).toBe("implement");
    expect(state.phaseStatus).toBe("waiting_for_user");
    expect(state.waitingReason).toBe("implement_checkpoint");
    expect(state.contextClearCount).toBe(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Review the completed planning phases"),
      "warning",
    );
  });

  it("does not advertise the HTML render opt-in after render already ran", async () => {
    const workDir = makeTempDir("ralph-implement-checkpoint-after-render-");
    fs.mkdirSync(path.join(workDir, "docs", "specs"), { recursive: true });
    fs.writeFileSync(
      path.join(workDir, "docs", "specs", "feature-a-final.html"),
      `<html><body>${"Rendered spec.".repeat(256)}</body></html>`,
      "utf-8",
    );

    const branch: FakeEntry[] = [];
    pushState(branch, workDir, {
      phases: ["spec", "harden", "render", "implement", "review"],
      currentPhase: "render",
      currentPhaseIndex: 2,
      phaseStatus: "executing",
    });

    const { default: registerExtension } = await import("../index");
    const { pi, handlers } = makeFakePi(branch);
    registerExtension(pi as any);

    const ctx = makeFakeContext(branch, workDir);
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: `Render complete.\n\n${PHASE_COMPLETE_MARKER}` }],
          },
        ],
      },
      ctx,
    );

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.not.stringContaining("/ralph-works continue --render-html"),
      "warning",
    );
  });

  it("lets yolo mode proceed from tasks into automatic task selection", async () => {
    const workDir = makeTempDir("ralph-yolo-implement-");
    const skillBase = makeTempDir("ralph-yolo-implement-skills-");
    process.env.PI_SKILL_BASE = skillBase;
    seedSkill(skillBase, "tdd-implement");
    fs.mkdirSync(path.join(workDir, "docs", "specs"), { recursive: true });
    fs.writeFileSync(
      path.join(workDir, "docs", "specs", "todo_feature-a.md"),
      `# Implementation Tasks - feature-a

Spec: docs/specs/feature-a.md
Status: active
Version: 1

## Tasks

### TASK-0001: Yolo task
- Status: pending
- Priority: P0
- Source: hardened_spec
- Depends On: none
- Review Finding Ref: none
- Files Hint: src/extension.ts
- Created: 2026-05-23T00:00:00.000Z
- Updated: 2026-05-23T00:00:00.000Z
- Completed: none

#### Acceptance Criteria
- Task selector launches.

#### Test Plan
- Complete tasks phase.

#### Notes
- Ready.
`,
      "utf-8",
    );

    const branch: FakeEntry[] = [];
    pushState(branch, workDir, {
      phases: ["spec", "tasks", "implement", "review"],
      currentPhase: "tasks",
      currentPhaseIndex: 1,
      phaseStatus: "executing",
      yoloMode: true,
      taskFile: "docs/specs/todo_feature-a.md",
    });

    const { default: registerExtension } = await import("../index");
    const { pi, handlers, sendUserMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: `Tasks complete.\n\n${PHASE_COMPLETE_MARKER}` }],
          },
        ],
      },
      makeFakeContext(branch, workDir, { idle: true }),
    );

    const state = latestState<{
      currentPhase?: string;
      phaseStatus?: string;
      yoloMode?: boolean;
      waitingReason?: string;
    }>(branch);
    expect(state.currentPhase).toBe("implement");
    expect(state.phaseStatus).toBe("selecting_task");
    expect(state.yoloMode).toBe(true);
    expect(state.waitingReason).toBeUndefined();
    expect(sendUserMessages).toHaveLength(1);
    expect(sendUserMessages[0]?.options).toBeUndefined();
    expect(String(sendUserMessages[0]?.content)).toContain("ralph-works Task Selector");
  });

  it("launches review when the reviewer skill is installed at the global skill root", async () => {
    const workDir = makeTempDir("ralph-review-root-skill-");
    const skillBase = makeTempDir("ralph-review-root-skills-");
    process.env.PI_SKILL_BASE = skillBase;
    seedSkill(skillBase, "pr-reviewer");
    fs.mkdirSync(path.join(workDir, "docs", "specs"), { recursive: true });
    fs.writeFileSync(
      path.join(workDir, "docs", "specs", "todo_feature-a.md"),
      `# Implementation Tasks - feature-a

Spec: docs/specs/feature-a.md
Status: active
Version: 1

## Tasks

### TASK-0001: Add review launch
- Status: in_progress
- Priority: P0
- Source: hardened_spec
- Depends On: none
- Review Finding Ref: none
- Files Hint: src/extension.ts
- Created: 2026-05-23T00:00:00.000Z
- Updated: 2026-05-23T00:00:00.000Z
- Completed: none

#### Acceptance Criteria
- Review launches after task completion.

#### Test Plan
- Controller test covers task completion.

#### Notes
- Ready.
`,
      "utf-8",
    );

    const branch: FakeEntry[] = [];
    pushState(branch, workDir, {
      phases: ["tasks", "implement", "review"],
      currentPhase: "implement",
      currentPhaseIndex: 1,
      phaseStatus: "executing",
      autoClearContext: false,
      selectedTask: {
        id: "TASK-0001",
        title: "Add review launch",
        status: "in_progress",
        priority: "P0",
        source: "hardened_spec",
        dependsOn: [],
        filesHint: ["src/extension.ts"],
        acceptanceCriteria: ["Review launches after task completion."],
        testPlan: ["Controller test covers task completion."],
        createdAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:00:00.000Z",
      },
      taskFile: "docs/specs/todo_feature-a.md",
    });

    const { default: registerExtension } = await import("../index");
    const { pi, handlers, sendUserMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Implementation complete.\n\nRALPH_TASK_COMPLETE" }],
          },
        ],
      },
      makeFakeContext(branch, workDir, { idle: true }),
    );

    const state = latestState<{ currentPhase?: string; pipelineStatus?: string; phaseStatus?: string }>(branch);
    expect(state.currentPhase).toBe("review");
    expect(state.pipelineStatus).toBe("running");
    expect(state.phaseStatus).toBe("executing");
    expect(sendUserMessages).toHaveLength(1);
    expect(sendUserMessages[0]?.options).toBeUndefined();
    expect(String(sendUserMessages[0]?.content)).toContain("# pr-reviewer");
  });

  it("keeps a selected task active after passing gates until the task marker is emitted", async () => {
    const workDir = makeTempDir("ralph-implement-gate-review-");
    writePassingGateConfig(workDir);
    const skillBase = makeTempDir("ralph-implement-gate-review-skills-");
    process.env.PI_SKILL_BASE = skillBase;
    seedSkill(skillBase, "pr-reviewer");
    fs.mkdirSync(path.join(workDir, "docs", "specs"), { recursive: true });
    fs.writeFileSync(
      path.join(workDir, "docs", "specs", "todo_feature-a.md"),
      `# Implementation Tasks - feature-a

Spec: docs/specs/feature-a.md
Status: active
Version: 1

## Tasks

### TASK-0001: Add task marker enforcement
- Status: in_progress
- Priority: P0
- Source: hardened_spec
- Depends On: none
- Review Finding Ref: none
- Files Hint: src/extension.ts
- Created: 2026-05-23T00:00:00.000Z
- Updated: 2026-05-23T00:00:00.000Z
- Completed: none

#### Acceptance Criteria
- Passing gates do not bypass the task marker.

#### Test Plan
- Controller test covers gate-only completion.

#### Notes
- Ready.
`,
      "utf-8",
    );

    const branch: FakeEntry[] = [];
    pushState(branch, workDir, {
      phases: ["tasks", "implement", "review"],
      currentPhase: "implement",
      currentPhaseIndex: 1,
      phaseStatus: "executing",
      autoClearContext: false,
      selectedTask: {
        id: "TASK-0001",
        title: "Add task marker enforcement",
        status: "in_progress",
        priority: "P0",
        source: "hardened_spec",
        dependsOn: [],
        filesHint: ["src/extension.ts"],
        acceptanceCriteria: ["Passing gates do not bypass the task marker."],
        testPlan: ["Controller test covers gate-only completion."],
        createdAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:00:00.000Z",
      },
      taskFile: "docs/specs/todo_feature-a.md",
    });

    const { default: registerExtension } = await import("../index");
    const { pi, handlers, tools, sendUserMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    const ctx = makeFakeContext(branch, workDir, { idle: true });
    const gateResult = (await tools.get("ralph_gate_check")?.execute("gate-1", {}, undefined, vi.fn(), ctx)) as {
      details?: { allPass?: boolean };
    };
    expect(gateResult.details?.allPass).toBe(true);

    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Implementation complete and gates pass." }],
          },
        ],
      },
      ctx,
    );

    const state = latestState<{ currentPhase?: string; phaseStatus?: string; readyToAdvancePhase?: string }>(branch);
    expect(state.currentPhase).toBe("implement");
    expect(state.phaseStatus).toBe("executing");
    expect(state.readyToAdvancePhase).toBeUndefined();
    expect(sendUserMessages).toHaveLength(1);
    expect(String(sendUserMessages[0]?.content)).toContain("RALPH_TASK_COMPLETE");
  });

  it("keeps the selected task in progress when task completion gates fail", async () => {
    const workDir = makeTempDir("ralph-implement-invalid-gate-");
    fs.mkdirSync(path.join(workDir, ".ralph"), { recursive: true });
    fs.writeFileSync(
      path.join(workDir, ".ralph", "gate-config.json"),
      JSON.stringify({
        version: "1.0",
        name: "invalid-gates",
        gates: [{ name: "Injected", command: "tsc; cat /etc/passwd" }],
      }),
      "utf-8",
    );
    fs.mkdirSync(path.join(workDir, "docs", "specs"), { recursive: true });
    fs.writeFileSync(
      path.join(workDir, "docs", "specs", "todo_feature-a.md"),
      `# Implementation Tasks - feature-a

Spec: docs/specs/feature-a.md
Status: active
Version: 1

## Tasks

### TASK-0001: Enforce invalid gate handling
- Status: in_progress
- Priority: P0
- Source: hardened_spec
- Depends On: none
- Review Finding Ref: none
- Files Hint: src/extension.ts
- Created: 2026-05-23T00:00:00.000Z
- Updated: 2026-05-23T00:00:00.000Z
- Completed: none

#### Acceptance Criteria
- Invalid gates prevent task completion.

#### Test Plan
- Controller test covers invalid gate config.

#### Notes
- Ready.
`,
      "utf-8",
    );
    const branch: FakeEntry[] = [];
    pushState(branch, workDir, {
      phases: ["tasks", "implement", "review"],
      currentPhase: "implement",
      currentPhaseIndex: 1,
      phaseStatus: "executing",
      phaseAttempts: 0,
      selectedTask: {
        id: "TASK-0001",
        title: "Enforce invalid gate handling",
        status: "in_progress",
        priority: "P0",
        source: "hardened_spec",
        dependsOn: [],
        filesHint: ["src/extension.ts"],
        acceptanceCriteria: ["Invalid gates prevent task completion."],
        testPlan: ["Controller test covers invalid gate config."],
        createdAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:00:00.000Z",
      },
      taskFile: "docs/specs/todo_feature-a.md",
    });

    const { default: registerExtension } = await import("../index");
    const { pi, handlers, sendUserMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    const ctx = makeFakeContext(branch, workDir, { idle: true });
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Implementation complete.\n\nRALPH_TASK_COMPLETE" }],
          },
        ],
      },
      ctx,
    );

    const state = latestState<{ currentPhase?: string; phaseStatus?: string; phaseAttempts?: number }>(branch);
    expect(state.currentPhase).toBe("implement");
    expect(state.phaseStatus).toBe("executing");
    expect(state.phaseAttempts).toBe(0);
    expect(sendUserMessages).toHaveLength(1);
    expect(String(sendUserMessages[0]?.content)).toContain("Gate Configuration");
    expect(String(sendUserMessages[0]?.content)).toContain("Unsafe gate command");
    const ledger = fs.readFileSync(path.join(workDir, "docs", "specs", "todo_feature-a.md"), "utf-8");
    expect(ledger).toContain("- Status: in_progress");
    expect(ledger).toContain("- Completed: none");
  });

  it("reruns post-hook validation from validation_failed on /ralph-works continue", async () => {
    const workDir = makeTempDir("ralph-continue-validation-failed-");
    fs.mkdirSync(path.join(workDir, ".ralph"), { recursive: true });
    fs.writeFileSync(
      path.join(workDir, ".ralph", "gate-config.json"),
      JSON.stringify({
        version: "1.0",
        name: "invalid-gates",
        gates: [{ name: "Injected", command: "tsc; cat /etc/passwd" }],
      }),
      "utf-8",
    );
    const skillBase = makeTempDir("ralph-continue-validation-failed-skills-");
    process.env.PI_SKILL_BASE = skillBase;
    seedSkill(skillBase, "tdd-implement");

    const branch: FakeEntry[] = [];
    pushState(branch, workDir, {
      phases: ["implement", "review"],
      currentPhase: "implement",
      currentPhaseIndex: 0,
      phaseStatus: "validation_failed",
      phaseAttempts: 1,
      lastValidationFailure: "Previous gate configuration failure",
    });

    const { default: registerExtension } = await import("../index");
    const { pi, commands, sendUserMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    await commands.get("ralph-works")?.("continue", makeFakeContext(branch, workDir, { idle: true }));

    const state = latestState<{ currentPhase?: string; phaseStatus?: string; phaseAttempts?: number }>(branch);
    expect(state.currentPhase).toBe("implement");
    expect(state.phaseStatus).toBe("validation_failed");
    expect(state.phaseAttempts).toBe(2);
    expect(sendUserMessages).toHaveLength(1);
    expect(String(sendUserMessages[0]?.content)).toContain("Phase validation failed");
    expect(String(sendUserMessages[0]?.content)).toContain("Unsafe gate command");
    expect(String(sendUserMessages[0]?.content)).not.toContain("Phase: TDD Implement");
  });

  it("keeps implement running and steers toward documented manual tests when no gates are configured", async () => {
    const workDir = makeTempDir("ralph-implement-missing-gate-");
    const branch: FakeEntry[] = [];
    pushState(branch, workDir, {
      phases: ["implement", "review"],
      currentPhase: "implement",
      currentPhaseIndex: 0,
      phaseStatus: "executing",
      readyToAdvancePhase: undefined,
    });

    const { default: registerExtension } = await import("../index");
    const { pi, handlers, sendUserMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    const ctx = makeFakeContext(branch, workDir);
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Implementation is complete; tests passed." }],
          },
        ],
      },
      ctx,
    );

    const state = latestState<{ currentPhase?: string; phaseStatus?: string }>(branch);
    expect(state.currentPhase).toBe("implement");
    expect(state.phaseStatus).toBe("executing");
    expect(sendUserMessages).toHaveLength(1);
    expect(sendUserMessages[0]?.options?.deliverAs).toBe("steer");
    expect(String(sendUserMessages[0]?.content)).toContain("ralph-works gates are not configured");
    expect(String(sendUserMessages[0]?.content)).toContain("documented test commands manually");
    expect(ctx.ui.setWorkingMessage).not.toHaveBeenCalledWith("Waiting for user input");
  });

  it("completes review when the assistant reports no critical bugs without calling the decision tool", async () => {
    const workDir = makeTempDir("ralph-review-text-lgtm-");
    const branch: FakeEntry[] = [];
    pushState(branch, workDir, {
      phases: ["implement", "review"],
      currentPhase: "review",
      currentPhaseIndex: 1,
      phaseStatus: "executing",
    });

    const { default: registerExtension } = await import("../index");
    const { pi, handlers } = makeFakePi(branch);
    registerExtension(pi as any);

    const ctx = makeFakeContext(branch, workDir);
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "LGTM. No critical bugs found." }],
          },
        ],
      },
      ctx,
    );

    const state = latestState<{ pipelineStatus?: string; phaseStatus?: string }>(branch);
    expect(state.pipelineStatus).toBe("completed");
    expect(state.phaseStatus).toBe("post_hook");
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("ralph-loop", undefined);
    const widgetText = (ctx.ui.setWidget.mock.calls.at(-1)?.[1] as string[]).join("\n");
    expect(stripAnsi(widgetText)).toContain("ralph-works · COMPLETE");
    expect(widgetText).toContain("✓ 2/2 ralph-works Review Loop");
    expect(widgetText).toContain("[✓ ✓]");
    expect(ctx.ui.setWorkingMessage).not.toHaveBeenCalledWith("Waiting for user input");
  });

  it("rejects review decisions made outside the review phase", async () => {
    const workDir = makeTempDir("ralph-review-reject-");
    const branch: FakeEntry[] = [];
    pushState(branch, workDir, {
      phases: ["implement", "review"],
      currentPhase: "implement",
      currentPhaseIndex: 0,
    });

    const { default: registerExtension } = await import("../index");
    const { pi, tools } = makeFakePi(branch);
    registerExtension(pi as any);

    const result = (await tools
      .get("ralph_review_decision")
      ?.execute("review-1", { status: "LGTM" }, undefined, vi.fn(), makeFakeContext(branch, workDir))) as {
      content?: Array<{ text?: string }>;
    };

    expect(result.content?.[0]?.text).toContain("can only be called during review phase");
    expect(latestState<{ currentPhase?: string }>(branch).currentPhase).toBe("implement");
  });

  it("converts critical review decisions into ledger tasks and resumes the task selector", async () => {
    const workDir = makeTempDir("ralph-review-critical-");
    const skillBase = makeTempDir("ralph-review-skills-");
    process.env.PI_SKILL_BASE = skillBase;
    seedSkill(skillBase, "tdd-implement");
    fs.mkdirSync(path.join(workDir, "docs", "specs"), { recursive: true });
    fs.writeFileSync(
      path.join(workDir, "docs", "specs", "todo_feature-a.md"),
      `# Implementation Tasks - feature-a

Spec: docs/specs/feature-a.md
Status: active
Version: 1

## Tasks

### TASK-0001: Existing completed task
- Status: complete
- Priority: P0
- Source: hardened_spec
- Depends On: none
- Review Finding Ref: none
- Files Hint: src/domain.ts
- Created: 2026-05-23T00:00:00.000Z
- Updated: 2026-05-23T00:00:00.000Z
- Completed: 2026-05-23T00:01:00.000Z

#### Acceptance Criteria
- Existing behavior works.

#### Test Plan
- Existing test passes.

#### Notes
- Done.
`,
      "utf-8",
    );

    const branch: FakeEntry[] = [];
    pushState(branch, workDir, {
      phases: ["tasks", "implement", "review"],
      currentPhase: "review",
      currentPhaseIndex: 2,
      reviewIterations: 0,
      taskFile: "docs/specs/todo_feature-a.md",
    });

    const { default: registerExtension } = await import("../index");
    const { pi, tools, sendUserMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    await tools
      .get("ralph_review_decision")
      ?.execute(
        "review-1",
        { status: "CRITICAL", issues: ["Missing auth boundary test"] },
        undefined,
        vi.fn(),
        makeFakeContext(branch, workDir),
      );

    const state = latestState<{
      currentPhase?: string;
      currentPhaseIndex?: number;
      phaseStatus?: string;
      reviewIterations?: number;
    }>(branch);
    expect(state.currentPhase).toBe("implement");
    expect(state.currentPhaseIndex).toBe(1);
    expect(state.phaseStatus).toBe("selecting_task");
    expect(state.reviewIterations).toBe(1);
    expect(sendUserMessages).toHaveLength(1);
    expect(String(sendUserMessages[0]?.content)).toContain("ralph-works Task Selector");
    expect(String(sendUserMessages[0]?.content)).toContain("Missing auth boundary test");
    const ledger = fs.readFileSync(path.join(workDir, "docs", "specs", "todo_feature-a.md"), "utf-8");
    expect(ledger).toContain("### TASK-0002: Missing auth boundary test");
    expect(ledger).toContain("- Source: review_critical");
    expect(ledger).toContain("- Review Finding Ref: review-1 issue-1");
  });

  it("accepts a selected task marker, marks the ledger in progress, and launches scoped TDD", async () => {
    const workDir = makeTempDir("ralph-selected-task-");
    const skillBase = makeTempDir("ralph-selected-task-skills-");
    process.env.PI_SKILL_BASE = skillBase;
    seedSkill(skillBase, "tdd-implement");

    fs.mkdirSync(path.join(workDir, "docs", "specs"), { recursive: true });
    fs.writeFileSync(
      path.join(workDir, "docs", "specs", "todo_feature-a.md"),
      `# Implementation Tasks - feature-a

Spec: docs/specs/feature-a.md
Status: active
Version: 1

## Tasks

### TASK-0001: Add selected task state
- Status: pending
- Priority: P0
- Source: hardened_spec
- Depends On: none
- Review Finding Ref: none
- Files Hint: src/domain.ts
- Created: 2026-05-23T00:00:00.000Z
- Updated: 2026-05-23T00:00:00.000Z
- Completed: none

#### Acceptance Criteria
- PipelineState persists selectedTask.

#### Test Plan
- Unit test selected task serialization.

#### Notes
- Ready.
`,
      "utf-8",
    );

    const branch: FakeEntry[] = [];
    pushState(branch, workDir, {
      phases: ["tasks", "implement", "review"],
      currentPhase: "implement",
      currentPhaseIndex: 1,
      phaseStatus: "selecting_task",
      taskFile: "docs/specs/todo_feature-a.md",
    });

    const { default: registerExtension } = await import("../index");
    const { pi, handlers, sendUserMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    await handlers.get("agent_end")?.(
      {
        messages: [{ role: "assistant", content: [{ type: "text", text: "RALPH_SELECTED_TASK TASK-0001" }] }],
      },
      makeFakeContext(branch, workDir, { idle: true }),
    );

    const state = latestState<{ selectedTask?: { id?: string }; phaseStatus?: string }>(branch);
    expect(state.selectedTask?.id).toBe("TASK-0001");
    expect(state.phaseStatus).toBe("executing");
    expect(fs.readFileSync(path.join(workDir, "docs", "specs", "todo_feature-a.md"), "utf-8")).toContain(
      "- Status: in_progress",
    );
    expect(String(sendUserMessages.at(-1)?.content)).toContain("## Selected Task");
    expect(String(sendUserMessages.at(-1)?.content)).toContain("id: TASK-0001");
  });

  it("does not trust a no-tasks marker when pending eligible tasks remain in the ledger", async () => {
    const workDir = makeTempDir("ralph-no-tasks-guard-");
    const skillBase = makeTempDir("ralph-no-tasks-guard-skills-");
    process.env.PI_SKILL_BASE = skillBase;
    seedSkill(skillBase, "pi-skills/pr-reviewer");

    fs.mkdirSync(path.join(workDir, "docs", "specs"), { recursive: true });
    fs.writeFileSync(
      path.join(workDir, "docs", "specs", "todo_feature-a.md"),
      `# Implementation Tasks - feature-a

Spec: docs/specs/feature-a.md
Status: active
Version: 1

## Tasks

### TASK-0001: Add selected task state
- Status: pending
- Priority: P0
- Source: hardened_spec
- Depends On: none
- Review Finding Ref: none
- Files Hint: src/domain.ts
- Created: 2026-05-23T00:00:00.000Z
- Updated: 2026-05-23T00:00:00.000Z
- Completed: none

#### Acceptance Criteria
- PipelineState persists selectedTask.

#### Test Plan
- Unit test selected task serialization.

#### Notes
- Ready.
`,
      "utf-8",
    );

    const branch: FakeEntry[] = [];
    pushState(branch, workDir, {
      phases: ["tasks", "implement", "review"],
      currentPhase: "implement",
      currentPhaseIndex: 1,
      phaseStatus: "selecting_task",
      taskFile: "docs/specs/todo_feature-a.md",
    });

    const { default: registerExtension } = await import("../index");
    const { pi, handlers, sendUserMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    await handlers.get("agent_end")?.(
      {
        messages: [{ role: "assistant", content: [{ type: "text", text: "RALPH_NO_TASKS_REMAIN" }] }],
      },
      makeFakeContext(branch, workDir, { idle: true }),
    );

    const state = latestState<{ currentPhase?: string; phaseStatus?: string }>(branch);
    expect(state.currentPhase).toBe("implement");
    expect(state.phaseStatus).toBe("selecting_task");
    expect(String(sendUserMessages.at(-1)?.content)).toContain("TASK-0001 is still eligible");
  });

  it("rejects a selected task marker when it is not the highest-priority eligible task", async () => {
    const workDir = makeTempDir("ralph-selector-priority-");
    const skillBase = makeTempDir("ralph-selector-priority-skills-");
    process.env.PI_SKILL_BASE = skillBase;
    seedSkill(skillBase, "tdd-implement");

    fs.mkdirSync(path.join(workDir, "docs", "specs"), { recursive: true });
    fs.writeFileSync(
      path.join(workDir, "docs", "specs", "todo_feature-a.md"),
      `# Implementation Tasks - feature-a

Spec: docs/specs/feature-a.md
Status: active
Version: 1

## Tasks

### TASK-0001: Add controller state
- Status: pending
- Priority: P0
- Source: hardened_spec
- Depends On: none
- Review Finding Ref: none
- Files Hint: src/domain.ts
- Created: 2026-05-23T00:00:00.000Z
- Updated: 2026-05-23T00:00:00.000Z
- Completed: none

#### Acceptance Criteria
- Controller state is persisted.

#### Test Plan
- Unit test state persistence.

#### Notes
- Ready.

### TASK-0002: Add docs
- Status: pending
- Priority: P2
- Source: hardened_spec
- Depends On: none
- Review Finding Ref: none
- Files Hint: README.md
- Created: 2026-05-23T00:00:00.000Z
- Updated: 2026-05-23T00:00:00.000Z
- Completed: none

#### Acceptance Criteria
- README describes the task loop.

#### Test Plan
- Documentation review.

#### Notes
- Later.
`,
      "utf-8",
    );

    const branch: FakeEntry[] = [];
    pushState(branch, workDir, {
      phases: ["tasks", "implement", "review"],
      currentPhase: "implement",
      currentPhaseIndex: 1,
      phaseStatus: "selecting_task",
      taskFile: "docs/specs/todo_feature-a.md",
    });

    const { default: registerExtension } = await import("../index");
    const { pi, handlers, sendUserMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    await handlers.get("agent_end")?.(
      {
        messages: [{ role: "assistant", content: [{ type: "text", text: "RALPH_SELECTED_TASK TASK-0002" }] }],
      },
      makeFakeContext(branch, workDir, { idle: true }),
    );

    const state = latestState<{ currentPhase?: string; phaseStatus?: string; selectedTask?: unknown }>(branch);
    expect(state.currentPhase).toBe("implement");
    expect(state.phaseStatus).toBe("selecting_task");
    expect(state.selectedTask).toBeUndefined();
    expect(String(sendUserMessages.at(-1)?.content)).toContain("Expected selector to choose TASK-0001");
  });

  it("marks a task complete and advances to review when no tasks remain", async () => {
    const workDir = makeTempDir("ralph-task-complete-");
    const skillBase = makeTempDir("ralph-task-complete-skills-");
    process.env.PI_SKILL_BASE = skillBase;
    seedSkill(skillBase, "pi-skills/pr-reviewer");

    fs.mkdirSync(path.join(workDir, "docs", "specs"), { recursive: true });
    fs.writeFileSync(
      path.join(workDir, "docs", "specs", "todo_feature-a.md"),
      `# Implementation Tasks - feature-a

Spec: docs/specs/feature-a.md
Status: active
Version: 1

## Tasks

### TASK-0001: Add selected task state
- Status: in_progress
- Priority: P0
- Source: hardened_spec
- Depends On: none
- Review Finding Ref: none
- Files Hint: src/domain.ts
- Created: 2026-05-23T00:00:00.000Z
- Updated: 2026-05-23T00:00:00.000Z
- Completed: none

#### Acceptance Criteria
- PipelineState persists selectedTask.

#### Test Plan
- Unit test selected task serialization.

#### Notes
- Ready.
`,
      "utf-8",
    );

    const branch: FakeEntry[] = [];
    pushState(branch, workDir, {
      phases: ["tasks", "implement", "review"],
      currentPhase: "implement",
      currentPhaseIndex: 1,
      selectedTask: {
        id: "TASK-0001",
        title: "Add selected task state",
        status: "in_progress",
        priority: "P0",
        source: "hardened_spec",
        dependsOn: [],
        filesHint: ["src/domain.ts"],
        acceptanceCriteria: ["PipelineState persists selectedTask."],
        testPlan: ["Unit test selected task serialization."],
        createdAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:00:00.000Z",
      },
      taskFile: "docs/specs/todo_feature-a.md",
    });

    const { default: registerExtension } = await import("../index");
    const { pi, handlers, sendUserMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    await handlers.get("agent_end")?.(
      {
        messages: [{ role: "assistant", content: [{ type: "text", text: "done\nRALPH_TASK_COMPLETE" }] }],
      },
      makeFakeContext(branch, workDir, { idle: true }),
    );

    const state = latestState<{ currentPhase?: string; selectedTask?: unknown }>(branch);
    expect(state.currentPhase).toBe("review");
    expect(state.selectedTask).toBeUndefined();
    const ledger = fs.readFileSync(path.join(workDir, "docs", "specs", "todo_feature-a.md"), "utf-8");
    expect(ledger).toContain("- Status: complete");
    expect(ledger).toMatch(/- Completed: 20\d\d-/);
    expect(String(sendUserMessages.at(-1)?.content)).toContain("Phase: ralph-works Review Loop");
  });

  it("rejects the legacy phase completion marker while a selected implementation task is active", async () => {
    const workDir = makeTempDir("ralph-task-phase-marker-");
    const skillBase = makeTempDir("ralph-task-phase-marker-skills-");
    process.env.PI_SKILL_BASE = skillBase;
    seedSkill(skillBase, "pi-skills/pr-reviewer");

    fs.mkdirSync(path.join(workDir, "docs", "specs"), { recursive: true });
    fs.writeFileSync(
      path.join(workDir, "docs", "specs", "todo_feature-a.md"),
      `# Implementation Tasks - feature-a

Spec: docs/specs/feature-a.md
Status: active
Version: 1

## Tasks

### TASK-0001: Add selected task state
- Status: in_progress
- Priority: P0
- Source: hardened_spec
- Depends On: none
- Review Finding Ref: none
- Files Hint: src/domain.ts
- Created: 2026-05-23T00:00:00.000Z
- Updated: 2026-05-23T00:00:00.000Z
- Completed: none

#### Acceptance Criteria
- PipelineState persists selectedTask.

#### Test Plan
- Unit test selected task serialization.

#### Notes
- Ready.
`,
      "utf-8",
    );

    const branch: FakeEntry[] = [];
    pushState(branch, workDir, {
      phases: ["tasks", "implement", "review"],
      currentPhase: "implement",
      currentPhaseIndex: 1,
      phaseStatus: "executing",
      selectedTask: {
        id: "TASK-0001",
        title: "Add selected task state",
        status: "in_progress",
        priority: "P0",
        source: "hardened_spec",
        dependsOn: [],
        filesHint: ["src/domain.ts"],
        acceptanceCriteria: ["PipelineState persists selectedTask."],
        testPlan: ["Unit test selected task serialization."],
        createdAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:00:00.000Z",
      },
      taskFile: "docs/specs/todo_feature-a.md",
    });

    const { default: registerExtension } = await import("../index");
    const { pi, handlers, sendUserMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: `Implementation complete.\n\n${PHASE_COMPLETE_MARKER}` }],
          },
        ],
      },
      makeFakeContext(branch, workDir, { idle: true }),
    );

    const state = latestState<{ currentPhase?: string; phaseStatus?: string; selectedTask?: { id?: string } }>(branch);
    expect(state.currentPhase).toBe("implement");
    expect(state.phaseStatus).toBe("executing");
    expect(state.selectedTask?.id).toBe("TASK-0001");
    expect(String(sendUserMessages.at(-1)?.content)).toContain("Use RALPH_TASK_COMPLETE");
  });

  it("marks a blocked task and selects the next eligible task", async () => {
    const workDir = makeTempDir("ralph-task-blocked-");
    fs.mkdirSync(path.join(workDir, "docs", "specs"), { recursive: true });
    fs.writeFileSync(
      path.join(workDir, "docs", "specs", "todo_feature-a.md"),
      `# Implementation Tasks - feature-a

Spec: docs/specs/feature-a.md
Status: active
Version: 1

## Tasks

### TASK-0001: Integrate external dependency
- Status: in_progress
- Priority: P0
- Source: hardened_spec
- Depends On: none
- Review Finding Ref: none
- Files Hint: src/integration.ts
- Created: 2026-05-23T00:00:00.000Z
- Updated: 2026-05-23T00:00:00.000Z
- Completed: none

#### Acceptance Criteria
- Integration has required credentials.

#### Test Plan
- Run integration test.

#### Notes
- Waiting on credentials.

### TASK-0002: Add local fallback
- Status: pending
- Priority: P1
- Source: hardened_spec
- Depends On: none
- Review Finding Ref: none
- Files Hint: src/fallback.ts
- Created: 2026-05-23T00:00:00.000Z
- Updated: 2026-05-23T00:00:00.000Z
- Completed: none

#### Acceptance Criteria
- Fallback path is available.

#### Test Plan
- Unit test fallback path.

#### Notes
- Ready.
`,
      "utf-8",
    );

    const branch: FakeEntry[] = [];
    pushState(branch, workDir, {
      phases: ["tasks", "implement", "review"],
      currentPhase: "implement",
      currentPhaseIndex: 1,
      selectedTask: {
        id: "TASK-0001",
        title: "Integrate external dependency",
        status: "in_progress",
        priority: "P0",
        source: "hardened_spec",
        dependsOn: [],
        filesHint: ["src/integration.ts"],
        acceptanceCriteria: ["Integration has required credentials."],
        testPlan: ["Run integration test."],
        createdAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:00:00.000Z",
      },
      taskFile: "docs/specs/todo_feature-a.md",
    });

    const { default: registerExtension } = await import("../index");
    const { pi, handlers, sendUserMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    await handlers.get("agent_end")?.(
      {
        messages: [{ role: "assistant", content: [{ type: "text", text: "blocked\nRALPH_TASK_BLOCKED" }] }],
      },
      makeFakeContext(branch, workDir, { idle: true }),
    );

    const state = latestState<{ currentPhase?: string; phaseStatus?: string; selectedTask?: unknown }>(branch);
    expect(state.currentPhase).toBe("implement");
    expect(state.phaseStatus).toBe("selecting_task");
    expect(state.selectedTask).toBeUndefined();
    const ledger = fs.readFileSync(path.join(workDir, "docs", "specs", "todo_feature-a.md"), "utf-8");
    expect(ledger).toContain("- Status: blocked");
    expect(String(sendUserMessages.at(-1)?.content)).toContain("RALPH_SELECTED_TASK TASK-0001");
    expect(String(sendUserMessages.at(-1)?.content)).toContain("TASK-0002: Add local fallback");
  });

  it("auto-compacts after a completed task before selecting the next task", async () => {
    const workDir = makeTempDir("ralph-task-loop-compact-");
    fs.mkdirSync(path.join(workDir, "docs", "specs"), { recursive: true });
    fs.writeFileSync(
      path.join(workDir, "docs", "specs", "todo_feature-a.md"),
      `# Implementation Tasks - feature-a

Spec: docs/specs/feature-a.md
Status: active
Version: 1

## Tasks

### TASK-0001: Finish first task
- Status: in_progress
- Priority: P0
- Source: hardened_spec
- Depends On: none
- Review Finding Ref: none
- Files Hint: src/first.ts
- Created: 2026-05-23T00:00:00.000Z
- Updated: 2026-05-23T00:00:00.000Z
- Completed: none

#### Acceptance Criteria
- First task is complete.

#### Test Plan
- Unit test first task.

#### Notes
- Ready.

### TASK-0002: Start second task
- Status: pending
- Priority: P1
- Source: hardened_spec
- Depends On: TASK-0001
- Review Finding Ref: none
- Files Hint: src/second.ts
- Created: 2026-05-23T00:00:00.000Z
- Updated: 2026-05-23T00:00:00.000Z
- Completed: none

#### Acceptance Criteria
- Second task is selected after compaction.

#### Test Plan
- Unit test second task.

#### Notes
- Ready.
`,
      "utf-8",
    );

    const branch: FakeEntry[] = [];
    pushState(branch, workDir, {
      phases: ["tasks", "implement", "review"],
      currentPhase: "implement",
      currentPhaseIndex: 1,
      selectedTask: {
        id: "TASK-0001",
        title: "Finish first task",
        status: "in_progress",
        priority: "P0",
        source: "hardened_spec",
        dependsOn: [],
        filesHint: ["src/first.ts"],
        acceptanceCriteria: ["First task is complete."],
        testPlan: ["Unit test first task."],
        createdAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:00:00.000Z",
      },
      taskFile: "docs/specs/todo_feature-a.md",
      autoClearContext: true,
    });

    const { default: registerExtension } = await import("../index");
    const { pi, handlers, sendUserMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    const ctx = makeFakeContext(branch, workDir, { idle: true });
    await handlers.get("agent_end")?.(
      {
        messages: [{ role: "assistant", content: [{ type: "text", text: "done\nRALPH_TASK_COMPLETE" }] }],
      },
      ctx,
    );

    expect(ctx.compact).toHaveBeenCalledTimes(1);
    expect(sendUserMessages).toHaveLength(0);

    const compactOptions = ctx.compact.mock.calls[0]?.[0] as { onComplete?: () => void };
    compactOptions.onComplete?.();

    expect(sendUserMessages).toHaveLength(1);
    expect(String(sendUserMessages[0]?.content)).toContain("CONTEXT RESET");
    expect(String(sendUserMessages[0]?.content)).toContain("TASK-0002: Start second task");
  });

  it("completes the pipeline on LGTM review decisions", async () => {
    const workDir = makeTempDir("ralph-review-lgtm-");
    const branch: FakeEntry[] = [];
    pushState(branch, workDir, {
      phases: ["implement", "review"],
      currentPhase: "review",
      currentPhaseIndex: 1,
    });

    const { default: registerExtension } = await import("../index");
    const { pi, tools } = makeFakePi(branch);
    registerExtension(pi as any);

    const ctx = makeFakeContext(branch, workDir);
    await tools.get("ralph_review_decision")?.execute("review-1", { status: "LGTM" }, undefined, vi.fn(), ctx);

    const state = latestState<{ pipelineStatus?: string; phaseStatus?: string }>(branch);
    expect(state.pipelineStatus).toBe("completed");
    expect(state.phaseStatus).toBe("post_hook");
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("ralph-loop", undefined);
    const widgetText = (ctx.ui.setWidget.mock.calls.at(-1)?.[1] as string[]).join("\n");
    expect(stripAnsi(widgetText)).toContain("ralph-works · COMPLETE");
    expect(widgetText).toContain("✓ 2/2 ralph-works Review Loop");
    expect(widgetText).toContain("[✓ ✓]");
  });

  it("fails a phase after repeated post-hook validation failures", async () => {
    const workDir = makeTempDir("ralph-posthook-limit-");
    const branch: FakeEntry[] = [];
    pushState(branch, workDir, {
      phases: ["redteam"],
      currentPhase: "redteam",
      currentPhaseIndex: 0,
      phaseAttempts: 3,
    });

    const { default: registerExtension } = await import("../index");
    const { pi, handlers, sendUserMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: `Audit done.\n\n${PHASE_COMPLETE_MARKER}` }],
          },
        ],
      },
      makeFakeContext(branch, workDir),
    );

    const state = latestState<{ pipelineStatus?: string; phaseStatus?: string }>(branch);
    expect(state.pipelineStatus).toBe("failed");
    expect(state.phaseStatus).toBe("post_hook");
    expect(sendUserMessages).toHaveLength(0);
  });
});
