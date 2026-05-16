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
  it("reads prompt text from a workspace file and applies an explicit phase list", async () => {
    const workDir = makeTempDir("ralph-start-work-");
    const skillBase = makeTempDir("ralph-start-skills-");
    process.env.PI_SKILL_BASE = skillBase;
    seedSkill(skillBase, "generate-spec");
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

    pushState(branch, workDir, { currentPhase: "spec", currentPhaseIndex: 0 });
    const injected = await beforeAgentStart?.({ systemPrompt: "base" }, makeFakeContext(branch, workDir));
    expect((injected as { systemPrompt?: string })?.systemPrompt).toContain("<ralph-spec-skill>");

    const duplicate = await beforeAgentStart?.({ systemPrompt: "base\nralph-spec-skill" }, makeFakeContext(branch, workDir));
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
    const result = await tools.get("ralph_gate_check")?.execute(
      "gate-1",
      { paths: ["src/file.ts", "src/file.ts;rm"] },
      undefined,
      onUpdate,
      ctx,
    ) as { details?: { allPass?: boolean } };

    expect(result.details?.allPass).toBe(true);
    expect(onUpdate).toHaveBeenCalled();
    expect(latestState<{ turnWriteCount?: number }>(branch).turnWriteCount).toBe(0);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("ralph-loop", "✅ Gates clear");
  });
});

describe("review decision and completion paths", () => {
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

    const result = await tools.get("ralph_review_decision")?.execute(
      "review-1",
      { status: "LGTM" },
      undefined,
      vi.fn(),
      makeFakeContext(branch, workDir),
    ) as { content?: Array<{ text?: string }> };

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

    await tools.get("ralph_review_decision")?.execute(
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
    await tools.get("ralph_review_decision")?.execute(
      "review-1",
      { status: "LGTM" },
      undefined,
      vi.fn(),
      ctx,
    );

    const state = latestState<{ pipelineStatus?: string; phaseStatus?: string }>(branch);
    expect(state.pipelineStatus).toBe("completed");
    expect(state.phaseStatus).toBe("post_hook");
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("ralph-loop", expect.stringContaining("Done"));
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
