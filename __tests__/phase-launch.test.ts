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

function makeFakePi(branch: FakeEntry[]) {
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const sendUserMessages: Array<{ content: unknown; options?: { deliverAs?: string } }> = [];
  const sendMessages: Array<{ message: unknown; options?: { deliverAs?: string } }> = [];

  const pi = {
    on(event: string, handler: (event: any, ctx: any) => unknown): void {
      handlers.set(event, handler);
    },
    registerTool(): void {},
    registerCommand(): void {},
    appendEntry(customType: string, data?: unknown): void {
      branch.push({ type: "custom", customType, data });
    },
    sendUserMessage(content: unknown, options?: { deliverAs?: string }): void {
      sendUserMessages.push({ content, options });
    },
    sendMessage(message: unknown, options?: { deliverAs?: string }): void {
      sendMessages.push({ message, options });
    },
  };

  return { pi, handlers, sendUserMessages, sendMessages };
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

afterEach(() => {
  delete process.env.PI_SKILL_BASE;
  vi.resetModules();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("next-phase launch", () => {
  it("queues the next phase as a follow-up user message after explicit completion", async () => {
    const workDir = makeTempDir("ralph-phase-work-");
    const skillBase = makeTempDir("ralph-phase-skills-");
    process.env.PI_SKILL_BASE = skillBase;

    fs.mkdirSync(path.join(workDir, "docs", "specs"), { recursive: true });
    fs.writeFileSync(
      path.join(workDir, "docs", "specs", "feature-a.md"),
      `# Feature A\n\n${"Spec body.\n".repeat(256)}`,
      "utf-8",
    );

    fs.mkdirSync(path.join(skillBase, "red-team-audit"), { recursive: true });
    fs.writeFileSync(path.join(skillBase, "red-team-audit", "SKILL.md"), "# Red Team Audit", "utf-8");

    const branch: FakeEntry[] = [];
    branch.push({
      type: "custom",
      customType: "ralph-loop-state",
      data: {
        feature: "feature-a",
        workDir,
        phases: ["spec", "redteam"],
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
      },
    });

    const { default: registerExtension } = await import("../index");
    const { pi, handlers, sendUserMessages, sendMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    const ctx = makeFakeContext(branch, workDir);
    const agentEnd = handlers.get("agent_end");
    expect(agentEnd).toBeTypeOf("function");

    await agentEnd?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: `Spec is complete.\n\n${PHASE_COMPLETE_MARKER}` }],
          },
        ],
      },
      ctx,
    );

    expect(sendUserMessages).toHaveLength(1);
    expect(sendUserMessages[0]?.options?.deliverAs).toBe("followUp");
    expect(String(sendUserMessages[0]?.content)).toContain("Phase: Red Team Audit");
    expect(sendMessages).toHaveLength(0);

    const latestState = branch[branch.length - 1]?.data as { currentPhase?: string; phaseStatus?: string };
    expect(latestState.currentPhase).toBe("redteam");
    expect(latestState.phaseStatus).toBe("executing");
  });

  it("marks the pipeline as waiting for user input when a phase ends without completion", async () => {
    const workDir = makeTempDir("ralph-wait-work-");
    const branch: FakeEntry[] = [
      {
        type: "custom",
        customType: "ralph-loop-state",
        data: {
          feature: "needs-operator",
          workDir,
          phases: ["spec", "redteam"],
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
        },
      },
    ];

    const { default: registerExtension } = await import("../index");
    const { pi, handlers } = makeFakePi(branch);
    registerExtension(pi as any);

    const ctx = makeFakeContext(branch, workDir);
    const agentEnd = handlers.get("agent_end");
    await agentEnd?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Should I proceed with the stricter behavior?" }],
          },
        ],
      },
      ctx,
    );

    const latestState = branch[branch.length - 1]?.data as { phaseStatus?: string };
    expect(latestState.phaseStatus).toBe("waiting_for_user");
    expect(ctx.ui.setWorkingVisible).toHaveBeenLastCalledWith(false);
    expect(ctx.ui.setWorkingIndicator).toHaveBeenLastCalledWith({ frames: [] });
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "ralph-loop",
      expect.stringContaining("Waiting for user input"),
    );
    const widgetLines = ctx.ui.setWidget.mock.calls.at(-1)?.[1] as string[];
    expect(ctx.ui.setWidget).toHaveBeenLastCalledWith(
      "ralph-loop",
      expect.arrayContaining([
        expect.stringContaining("Ralph Pipeline"),
        expect.stringContaining("WAITING FOR USER INPUT"),
        expect.stringContaining("▶ 1. Generate Spec"),
        expect.stringContaining("Reply to the prompt"),
      ]),
    );
    expect(widgetLines.join("\n")).not.toContain("Phase 1/2");
    expect(widgetLines.join("\n")).not.toMatch(/\[[#-]+\] \d+%/);
  });

  it("restores executing UI state when the operator answers", async () => {
    const workDir = makeTempDir("ralph-answer-work-");
    const branch: FakeEntry[] = [
      {
        type: "custom",
        customType: "ralph-loop-state",
        data: {
          feature: "needs-operator",
          workDir,
          phases: ["spec", "redteam"],
          maxIterations: 10,
          startedAt: Date.now(),
          currentPhase: "spec",
          currentPhaseIndex: 0,
          phaseStatus: "waiting_for_user",
          pipelineStatus: "running",
          reviewIterations: 0,
          phaseAttempts: 0,
          turnWriteCount: 0,
          autoClearContext: false,
        },
      },
    ];

    const { default: registerExtension } = await import("../index");
    const { pi, handlers } = makeFakePi(branch);
    registerExtension(pi as any);

    const ctx = makeFakeContext(branch, workDir);
    const input = handlers.get("input");
    await input?.({ text: "Use the stricter behavior.", source: "interactive" }, ctx);

    const latestState = branch[branch.length - 1]?.data as { phaseStatus?: string };
    expect(latestState.phaseStatus).toBe("executing");
    expect(ctx.ui.setWorkingVisible).toHaveBeenLastCalledWith(true);
    expect(ctx.ui.setWorkingMessage).toHaveBeenLastCalledWith();
    expect(ctx.ui.setWorkingIndicator).toHaveBeenLastCalledWith();
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "ralph-loop",
      expect.stringContaining("Ralph | needs-operator"),
    );
  });

  it("renders the active widget once for duplicate streaming updates", async () => {
    const workDir = makeTempDir("ralph-stream-widget-work-");
    const branch: FakeEntry[] = [
      {
        type: "custom",
        customType: "ralph-loop-state",
        data: {
          feature: "fast-ui",
          workDir,
          phases: ["implement", "review"],
          maxIterations: 10,
          startedAt: Date.now(),
          currentPhase: "implement",
          currentPhaseIndex: 0,
          phaseStatus: "executing",
          pipelineStatus: "running",
          reviewIterations: 0,
          phaseAttempts: 0,
          turnWriteCount: 0,
          autoClearContext: false,
        },
      },
    ];

    const { default: registerExtension } = await import("../index");
    const { pi, handlers } = makeFakePi(branch);
    registerExtension(pi as any);

    const ctx = makeFakeContext(branch, workDir);
    const messageUpdate = handlers.get("message_update");
    expect(messageUpdate).toBeTypeOf("function");

    await messageUpdate?.({ message: { role: "assistant" } }, ctx);
    await messageUpdate?.({ message: { role: "assistant" } }, ctx);

    expect(ctx.ui.setWidget).toHaveBeenCalledTimes(1);
    expect(ctx.ui.setWidget).toHaveBeenLastCalledWith(
      "ralph-loop",
      expect.arrayContaining([
        expect.stringContaining("Ralph Pipeline"),
        expect.stringContaining("RUNNING"),
        expect.stringContaining("Run ralph_gate_check"),
      ]),
    );
  });

  it("uses queue-safe user messaging when session reload resumes an executing phase", async () => {
    const workDir = makeTempDir("ralph-session-reload-");
    const branch: FakeEntry[] = [];
    branch.push({
      type: "custom",
      customType: "ralph-loop-state",
      data: {
        feature: "reload-feature",
        workDir,
        phases: ["spec", "redteam"],
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
      },
    });

    const { default: registerExtension } = await import("../index");
    const { pi, handlers, sendUserMessages, sendMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    const ctx = makeFakeContext(branch, workDir, { idle: true });
    const sessionStart = handlers.get("session_start");
    expect(sessionStart).toBeTypeOf("function");

    await sessionStart?.({}, ctx);

    expect(sendUserMessages).toHaveLength(1);
    expect(sendUserMessages[0]?.options).toBeUndefined();
    expect(String(sendUserMessages[0]?.content)).toContain("SESSION RELOAD");
    expect(sendMessages).toHaveLength(0);
  });

  it("uses queue-safe user messaging when post-hook validation fails", async () => {
    const workDir = makeTempDir("ralph-post-hook-fail-");
    const branch: FakeEntry[] = [];
    branch.push({
      type: "custom",
      customType: "ralph-loop-state",
      data: {
        feature: "missing-audit",
        workDir,
        phases: ["redteam"],
        maxIterations: 10,
        startedAt: Date.now(),
        currentPhase: "redteam",
        currentPhaseIndex: 0,
        phaseStatus: "executing",
        pipelineStatus: "running",
        reviewIterations: 0,
        phaseAttempts: 0,
        turnWriteCount: 0,
        autoClearContext: false,
      },
    });

    const { default: registerExtension } = await import("../index");
    const { pi, handlers, sendUserMessages, sendMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    const ctx = makeFakeContext(branch, workDir);
    const agentEnd = handlers.get("agent_end");
    expect(agentEnd).toBeTypeOf("function");

    await agentEnd?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: `Audit complete.\n\n${PHASE_COMPLETE_MARKER}` }],
          },
        ],
      },
      ctx,
    );

    expect(sendUserMessages).toHaveLength(1);
    expect(sendUserMessages[0]?.options?.deliverAs).toBe("steer");
    expect(String(sendUserMessages[0]?.content)).toContain("Phase validation failed");
    expect(sendMessages).toHaveLength(0);

    const latestState = branch[branch.length - 1]?.data as { phaseAttempts?: number };
    expect(latestState.phaseAttempts).toBe(1);
  });

  it("coalesces duplicate pending phase-transition steers", async () => {
    const workDir = makeTempDir("ralph-phase-work-");
    const skillBase = makeTempDir("ralph-phase-skills-");
    process.env.PI_SKILL_BASE = skillBase;

    fs.mkdirSync(path.join(workDir, "docs", "specs"), { recursive: true });
    fs.writeFileSync(
      path.join(workDir, "docs", "specs", "feature-a.md"),
      `# Feature A\n\n${"Spec body.\n".repeat(256)}`,
      "utf-8",
    );

    fs.mkdirSync(path.join(skillBase, "red-team-audit"), { recursive: true });
    fs.writeFileSync(path.join(skillBase, "red-team-audit", "SKILL.md"), "# Red Team Audit", "utf-8");

    const branch: FakeEntry[] = [];
    branch.push({
      type: "custom",
      customType: "ralph-loop-state",
      data: {
        feature: "feature-a",
        workDir,
        phases: ["spec", "redteam"],
        maxIterations: 10,
        startedAt: Date.now(),
        currentPhase: "redteam",
        currentPhaseIndex: 1,
        phaseStatus: "pre_hook",
        pipelineStatus: "running",
        reviewIterations: 0,
        phaseAttempts: 0,
        turnWriteCount: 0,
        autoClearContext: false,
      },
    });

    const { default: registerExtension } = await import("../index");
    const { pi, handlers, sendUserMessages, sendMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    const ctx = makeFakeContext(branch, workDir);
    const sessionStart = handlers.get("session_start");
    expect(sessionStart).toBeTypeOf("function");

    await sessionStart?.({}, ctx);
    await sessionStart?.({}, ctx);

    expect(sendUserMessages).toHaveLength(1);
    expect(sendUserMessages[0]?.options?.deliverAs).toBe("steer");
    expect(String(sendUserMessages[0]?.content)).toContain("Phase: Red Team Audit");
    expect(sendMessages).toHaveLength(0);
  });
});
