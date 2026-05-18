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
  const tools = new Map<string, FakeTool>();
  const sendUserMessages: Array<{ content: unknown; options?: { deliverAs?: string } }> = [];

  const pi = {
    on(event: string, handler: (event: any, ctx: any) => unknown): void {
      handlers.set(event, handler);
    },
    registerTool(tool: { name: string; execute: (...args: any[]) => unknown }): void {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, config: { handler: (args: string, ctx: any) => unknown }): void {
      commands.set(name, config.handler);
    },
    appendEntry(customType: string, data?: unknown): void {
      branch.push({ type: "custom", customType, data });
    },
    sendUserMessage(content: unknown, options?: { deliverAs?: string }): void {
      sendUserMessages.push({ content, options });
    },
  };

  return { pi, handlers, commands, tools, sendUserMessages };
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

function seedSkill(skillBase: string, skillName: string): void {
  const dir = path.join(skillBase, skillName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `# ${skillName}`, "utf-8");
}

function seedDefaultPhaseSkills(skillBase: string): void {
  seedSkill(skillBase, "generate-spec");
  seedSkill(skillBase, "red-team-audit");
  seedSkill(skillBase, "harden-spec");
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

describe("/ralph start command", () => {
  it("opts users out of HTML rendering for default starts", async () => {
    const workDir = makeTempDir("ralph-default-no-render-");
    const skillBase = makeTempDir("ralph-default-no-render-skills-");
    process.env.PI_SKILL_BASE = skillBase;
    seedSkill(skillBase, "generate-spec");
    seedSkill(skillBase, "red-team-audit");
    seedSkill(skillBase, "harden-spec");
    seedSkill(skillBase, "tdd-implement");
    seedSkill(skillBase, "pi-skills/pr-reviewer");

    const branch: FakeEntry[] = [];
    const { default: registerExtension } = await import("../index");
    const { pi, commands, sendUserMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    await commands.get("ralph")?.("start feature-a", makeFakeContext(branch, workDir));

    const state = latestState<{ promptText?: string; phases?: string[]; currentPhase?: string }>(branch);
    expect(state.phases).toEqual(["spec", "redteam", "harden", "implement", "review"]);
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
    seedSkill(skillBase, "markdown-to-html");
    seedSkill(skillBase, "tdd-implement");
    seedSkill(skillBase, "pi-skills/pr-reviewer");

    const branch: FakeEntry[] = [];
    const { default: registerExtension } = await import("../index");
    const { pi, commands, sendUserMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    await commands.get("ralph")?.("start feature-a --render-html", makeFakeContext(branch, workDir));

    const state = latestState<{ promptText?: string; phases?: string[]; currentPhase?: string }>(branch);
    expect(state.phases).toEqual(["spec", "redteam", "harden", "render", "implement", "review"]);
    expect(state.currentPhase).toBe("spec");
    expect(state.promptText).toBeUndefined();
    expect(sendUserMessages).toHaveLength(1);
  });

  it("tells implement agents to call the registered gate tool instead of running a shell command", async () => {
    const workDir = makeTempDir("ralph-implement-tool-prompt-");
    const skillBase = makeTempDir("ralph-implement-tool-prompt-skills-");
    process.env.PI_SKILL_BASE = skillBase;
    seedSkill(skillBase, "tdd-implement");

    const branch: FakeEntry[] = [];
    const { default: registerExtension } = await import("../index");
    const { pi, commands, sendUserMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    await commands.get("ralph")?.("start feature-a implement", makeFakeContext(branch, workDir));

    expect(sendUserMessages).toHaveLength(1);
    expect(String(sendUserMessages[0]?.content)).toContain("Call the registered `ralph_gate_check` tool");
    expect(String(sendUserMessages[0]?.content)).toContain("Do not run `ralph_gate_check` in `bash`");
  });

  it("persists yolo mode from the start command", async () => {
    const workDir = makeTempDir("ralph-start-yolo-");
    const skillBase = makeTempDir("ralph-start-yolo-skills-");
    process.env.PI_SKILL_BASE = skillBase;
    seedSkill(skillBase, "generate-spec");
    seedSkill(skillBase, "red-team-audit");
    seedSkill(skillBase, "harden-spec");
    seedSkill(skillBase, "tdd-implement");
    seedSkill(skillBase, "pi-skills/pr-reviewer");

    const branch: FakeEntry[] = [];
    const { default: registerExtension } = await import("../index");
    const { pi, commands, sendUserMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    await commands.get("ralph")?.("start feature-a --yolo", makeFakeContext(branch, workDir));

    const state = latestState<{ yoloMode?: boolean; phases?: string[]; promptText?: string }>(branch);
    expect(state.yoloMode).toBe(true);
    expect(state.phases).toEqual(["spec", "redteam", "harden", "implement", "review"]);
    expect(state.promptText).toBeUndefined();
    expect(sendUserMessages).toHaveLength(1);
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

    const ralph = commands.get("ralph");
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

    await commands.get("ralph")?.(
      'start hello-world "Write a hello world script in python"',
      makeFakeContext(branch, workDir),
    );

    const state = latestState<{ promptText?: string; phases?: string[] }>(branch);
    expect(state.promptText).toBe("Write a hello world script in python");
    expect(state.phases).toEqual(["spec", "redteam", "harden", "implement", "review"]);
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

    await commands.get("ralph")?.(
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

      await commands.get("ralph")?.(`start feature-a ${promptFile.fileName} spec`, makeFakeContext(branch, workDir));

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
    await outsidePi.commands.get("ralph")?.(
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

    await sensitivePi.commands.get("ralph")?.("start feature-b .env spec", makeFakeContext(sensitiveBranch, workDir));

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
    await commands.get("ralph")?.("start feature-a spec,redteam", ctx);

    expect(branch).toHaveLength(0);
    expect(sendUserMessages).toHaveLength(0);
    expect(fs.existsSync(path.join(workDir, ".ralph", "pipeline-lock-feature-a"))).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Missing Ralph phase skill prerequisites"),
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
    await commands.get("ralph")?.("start feature-a review", ctx);

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
    await commands.get("ralph")?.("start another-feature", ctx);

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
    await commands.get("ralph")?.("status", ctx);

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
    await commands.get("ralph")?.("cancel", ctx);
    await commands.get("ralph")?.("start feature-b spec", ctx);

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
    await commands.get("ralph")?.("cancel", ctx);
    await commands.get("ralph")?.("start feature-a spec", ctx);
    await commands.get("ralph")?.("cancel", ctx);
    await commands.get("ralph")?.("start feature-a spec", ctx);

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
});

describe("gate tool and auto-gate paths", () => {
  it("resets the consecutive write counter after auto-gating on the threshold write", async () => {
    const workDir = makeTempDir("ralph-autogate-work-");
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
      details?: { allPass?: boolean };
    };

    expect(result.details?.allPass).toBe(true);
    expect(onUpdate).toHaveBeenCalled();
    expect(latestState<{ turnWriteCount?: number }>(branch).turnWriteCount).toBe(0);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("ralph-loop", "✅ Gates clear");
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
  });

  it("lets yolo mode proceed directly from planning into implementation", async () => {
    const workDir = makeTempDir("ralph-yolo-implement-");
    const skillBase = makeTempDir("ralph-yolo-implement-skills-");
    process.env.PI_SKILL_BASE = skillBase;
    seedSkill(skillBase, "tdd-implement");
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
      yoloMode: true,
    });

    const { default: registerExtension } = await import("../index");
    const { pi, handlers, sendUserMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: `Spec complete.\n\n${PHASE_COMPLETE_MARKER}` }],
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
    expect(state.phaseStatus).toBe("executing");
    expect(state.yoloMode).toBe(true);
    expect(state.waitingReason).toBeUndefined();
    expect(sendUserMessages).toHaveLength(1);
    expect(sendUserMessages[0]?.options).toBeUndefined();
    expect(String(sendUserMessages[0]?.content)).toContain("Phase: TDD Implement");
  });

  it("launches review when the reviewer skill is installed at the global skill root", async () => {
    const workDir = makeTempDir("ralph-review-root-skill-");
    const skillBase = makeTempDir("ralph-review-root-skills-");
    process.env.PI_SKILL_BASE = skillBase;
    seedSkill(skillBase, "pr-reviewer");

    const branch: FakeEntry[] = [];
    pushState(branch, workDir, {
      phases: ["implement", "review"],
      currentPhase: "implement",
      currentPhaseIndex: 0,
      phaseStatus: "executing",
      autoClearContext: false,
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

    const state = latestState<{ currentPhase?: string; pipelineStatus?: string; phaseStatus?: string }>(branch);
    expect(state.currentPhase).toBe("review");
    expect(state.pipelineStatus).toBe("running");
    expect(state.phaseStatus).toBe("executing");
    expect(sendUserMessages).toHaveLength(1);
    expect(sendUserMessages[0]?.options).toBeUndefined();
    expect(String(sendUserMessages[0]?.content)).toContain("# pr-reviewer");
  });

  it("launches review after a passing TDD gate even when the implement marker is omitted", async () => {
    const workDir = makeTempDir("ralph-implement-gate-review-");
    const skillBase = makeTempDir("ralph-implement-gate-review-skills-");
    process.env.PI_SKILL_BASE = skillBase;
    seedSkill(skillBase, "pr-reviewer");

    const branch: FakeEntry[] = [];
    pushState(branch, workDir, {
      phases: ["implement", "review"],
      currentPhase: "implement",
      currentPhaseIndex: 0,
      phaseStatus: "executing",
      autoClearContext: false,
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
    expect(state.currentPhase).toBe("review");
    expect(state.phaseStatus).toBe("executing");
    expect(state.readyToAdvancePhase).toBeUndefined();
    expect(sendUserMessages).toHaveLength(1);
    expect(sendUserMessages[0]?.options).toBeUndefined();
    expect(String(sendUserMessages[0]?.content)).toContain("Phase: Ralph Review Loop");
  });

  it("keeps implement running and steers toward the registered gate tool instead of pausing after TDD", async () => {
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
    expect(String(sendUserMessages[0]?.content)).toContain("Call the registered `ralph_gate_check` tool");
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
    expect(widgetText).toContain("Ralph · COMPLETE");
    expect(widgetText).toContain("✓ 2/2 Ralph Review Loop");
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

  it("backtracks critical review decisions to implement and preserves issue context", async () => {
    const workDir = makeTempDir("ralph-review-critical-");
    const skillBase = makeTempDir("ralph-review-skills-");
    process.env.PI_SKILL_BASE = skillBase;
    seedSkill(skillBase, "tdd-implement");

    const branch: FakeEntry[] = [];
    pushState(branch, workDir, {
      phases: ["spec", "implement", "review"],
      currentPhase: "review",
      currentPhaseIndex: 2,
      reviewIterations: 0,
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
    expect(state.phaseStatus).toBe("executing");
    expect(state.reviewIterations).toBe(1);
    expect(sendUserMessages).toHaveLength(1);
    expect(sendUserMessages[0]?.options?.deliverAs).toBe("steer");
    expect(String(sendUserMessages[0]?.content)).toContain("Missing auth boundary test");
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
    expect(widgetText).toContain("Ralph · COMPLETE");
    expect(widgetText).toContain("✓ 2/2 Ralph Review Loop");
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
