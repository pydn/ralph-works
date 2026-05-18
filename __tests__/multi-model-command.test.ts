import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

interface FakeEntry {
  type: string;
  customType?: string;
  data?: unknown;
}

function makeFakePi(branch: FakeEntry[], options?: { setModelImpl?: (model: any) => Promise<boolean> }) {
  const commands = new Map<string, (args: string, ctx: any) => unknown>();
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const sendUserMessages: Array<{ content: unknown; options?: { deliverAs?: string } }> = [];
  const setModel = vi.fn(options?.setModelImpl ?? (async () => true));
  const setThinkingLevel = vi.fn();
  const sendUserMessage = vi.fn((content: unknown, options?: { deliverAs?: string }) => {
    sendUserMessages.push({ content, options });
  });

  const pi = {
    on(event: string, handler: (event: any, ctx: any) => unknown): void {
      handlers.set(event, handler);
    },
    registerTool(): void {},
    registerCommand(name: string, config: { handler: (args: string, ctx: any) => unknown }): void {
      commands.set(name, config.handler);
    },
    appendEntry(customType: string, data?: unknown): void {
      branch.push({ type: "custom", customType, data });
    },
    sendUserMessage,
    sendMessage(): void {},
    setModel,
    getThinkingLevel: () => "medium",
    setThinkingLevel,
  };

  return { pi, commands, handlers, sendUserMessages, setModel, setThinkingLevel };
}

function makeFakeContext(branch: FakeEntry[], cwd: string) {
  const models = new Map([
    ["anthropic/claude-sonnet-4-5", { provider: "anthropic", id: "claude-sonnet-4-5", name: "Sonnet" }],
    ["anthropic/claude-opus-4-5", { provider: "anthropic", id: "claude-opus-4-5", name: "Opus" }],
    ["openai/gpt-5.2-codex", { provider: "openai", id: "gpt-5.2-codex", name: "GPT Codex" }],
    ["local/tiny", { provider: "local", id: "tiny", name: "Tiny", contextWindow: 4096, maxTokens: 1024 }],
  ]);
  return {
    cwd,
    model: { provider: "openai", id: "gpt-5.2-codex", name: "GPT Codex" },
    modelRegistry: {
      find: vi.fn((provider: string, model: string) => models.get(`${provider}/${model}`)),
    },
    isIdle: () => true,
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

afterEach(() => {
  delete process.env.PI_SKILL_BASE;
  vi.resetModules();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("multi-model slash command integration", () => {
  it("persists a model plan, snapshots the original model, and applies the phase model before prompting", async () => {
    const workDir = makeTempDir("ralph-multi-model-start-");
    const skillBase = makeTempDir("ralph-multi-model-skills-");
    process.env.PI_SKILL_BASE = skillBase;
    fs.mkdirSync(path.join(skillBase, "generate-spec"), { recursive: true });
    fs.writeFileSync(path.join(skillBase, "generate-spec", "SKILL.md"), "# Generate Spec", "utf-8");

    const branch: FakeEntry[] = [];
    const { default: registerExtension } = await import("../index");
    const { pi, commands, sendUserMessages, setModel, setThinkingLevel } = makeFakePi(branch);
    registerExtension(pi as any);

    const ctx = makeFakeContext(branch, workDir);
    await commands.get("ralph")?.(
      "start feature-a spec --model anthropic/claude-sonnet-4-5:high --models spec=anthropic/claude-opus-4-5:xhigh",
      ctx,
    );

    expect(setModel).toHaveBeenCalledWith({ provider: "anthropic", id: "claude-opus-4-5", name: "Opus" });
    expect(setModel.mock.invocationCallOrder[0]).toBeLessThan((pi.sendUserMessage as any).mock.invocationCallOrder[0]);
    expect(setThinkingLevel).toHaveBeenCalledWith("xhigh");
    expect(sendUserMessages).toHaveLength(1);

    const latestState = branch[branch.length - 1]?.data as any;
    expect(latestState.modelPlan.default).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      thinkingLevel: "high",
      source: "cli",
    });
    expect(latestState.modelPlan.phases.spec).toMatchObject({
      provider: "anthropic",
      model: "claude-opus-4-5",
      thinkingLevel: "xhigh",
      source: "cli",
    });
    expect(latestState.originalModel).toMatchObject({ provider: "openai", model: "gpt-5.2-codex" });
    expect(latestState.lastAppliedModel).toMatchObject({
      phaseKey: "spec",
      provider: "anthropic",
      model: "claude-opus-4-5",
      thinkingLevel: "xhigh",
    });
    expect(latestState.modelSwitchHistory.at(-1)).toMatchObject({ event: "apply", result: "success" });
    const historyPath = path.join(workDir, ".ralph", "model-switch-history-feature-a.jsonl");
    expect(fs.readFileSync(historyPath, "utf-8")).toContain('"event":"apply"');
  });

  it("blocks weak critical-phase models unless explicitly allowed", async () => {
    const workDir = makeTempDir("ralph-multi-model-weak-");
    const skillBase = makeTempDir("ralph-multi-model-weak-skills-");
    process.env.PI_SKILL_BASE = skillBase;
    fs.mkdirSync(path.join(skillBase, "tdd-implement"), { recursive: true });
    fs.writeFileSync(path.join(skillBase, "tdd-implement", "SKILL.md"), "# TDD Implement", "utf-8");

    const branch: FakeEntry[] = [];
    const { default: registerExtension } = await import("../index");
    const { pi, commands, sendUserMessages } = makeFakePi(branch);
    registerExtension(pi as any);
    const ctx = makeFakeContext(branch, workDir);

    await commands.get("ralph")?.("start feature-a implement --model local/tiny", ctx);

    expect(sendUserMessages).toHaveLength(0);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("implement: local/tiny contextWindow 4096 is below 64000"),
      "error",
    );
  });

  it("records plan-update history when /ralph continue changes the model plan", async () => {
    const workDir = makeTempDir("ralph-multi-model-continue-plan-");
    const skillBase = makeTempDir("ralph-multi-model-continue-plan-skills-");
    process.env.PI_SKILL_BASE = skillBase;
    fs.mkdirSync(path.join(skillBase, "tdd-implement"), { recursive: true });
    fs.writeFileSync(path.join(skillBase, "tdd-implement", "SKILL.md"), "# TDD Implement", "utf-8");

    const branch: FakeEntry[] = [
      {
        type: "custom",
        customType: "ralph-loop-state",
        data: {
          feature: "feature-a",
          workDir,
          phases: ["implement"],
          maxIterations: 10,
          startedAt: Date.now(),
          currentPhase: "implement",
          currentPhaseIndex: 0,
          phaseStatus: "waiting_for_user",
          pipelineStatus: "paused",
          yoloMode: false,
          modelPlan: {
            default: { provider: "anthropic", model: "claude-sonnet-4-5", thinkingLevel: "high", source: "cli" },
            restoreOriginalOnComplete: true,
            strict: true,
          },
          originalModel: { provider: "openai", model: "gpt-5.2-codex", thinkingLevel: "medium", source: "current" },
        },
      },
    ];
    const { default: registerExtension } = await import("../index");
    const { pi, commands } = makeFakePi(branch);
    registerExtension(pi as any);
    const ctx = makeFakeContext(branch, workDir);

    await commands.get("ralph")?.("continue --model anthropic/claude-opus-4-5:xhigh", ctx);

    const latestState = branch[branch.length - 1]?.data as any;
    expect(latestState.modelSwitchHistory.map((entry: any) => entry.event)).toContain("plan-update");
    expect(fs.readFileSync(path.join(workDir, ".ralph", "model-switch-history-feature-a.jsonl"), "utf-8")).toContain(
      '"event":"plan-update"',
    );
  });

  it("reapplies the expected phase model when the active model drifts before agent start", async () => {
    const workDir = makeTempDir("ralph-multi-model-drift-");
    const branch: FakeEntry[] = [
      {
        type: "custom",
        customType: "ralph-loop-state",
        data: {
          feature: "feature-a",
          workDir,
          phases: ["implement"],
          maxIterations: 10,
          startedAt: Date.now(),
          currentPhase: "implement",
          currentPhaseIndex: 0,
          phaseStatus: "executing",
          pipelineStatus: "running",
          modelPlan: {
            default: { provider: "anthropic", model: "claude-opus-4-5", thinkingLevel: "xhigh", source: "cli" },
            restoreOriginalOnComplete: true,
            strict: true,
          },
          phaseModelNonce: "implement-1",
          lastAppliedModel: {
            phaseKey: "implement",
            provider: "anthropic",
            model: "claude-opus-4-5",
            thinkingLevel: "xhigh",
            appliedAt: Date.now(),
            nonce: "implement-1",
          },
        },
      },
    ];
    const { default: registerExtension } = await import("../index");
    const { pi, handlers, setModel, setThinkingLevel } = makeFakePi(branch);
    registerExtension(pi as any);
    const ctx = makeFakeContext(branch, workDir);
    ctx.model = { provider: "anthropic", id: "claude-sonnet-4-5", name: "Sonnet" };

    await handlers.get("before_agent_start")?.({ systemPrompt: "base", prompt: "go" }, ctx);

    expect(setModel).toHaveBeenCalledWith({ provider: "anthropic", id: "claude-opus-4-5", name: "Opus" });
    expect(setThinkingLevel).toHaveBeenCalledWith("xhigh");
    const latestState = branch[branch.length - 1]?.data as any;
    expect(latestState.modelSwitchHistory.map((entry: any) => entry.event)).toEqual(["mismatch", "reapply"]);
  });

  it("fails closed without leaking prompt payload when drift is detected at provider dispatch", async () => {
    const workDir = makeTempDir("ralph-multi-model-provider-drift-");
    const branch: FakeEntry[] = [
      {
        type: "custom",
        customType: "ralph-loop-state",
        data: {
          feature: "feature-a",
          workDir,
          phases: ["review"],
          maxIterations: 10,
          startedAt: Date.now(),
          currentPhase: "review",
          currentPhaseIndex: 0,
          phaseStatus: "executing",
          pipelineStatus: "running",
          modelPlan: {
            default: { provider: "anthropic", model: "claude-opus-4-5", thinkingLevel: "xhigh", source: "cli" },
            restoreOriginalOnComplete: true,
            strict: true,
          },
          phaseModelNonce: "review-1",
          lastAppliedModel: {
            phaseKey: "review",
            provider: "anthropic",
            model: "claude-opus-4-5",
            thinkingLevel: "xhigh",
            appliedAt: Date.now(),
            nonce: "review-1",
          },
        },
      },
    ];
    const { default: registerExtension } = await import("../index");
    const { pi, handlers, setModel } = makeFakePi(branch);
    registerExtension(pi as any);
    const ctx = makeFakeContext(branch, workDir);
    ctx.model = { provider: "anthropic", id: "claude-sonnet-4-5", name: "Sonnet" };

    const blockedPayload = await handlers.get("before_provider_request")?.(
      { payload: { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "SECRET SOURCE" }] } },
      ctx,
    );

    expect(setModel).not.toHaveBeenCalled();
    expect(JSON.stringify(blockedPayload)).not.toContain("SECRET SOURCE");
    expect(blockedPayload).toMatchObject({ model: "__ralph_model_drift_blocked__" });
    const latestState = branch[branch.length - 1]?.data as any;
    expect(latestState.pipelineStatus).toBe("failed");
    expect(latestState.modelSwitchHistory.at(-1)).toMatchObject({ event: "failure", result: "blocked" });
  });

  it("restores the original model when phase launch fails before prompting", async () => {
    const workDir = makeTempDir("ralph-multi-model-launch-failure-");
    const skillBase = makeTempDir("ralph-multi-model-launch-failure-skills-");
    process.env.PI_SKILL_BASE = skillBase;
    fs.mkdirSync(path.join(skillBase, "generate-spec"), { recursive: true });
    fs.writeFileSync(path.join(skillBase, "generate-spec", "SKILL.md"), "# Generate Spec", "utf-8");

    const branch: FakeEntry[] = [];
    const { default: registerExtension } = await import("../index");
    const { pi, commands, sendUserMessages, setModel } = makeFakePi(branch, {
      setModelImpl: async (model) => model.provider === "openai",
    });
    registerExtension(pi as any);
    const ctx = makeFakeContext(branch, workDir);

    await commands.get("ralph")?.("start feature-a spec --model anthropic/claude-opus-4-5:xhigh", ctx);

    expect(sendUserMessages).toHaveLength(0);
    expect(setModel).toHaveBeenCalledWith({ provider: "anthropic", id: "claude-opus-4-5", name: "Opus" });
    expect(setModel).toHaveBeenCalledWith({ provider: "openai", id: "gpt-5.2-codex", name: "GPT Codex" });
    const latestState = branch[branch.length - 1]?.data as any;
    expect(latestState.pipelineStatus).toBe("failed");
    expect(latestState.modelSwitchHistory.at(-1)).toMatchObject({ event: "restore", result: "success" });
  });

  it("restores the original model on cancel only when Ralph still owns the active model", async () => {
    const workDir = makeTempDir("ralph-multi-model-restore-");
    const state = {
      feature: "feature-a",
      workDir,
      phases: ["implement"],
      maxIterations: 10,
      startedAt: Date.now(),
      currentPhase: "implement",
      currentPhaseIndex: 0,
      phaseStatus: "executing",
      pipelineStatus: "running",
      modelPlan: { restoreOriginalOnComplete: true, strict: true },
      originalModel: { provider: "openai", model: "gpt-5.2-codex", thinkingLevel: "medium", source: "current" },
      lastAppliedModel: {
        phaseKey: "implement",
        provider: "anthropic",
        model: "claude-opus-4-5",
        thinkingLevel: "xhigh",
        appliedAt: Date.now(),
        nonce: "implement-1",
      },
    };
    const branch: FakeEntry[] = [{ type: "custom", customType: "ralph-loop-state", data: state }];
    const { default: registerExtension } = await import("../index");
    const { pi, commands, setModel, setThinkingLevel } = makeFakePi(branch);
    registerExtension(pi as any);
    const ctx = makeFakeContext(branch, workDir);
    ctx.model = { provider: "anthropic", id: "claude-opus-4-5", name: "Opus" };

    await commands.get("ralph")?.("cancel", ctx);

    expect(setModel).toHaveBeenCalledWith({ provider: "openai", id: "gpt-5.2-codex", name: "GPT Codex" });
    expect(setThinkingLevel).toHaveBeenCalledWith("medium");
    expect((branch[branch.length - 1]?.data as any).modelSwitchHistory.at(-1)).toMatchObject({
      event: "restore",
      result: "success",
    });

    const changedBranch: FakeEntry[] = [{ type: "custom", customType: "ralph-loop-state", data: state }];
    const second = makeFakePi(changedBranch);
    registerExtension(second.pi as any);
    const changedCtx = makeFakeContext(changedBranch, workDir);
    changedCtx.model = { provider: "anthropic", id: "claude-sonnet-4-5", name: "Sonnet" };

    await second.commands.get("ralph")?.("cancel", changedCtx);

    expect(second.setModel).not.toHaveBeenCalled();
    expect((changedBranch[changedBranch.length - 1]?.data as any).modelSwitchHistory.at(-1)).toMatchObject({
      event: "skipped-restore",
      result: "skipped",
    });
  });

  it("shows full provider/model IDs in /ralph status", async () => {
    const workDir = makeTempDir("ralph-multi-model-status-");
    const branch: FakeEntry[] = [
      {
        type: "custom",
        customType: "ralph-loop-state",
        data: {
          feature: "feature-a",
          workDir,
          phases: ["spec", "review"],
          maxIterations: 10,
          startedAt: Date.now(),
          currentPhase: "review",
          currentPhaseIndex: 1,
          phaseStatus: "executing",
          pipelineStatus: "running",
          modelPlan: {
            default: { provider: "anthropic", model: "claude-sonnet-4-5", thinkingLevel: "high", source: "cli" },
            phases: {
              review: { provider: "anthropic", model: "claude-opus-4-5", thinkingLevel: "xhigh", source: "cli" },
            },
            restoreOriginalOnComplete: true,
            strict: true,
          },
          lastAppliedModel: {
            phaseKey: "review",
            provider: "anthropic",
            model: "claude-opus-4-5",
            thinkingLevel: "xhigh",
            appliedAt: Date.now(),
            nonce: "review-1",
          },
        },
      },
    ];
    const { default: registerExtension } = await import("../index");
    const { pi, commands } = makeFakePi(branch);
    registerExtension(pi as any);
    const ctx = makeFakeContext(branch, workDir);

    await commands.get("ralph")?.("status", ctx);

    const statusText = ctx.ui.notify.mock.calls[0]?.[0] as string;
    expect(statusText).toContain("Model plan: default anthropic/claude-sonnet-4-5:high");
    expect(statusText).toContain("review anthropic/claude-opus-4-5:xhigh");
    expect(statusText).toContain("Last applied model: review anthropic/claude-opus-4-5:xhigh");
  });
});
