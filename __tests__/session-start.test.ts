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

function makeFakeContext(branch: FakeEntry[], cwd: string) {
  return {
    cwd,
    isIdle: () => false,
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

function appendPipelineState(branch: FakeEntry[], workDir: string, phaseStatus: string, pipelineStatus: string): void {
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
      phaseStatus,
      pipelineStatus,
      reviewIterations: 0,
      phaseAttempts: 0,
      turnWriteCount: 0,
      autoClearContext: false,
    },
  });
}

function seedRedTeamPrereqs(workDir: string, skillBase: string): void {
  fs.mkdirSync(path.join(workDir, "docs", "specs"), { recursive: true });
  fs.writeFileSync(path.join(workDir, "docs", "specs", "feature-a.md"), "# Feature A\n", "utf-8");
  fs.mkdirSync(path.join(skillBase, "red-team-audit"), { recursive: true });
  fs.writeFileSync(path.join(skillBase, "red-team-audit", "SKILL.md"), "# Red Team Audit", "utf-8");
}

afterEach(() => {
  delete process.env.PI_SKILL_BASE;
  vi.resetModules();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("session_start reload behavior", () => {
  it("does not auto-resume when the pipeline is not running", async () => {
    const workDir = makeTempDir("ralph-session-stopped-work-");
    const branch: FakeEntry[] = [];
    appendPipelineState(branch, workDir, "executing", "failed");

    const { default: registerExtension } = await import("../index");
    const { pi, handlers, sendUserMessages, sendMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    const ctx = makeFakeContext(branch, workDir);
    const sessionStart = handlers.get("session_start");
    expect(sessionStart).toBeTypeOf("function");

    await sessionStart?.({}, ctx);

    expect(sendUserMessages).toHaveLength(0);
    expect(sendMessages).toHaveLength(0);
  });

  it("does not auto-resume when the pipeline is paused", async () => {
    const workDir = makeTempDir("ralph-session-paused-work-");
    const branch: FakeEntry[] = [];
    appendPipelineState(branch, workDir, "post_hook", "paused");

    const { default: registerExtension } = await import("../index");
    const { pi, handlers, sendUserMessages, sendMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    const ctx = makeFakeContext(branch, workDir);
    const sessionStart = handlers.get("session_start");
    expect(sessionStart).toBeTypeOf("function");

    await sessionStart?.({}, ctx);

    expect(sendUserMessages).toHaveLength(0);
    expect(sendMessages).toHaveLength(0);
  });

  it("resumes the current phase as steer text when reload happens mid-phase", async () => {
    const workDir = makeTempDir("ralph-session-executing-work-");
    const skillBase = makeTempDir("ralph-session-executing-skills-");
    process.env.PI_SKILL_BASE = skillBase;
    seedRedTeamPrereqs(workDir, skillBase);

    const branch: FakeEntry[] = [];
    appendPipelineState(branch, workDir, "executing", "running");

    const { default: registerExtension } = await import("../index");
    const { pi, handlers, sendUserMessages, sendMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    const ctx = makeFakeContext(branch, workDir);
    const sessionStart = handlers.get("session_start");
    expect(sessionStart).toBeTypeOf("function");

    await sessionStart?.({}, ctx);

    expect(sendMessages).toHaveLength(0);
    expect(sendUserMessages).toHaveLength(1);
    expect(sendUserMessages[0]?.options?.deliverAs).toBe("steer");
    expect(String(sendUserMessages[0]?.content)).toContain("SESSION RELOAD");
    expect(String(sendUserMessages[0]?.content)).toContain("Phase 2: Red Team Audit");
  });

  it("launches a queued phase on reload without skipping past it", async () => {
    const workDir = makeTempDir("ralph-session-prehook-work-");
    const skillBase = makeTempDir("ralph-session-prehook-skills-");
    process.env.PI_SKILL_BASE = skillBase;
    seedRedTeamPrereqs(workDir, skillBase);

    const branch: FakeEntry[] = [];
    appendPipelineState(branch, workDir, "pre_hook", "running");

    const { default: registerExtension } = await import("../index");
    const { pi, handlers, sendUserMessages, sendMessages } = makeFakePi(branch);
    registerExtension(pi as any);

    const ctx = makeFakeContext(branch, workDir);
    const sessionStart = handlers.get("session_start");
    expect(sessionStart).toBeTypeOf("function");

    await sessionStart?.({}, ctx);

    expect(sendMessages).toHaveLength(0);
    expect(sendUserMessages).toHaveLength(1);
    expect(sendUserMessages[0]?.options?.deliverAs).toBe("steer");
    expect(String(sendUserMessages[0]?.content)).toContain("Launch queued Phase 2");
    expect(String(sendUserMessages[0]?.content)).toContain("Phase: Red Team Audit");

    const latestState = branch[branch.length - 1]?.data as {
      currentPhase?: string;
      currentPhaseIndex?: number;
      phaseStatus?: string;
    };
    expect(latestState.currentPhase).toBe("redteam");
    expect(latestState.currentPhaseIndex).toBe(1);
    expect(latestState.phaseStatus).toBe("executing");
  });
});
