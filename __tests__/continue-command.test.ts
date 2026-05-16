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
  it("relaunches the saved current phase without advancing past completion markers", async () => {
    const workDir = makeTempDir("ralph-continue-work-");
    const skillBase = makeTempDir("ralph-continue-skills-");
    process.env.PI_SKILL_BASE = skillBase;

    fs.mkdirSync(path.join(skillBase, "generate-spec"), { recursive: true });
    fs.writeFileSync(path.join(skillBase, "generate-spec", "SKILL.md"), "# Generate Spec", "utf-8");
    fs.mkdirSync(path.join(workDir, ".ralph"), { recursive: true });
    fs.writeFileSync(path.join(workDir, ".ralph", ".phase-spec-done"), "{}", "utf-8");

    const branch: FakeEntry[] = [{
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
    }];

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
});
