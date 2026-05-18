import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

interface FakeEntry {
  type: string;
  customType?: string;
  data?: unknown;
}

function makeFakePi(branch: FakeEntry[]) {
  const commands = new Map<string, (args: string, ctx: any) => unknown>();
  const sendUserMessages: Array<{ content: unknown; options?: { deliverAs?: string } }> = [];

  const pi = {
    on(): void {},
    registerTool(): void {},
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

  return { pi, commands, sendUserMessages };
}

function makeFakeContext(branch: FakeEntry[], cwd: string) {
  return {
    cwd,
    sessionManager: {
      getBranch: () => branch,
    },
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
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

describe("/ralph continue", () => {
  it("allows users to opt in to HTML rendering while continuing before render would run", async () => {
    const workDir = makeTempDir("ralph-continue-render-opt-in-");
    const skillBase = makeTempDir("ralph-continue-render-opt-in-skills-");
    process.env.PI_SKILL_BASE = skillBase;

    fs.mkdirSync(path.join(skillBase, "harden-spec"), { recursive: true });
    fs.writeFileSync(path.join(skillBase, "harden-spec", "SKILL.md"), "# Harden Spec", "utf-8");
    fs.mkdirSync(path.join(workDir, "docs", "specs"), { recursive: true });
    fs.mkdirSync(path.join(workDir, "docs", "security"), { recursive: true });
    fs.writeFileSync(path.join(workDir, "docs", "specs", "feature-a.md"), "# Feature A", "utf-8");
    fs.writeFileSync(
      path.join(workDir, "docs", "security", "redteam-findings-feature-a.md"),
      "[WARNING] test",
      "utf-8",
    );

    const branch: FakeEntry[] = [
      {
        type: "custom",
        customType: "ralph-loop-state",
        data: {
          feature: "feature-a",
          workDir,
          phases: ["spec", "redteam", "harden", "implement", "review"],
          maxIterations: 10,
          startedAt: Date.now(),
          currentPhase: "harden",
          currentPhaseIndex: 2,
          phaseStatus: "executing",
          pipelineStatus: "running",
          reviewIterations: 0,
          phaseAttempts: 1,
          turnWriteCount: 1,
          autoClearContext: false,
        },
      },
    ];

    const { default: registerExtension } = await import("../index");
    const { pi, commands, sendUserMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    await commands.get("ralph")?.("continue --render-html", makeFakeContext(branch, workDir));

    expect(sendUserMessages).toHaveLength(1);
    expect(String(sendUserMessages[0]?.content)).toContain("Phase: Harden Spec");

    const latestState = branch[branch.length - 1]?.data as {
      currentPhase?: string;
      currentPhaseIndex?: number;
      phases?: string[];
      promptText?: string;
    };
    expect(latestState.phases).toEqual(["spec", "redteam", "harden", "render", "implement", "review"]);
    expect(latestState.currentPhase).toBe("harden");
    expect(latestState.currentPhaseIndex).toBe(2);
    expect(latestState.promptText).toBeUndefined();
  });

  it("relaunches the saved current phase without advancing past completion markers", async () => {
    const workDir = makeTempDir("ralph-continue-work-");
    const skillBase = makeTempDir("ralph-continue-skills-");
    process.env.PI_SKILL_BASE = skillBase;

    fs.mkdirSync(path.join(skillBase, "generate-spec"), { recursive: true });
    fs.writeFileSync(path.join(skillBase, "generate-spec", "SKILL.md"), "# Generate Spec", "utf-8");
    fs.mkdirSync(path.join(workDir, ".ralph"), { recursive: true });
    fs.writeFileSync(path.join(workDir, ".ralph", ".phase-spec-done"), "{}", "utf-8");

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
          phaseAttempts: 2,
          turnWriteCount: 1,
          autoClearContext: false,
        },
      },
    ];

    const { default: registerExtension } = await import("../index");
    const { pi, commands, sendUserMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    const ralph = commands.get("ralph");
    expect(ralph).toBeTypeOf("function");

    await ralph?.("continue", makeFakeContext(branch, workDir));

    expect(sendUserMessages).toHaveLength(1);
    expect(String(sendUserMessages[0]?.content)).toContain("Phase: Generate Spec");
    expect(String(sendUserMessages[0]?.content)).not.toContain("Phase: Red Team Audit");

    const latestState = branch[branch.length - 1]?.data as {
      currentPhase?: string;
      currentPhaseIndex?: number;
      phaseStatus?: string;
      pipelineStatus?: string;
      phaseAttempts?: number;
      turnWriteCount?: number;
    };
    expect(latestState.currentPhase).toBe("spec");
    expect(latestState.currentPhaseIndex).toBe(0);
    expect(latestState.phaseStatus).toBe("executing");
    expect(latestState.pipelineStatus).toBe("running");
    expect(latestState.phaseAttempts).toBe(0);
    expect(latestState.turnWriteCount).toBe(0);
  });

  it("approves the pre-implementation checkpoint and launches TDD", async () => {
    const workDir = makeTempDir("ralph-continue-implement-checkpoint-");
    const skillBase = makeTempDir("ralph-continue-implement-checkpoint-skills-");
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
          phases: ["spec", "implement", "review"],
          maxIterations: 10,
          startedAt: Date.now(),
          currentPhase: "implement",
          currentPhaseIndex: 1,
          phaseStatus: "waiting_for_user",
          waitingReason: "implement_checkpoint",
          pipelineStatus: "running",
          reviewIterations: 0,
          phaseAttempts: 0,
          turnWriteCount: 0,
          autoClearContext: false,
        },
      },
    ];

    const { default: registerExtension } = await import("../index");
    const { pi, commands, sendUserMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    await commands.get("ralph")?.("continue", makeFakeContext(branch, workDir));

    expect(sendUserMessages).toHaveLength(1);
    expect(String(sendUserMessages[0]?.content)).toContain("Phase: TDD Implement");

    const latestState = branch[branch.length - 1]?.data as {
      phaseStatus?: string;
      waitingReason?: string;
      implementCheckpointApproved?: boolean;
    };
    expect(latestState.phaseStatus).toBe("executing");
    expect(latestState.waitingReason).toBeUndefined();
    expect(latestState.implementCheckpointApproved).toBe(true);
  });

  it("enables HTML rendering from the pre-implementation checkpoint before launching TDD", async () => {
    const workDir = makeTempDir("ralph-continue-checkpoint-render-");
    const skillBase = makeTempDir("ralph-continue-checkpoint-render-skills-");
    process.env.PI_SKILL_BASE = skillBase;

    fs.mkdirSync(path.join(skillBase, "markdown-to-html"), { recursive: true });
    fs.writeFileSync(path.join(skillBase, "markdown-to-html", "SKILL.md"), "# Markdown to HTML", "utf-8");
    fs.mkdirSync(path.join(skillBase, "tdd-implement"), { recursive: true });
    fs.writeFileSync(path.join(skillBase, "tdd-implement", "SKILL.md"), "# TDD Implement", "utf-8");
    fs.mkdirSync(path.join(workDir, "docs", "specs"), { recursive: true });
    fs.writeFileSync(
      path.join(workDir, "docs", "specs", "feature-a.md"),
      "---\nstatus: hardened\n---\n# Feature A\n",
      "utf-8",
    );

    const branch: FakeEntry[] = [
      {
        type: "custom",
        customType: "ralph-loop-state",
        data: {
          feature: "feature-a",
          workDir,
          phases: ["spec", "redteam", "harden", "implement", "review"],
          maxIterations: 10,
          startedAt: Date.now(),
          currentPhase: "implement",
          currentPhaseIndex: 3,
          phaseStatus: "waiting_for_user",
          waitingReason: "implement_checkpoint",
          pipelineStatus: "running",
          reviewIterations: 0,
          phaseAttempts: 0,
          turnWriteCount: 0,
          autoClearContext: false,
        },
      },
    ];

    const { default: registerExtension } = await import("../index");
    const { pi, commands, sendUserMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    await commands.get("ralph")?.("continue --render-html", makeFakeContext(branch, workDir));

    expect(sendUserMessages).toHaveLength(1);
    expect(String(sendUserMessages[0]?.content)).toContain("Phase: Render Markdown");

    const latestState = branch[branch.length - 1]?.data as {
      currentPhase?: string;
      currentPhaseIndex?: number;
      phases?: string[];
      phaseStatus?: string;
      waitingReason?: string;
      implementCheckpointApproved?: boolean;
    };
    expect(latestState.phases).toEqual(["spec", "redteam", "harden", "render", "implement", "review"]);
    expect(latestState.currentPhase).toBe("render");
    expect(latestState.currentPhaseIndex).toBe(3);
    expect(latestState.phaseStatus).toBe("executing");
    expect(latestState.waitingReason).toBeUndefined();
    expect(latestState.implementCheckpointApproved).toBe(true);
  });

  it("does not leave a redundant bottom resume status when the compact widget shows a blocked run", async () => {
    const workDir = makeTempDir("ralph-resume-blocked-widget-");
    const skillBase = makeTempDir("ralph-resume-blocked-widget-skills-");
    process.env.PI_SKILL_BASE = skillBase;

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
          currentPhase: "redteam",
          currentPhaseIndex: 1,
          phaseStatus: "pre_hook",
          pipelineStatus: "failed",
          reviewIterations: 0,
          phaseAttempts: 0,
          turnWriteCount: 0,
          autoClearContext: false,
        },
      },
    ];

    const { default: registerExtension } = await import("../index");
    const { pi, commands, sendUserMessages } = makeFakePi(branch);
    registerExtension(pi as any);
    const ctx = makeFakeContext(branch, workDir);

    await commands.get("ralph")?.("resume", ctx);

    expect(sendUserMessages).toHaveLength(0);
    const widgetText = (ctx.ui.setWidget.mock.calls.at(-1)?.[1] as string[]).join("\n");
    expect(widgetText).toContain("Ralph · BLOCKED · feature-a");
    expect(widgetText).toContain("Fix the blocker, then run /ralph resume");
    expect(ctx.ui.setStatus).not.toHaveBeenCalledWith("ralph-loop", expect.stringContaining("Resuming |"));
  });
});

describe("/ralph clear-context", () => {
  it("keeps auto context clearing enabled after clear-context --auto completes", async () => {
    const workDir = makeTempDir("ralph-clear-context-auto-");
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
          autoClearContext: false,
        },
      },
    ];

    const { default: registerExtension } = await import("../index");
    const { pi, commands } = makeFakePi(branch);
    registerExtension(pi as any);

    const ctx = makeFakeContext(branch, workDir);
    await commands.get("ralph")?.("clear-context --auto", ctx);

    expect(ctx.compact).toHaveBeenCalledTimes(1);
    const compactOptions = ctx.compact.mock.calls[0]?.[0] as { onComplete?: () => void };
    compactOptions.onComplete?.();

    const latestState = branch[branch.length - 1]?.data as {
      autoClearContext?: boolean;
      contextClearCount?: number;
    };
    expect(latestState.autoClearContext).toBe(true);
    expect(latestState.contextClearCount).toBe(1);
  });
});
