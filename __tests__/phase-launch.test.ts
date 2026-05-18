import * as fs from "node:fs";
import * as childProcess from "node:child_process";
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

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

afterEach(() => {
  delete process.env.PI_SKILL_BASE;
  vi.useRealTimers();
  vi.resetModules();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("next-phase launch", () => {
  it("starts the next phase after agent_end once Pi is idle", async () => {
    vi.useFakeTimers();
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

    const idleState = { idle: false };
    const ctx = makeFakeContext(branch, workDir, idleState);
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

    expect(sendUserMessages).toHaveLength(0);
    idleState.idle = true;
    await vi.advanceTimersByTimeAsync(25);

    expect(sendUserMessages).toHaveLength(1);
    expect(sendUserMessages[0]?.options).toBeUndefined();
    expect(String(sendUserMessages[0]?.content)).toContain("Phase: Red Team Audit");
    expect(sendMessages).toHaveLength(0);
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("→ Phase"), "info");
    const widgetText = ctx.ui.setWidget.mock.calls.map((call) => (call[1] as string[]).join("\n")).join("\n");
    expect(widgetText).not.toContain("/ralph status shows details");
    expect(widgetText).not.toContain("/ralph pause pauses safely");

    const latestState = branch[branch.length - 1]?.data as { currentPhase?: string; phaseStatus?: string };
    expect(latestState.currentPhase).toBe("redteam");
    expect(latestState.phaseStatus).toBe("executing");
  });

  it("shows a clear visible message before automatic compaction starts after spec completion", async () => {
    const workDir = makeTempDir("ralph-auto-compact-work-");
    const skillBase = makeTempDir("ralph-auto-compact-skills-");
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
        autoClearContext: true,
      },
    });

    const { default: registerExtension } = await import("../index");
    const { pi, handlers } = makeFakePi(branch);
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

    expect(ctx.compact).toHaveBeenCalledTimes(1);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("ralph-loop", "COMPACTING; this may take a minute");
    const compactingStatusCall = ctx.ui.setStatus.mock.calls.find(
      (call) => call[1] === "COMPACTING; this may take a minute",
    );
    expect(compactingStatusCall).toBeDefined();
    expect(ctx.ui.setStatus.mock.invocationCallOrder.at(-1)).toBeLessThan(ctx.compact.mock.invocationCallOrder[0]);
    expect(ctx.ui.setWorkingMessage).not.toHaveBeenCalledWith(expect.stringContaining("Compacting"));
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("Compacting"), expect.anything());
    const compactingWidget = ctx.ui.setWidget.mock.calls
      .map((call) => (call[1] as string[]).join("\n"))
      .find((text) => text.includes("COMPACTING"));
    expect(compactingWidget).toBeUndefined();

    const compactOptions = ctx.compact.mock.calls[0]?.[0] as { onComplete?: () => void };
    compactOptions.onComplete?.();

    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("ralph-loop", undefined);
  });

  it("treats missing autoClearContext as enabled for phase-boundary compaction", async () => {
    const workDir = makeTempDir("ralph-auto-compact-default-work-");
    const skillBase = makeTempDir("ralph-auto-compact-default-skills-");
    process.env.PI_SKILL_BASE = skillBase;

    fs.mkdirSync(path.join(workDir, "docs", "specs"), { recursive: true });
    fs.writeFileSync(
      path.join(workDir, "docs", "specs", "feature-a.md"),
      `# Feature A\n\n${"Spec body.\n".repeat(256)}`,
      "utf-8",
    );

    fs.mkdirSync(path.join(skillBase, "red-team-audit"), { recursive: true });
    fs.writeFileSync(path.join(skillBase, "red-team-audit", "SKILL.md"), "# Red Team Audit", "utf-8");

    const branch: FakeEntry[] = [
      {
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
        },
      },
    ];

    const { default: registerExtension } = await import("../index");
    const { pi, handlers } = makeFakePi(branch);
    registerExtension(pi as any);

    const ctx = makeFakeContext(branch, workDir);
    await handlers.get("agent_end")?.(
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

    expect(ctx.compact).toHaveBeenCalledTimes(1);
  });

  it("auto-compacts at phase boundaries despite recent clears and before review", async () => {
    const workDir = makeTempDir("ralph-auto-compact-review-work-");
    const branch: FakeEntry[] = [
      {
        type: "custom",
        customType: "ralph-loop-state",
        data: {
          feature: "feature-a",
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
          autoClearContext: true,
          lastContextClearAt: Date.now(),
        },
      },
    ];

    const { default: registerExtension } = await import("../index");
    const { pi, handlers } = makeFakePi(branch);
    registerExtension(pi as any);

    const ctx = makeFakeContext(branch, workDir);
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: `Implementation complete.\n\n${PHASE_COMPLETE_MARKER}` }],
          },
        ],
      },
      ctx,
    );

    expect(ctx.compact).toHaveBeenCalledTimes(1);
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
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("ralph-loop", undefined);
    const widgetLines = ctx.ui.setWidget.mock.calls.at(-1)?.[1] as string[];
    expect(ctx.ui.setWidget).toHaveBeenLastCalledWith(
      "ralph-loop",
      expect.arrayContaining([
        expect.stringContaining("Ralph · WAITING FOR USER INPUT"),
        expect.stringContaining("WAITING FOR USER INPUT"),
        expect.stringContaining("▶ 1/2 Generate Spec"),
        expect.stringContaining("Reply to the prompt"),
      ]),
      { placement: "belowEditor" },
    );
    expect(widgetLines.length).toBeLessThanOrEqual(4);
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
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("ralph-loop", undefined);
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
        expect.stringContaining("Ralph · RUNNING"),
        expect.stringContaining("RUNNING"),
        expect.stringContaining("Run ralph_gate_check"),
      ]),
      { placement: "belowEditor" },
    );
    const widgetText = (ctx.ui.setWidget.mock.calls.at(-1)?.[1] as string[]).join("\n");
    expect((ctx.ui.setWidget.mock.calls.at(-1)?.[1] as string[]).length).toBeLessThanOrEqual(4);
    expect(widgetText).not.toContain("/ralph pause pauses safely");
    expect(widgetText).not.toContain("/ralph status shows details");
    expect(widgetText).not.toContain("Status: running");
    expect(widgetText).not.toContain("Started:");
    expect(widgetText).not.toContain("Prompt: none");
  });

  it("applies separate semantic colors to status, progress, action, and detail text", async () => {
    const workDir = makeTempDir("ralph-widget-palette-work-");
    const branch: FakeEntry[] = [
      {
        type: "custom",
        customType: "ralph-loop-state",
        data: {
          feature: "soft-ui",
          workDir,
          phases: ["spec", "implement", "review"],
          maxIterations: 10,
          startedAt: Date.now(),
          currentPhase: "implement",
          currentPhaseIndex: 1,
          phaseStatus: "executing",
          pipelineStatus: "running",
          reviewIterations: 1,
          phaseAttempts: 2,
          turnWriteCount: 0,
          autoClearContext: false,
          promptText: "Use calm role-based colors.",
        },
      },
    ];

    const { default: registerExtension } = await import("../index");
    const { pi, handlers } = makeFakePi(branch);
    registerExtension(pi as any);

    const styled: Array<{ tone: string; text: string }> = [];
    const ctx = makeFakeContext(branch, workDir);
    ctx.ui.theme.fg = vi.fn((tone: string, text: string) => {
      styled.push({ tone, text });
      return `<${tone}>${text}</${tone}>`;
    });
    const messageUpdate = handlers.get("message_update");
    expect(messageUpdate).toBeTypeOf("function");

    await messageUpdate?.({ message: { role: "assistant" } }, ctx);

    const widgetLines = ctx.ui.setWidget.mock.calls.at(-1)?.[1] as string[];
    const widgetText = widgetLines.join("\n");
    expect(stripAnsi(widgetText.replace(/<\/?[^>]+>/g, ""))).toContain("Ralph · RUNNING · soft-ui");
    expect(styled).toEqual(expect.arrayContaining([{ tone: "customMessageLabel", text: "Ralph" }]));
    expect(styled).toEqual(expect.arrayContaining([{ tone: "accent", text: "RUNNING" }]));
    expect(styled).toEqual(expect.arrayContaining([{ tone: "success", text: "✓" }]));
    expect(styled).toEqual(expect.arrayContaining([{ tone: "accent", text: "▶" }]));
    expect(styled).toEqual(expect.arrayContaining([{ tone: "muted", text: "·" }]));
    expect(styled).toEqual(
      expect.arrayContaining([{ tone: "mdLink", text: "Run ralph_gate_check after implementation changes" }]),
    );
    expect(styled.some(({ tone, text }) => tone === "dim" && text.includes("Review iterations: 1"))).toBe(true);
    expect(widgetLines.length).toBeLessThanOrEqual(4);
  });

  it("renders a scrolling rainbow-gradient YOLO badge beside the feature label when yolo mode is active", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const workDir = makeTempDir("ralph-yolo-widget-work-");
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
          yoloMode: true,
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
    expect(ctx.ui.setWidget).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(160);

    expect(ctx.ui.setWidget).toHaveBeenCalledTimes(2);
    const firstWidgetLines = ctx.ui.setWidget.mock.calls[0]?.[1] as string[];
    const secondWidgetLines = ctx.ui.setWidget.mock.calls[1]?.[1] as string[];
    const firstHeader = firstWidgetLines[0];
    const secondHeader = secondWidgetLines[0];
    const visibleHeader = stripAnsi(firstHeader);
    expect(visibleHeader).toContain("fast-ui");
    expect(visibleHeader.indexOf("fast-ui")).toBeLessThan(visibleHeader.indexOf("YOLO"));
    expect(visibleHeader).toContain("fast-ui · YOLO");
    expect(firstHeader).toMatch(/\u001b\[38;2;\d+;\d+;\d+mY/);
    expect(firstHeader).toMatch(/\u001b\[38;2;\d+;\d+;\d+mO/);
    expect(secondHeader).not.toBe(firstHeader);
    expect(stripAnsi(secondHeader)).toContain("fast-ui · YOLO");
    expect(secondWidgetLines.length).toBeLessThanOrEqual(4);
  });

  it("dedupes identical widget renders across fresh event contexts", async () => {
    const workDir = makeTempDir("ralph-stream-widget-context-work-");
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

    const firstCtx = makeFakeContext(branch, workDir);
    const secondCtx = makeFakeContext(branch, workDir);
    secondCtx.ui = firstCtx.ui;
    const messageUpdate = handlers.get("message_update");
    expect(messageUpdate).toBeTypeOf("function");

    await messageUpdate?.({ message: { role: "assistant" } }, firstCtx);
    await messageUpdate?.({ message: { role: "assistant" } }, secondCtx);

    expect(firstCtx.ui.setWidget).toHaveBeenCalledTimes(1);
  });

  it("keeps full-pipeline transition widgets within Pi's visible line budget", async () => {
    const workDir = makeTempDir("ralph-transition-widget-work-");
    const skillBase = makeTempDir("ralph-transition-widget-skills-");
    process.env.PI_SKILL_BASE = skillBase;

    fs.mkdirSync(path.join(workDir, "docs", "specs"), { recursive: true });
    fs.writeFileSync(
      path.join(workDir, "docs", "specs", "feature-a.md"),
      `---
title: Feature A
status: hardened
---

# Feature A

${"Hardened spec body.\n".repeat(128)}`,
      "utf-8",
    );
    fs.writeFileSync(path.join(workDir, "docs", "specs", "harden-changelog-feature-a.md"), "Changelog", "utf-8");

    fs.mkdirSync(path.join(skillBase, "markdown-to-html"), { recursive: true });
    fs.writeFileSync(path.join(skillBase, "markdown-to-html", "SKILL.md"), "# Markdown to HTML", "utf-8");

    const branch: FakeEntry[] = [
      {
        type: "custom",
        customType: "ralph-loop-state",
        data: {
          feature: "feature-a",
          workDir,
          phases: ["spec", "redteam", "harden", "render", "implement", "review"],
          maxIterations: 10,
          startedAt: Date.now(),
          currentPhase: "harden",
          currentPhaseIndex: 2,
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
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: `Hardened spec is complete.\n\n${PHASE_COMPLETE_MARKER}` }],
          },
        ],
      },
      ctx,
    );

    const widgetCalls = ctx.ui.setWidget.mock.calls.map((call) => call[1] as string[]);
    expect(widgetCalls.length).toBeGreaterThanOrEqual(2);

    for (const call of ctx.ui.setWidget.mock.calls) {
      const lines = call[1] as string[];
      expect(lines.length).toBeLessThanOrEqual(4);
      expect(call[2]).toEqual({ placement: "belowEditor" });
      expect(lines.join("\n")).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/);
    }

    const renderedTransition = widgetCalls.map((lines) => lines.join("\n")).join("\n\n");
    expect(renderedTransition).toContain("PREPARING");
    expect(renderedTransition).toContain("RUNNING");
    expect(renderedTransition).toContain("▶ 4/6 Render Markdown → HTML");
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

  it("explains likely worktree mismatches when a spec artifact is outside state.workDir", async () => {
    const primaryDir = makeTempDir("ralph-primary-artifact-root-");
    childProcess.execFileSync("git", ["init"], { cwd: primaryDir });
    fs.writeFileSync(path.join(primaryDir, "README.md"), "# test repo\n", "utf-8");
    childProcess.execFileSync("git", ["add", "."], { cwd: primaryDir });
    childProcess.execFileSync(
      "git",
      ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "init"],
      {
        cwd: primaryDir,
      },
    );

    const worktreeDir = makeTempDir("ralph-linked-artifact-root-");
    fs.rmSync(worktreeDir, { recursive: true, force: true });
    childProcess.execFileSync("git", ["worktree", "add", worktreeDir, "-b", "artifact-root"], { cwd: primaryDir });
    tempDirs.push(worktreeDir);

    fs.mkdirSync(path.join(worktreeDir, "docs", "specs"), { recursive: true });
    fs.writeFileSync(
      path.join(worktreeDir, "docs", "specs", "feature-a.md"),
      `# Feature A\n\n${"Spec body.\n".repeat(256)}`,
      "utf-8",
    );

    const branch: FakeEntry[] = [];
    branch.push({
      type: "custom",
      customType: "ralph-loop-state",
      data: {
        feature: "feature-a",
        workDir: primaryDir,
        phases: ["spec"],
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
      makeFakeContext(branch, primaryDir),
    );

    const failureMessage = String(sendUserMessages[0]?.content);
    expect(failureMessage).toContain("Expected workDir:");
    expect(failureMessage).toContain(primaryDir);
    expect(failureMessage).toContain(path.join(primaryDir, "docs", "specs", "feature-a.md"));
    expect(failureMessage).toContain(worktreeDir);
    expect(failureMessage).toContain("ralph_set_workdir");
    expect(failureMessage).toContain("Spec not found");
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
