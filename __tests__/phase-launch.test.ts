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
});
