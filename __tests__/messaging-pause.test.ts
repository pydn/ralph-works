import { afterEach, describe, expect, it, vi } from "vitest";
import { sendPipelineUserMessage } from "../src/messaging";

interface FakeEntry {
  type: string;
  customType?: string;
  data?: unknown;
}

function makeFakePi(branch: FakeEntry[]) {
  const sendUserMessages: Array<{ content: unknown; options?: { deliverAs?: string } }> = [];
  return {
    pi: {
      appendEntry(customType: string, data?: unknown): void {
        branch.push({ type: "custom", customType, data });
      },
      sendUserMessage(content: unknown, options?: { deliverAs?: string }): void {
        sendUserMessages.push({ content, options });
      },
    },
    sendUserMessages,
  };
}

function makeContext(branch: FakeEntry[], idleState: { idle: boolean }) {
  return {
    cwd: "/repo",
    isIdle: () => idleState.idle,
    sessionManager: {
      getBranch: () => branch,
    },
    ui: {
      notify: vi.fn(),
    },
  };
}

function pushState(branch: FakeEntry[], pipelineStatus: string): void {
  branch.push({
    type: "custom",
    customType: "ralph-loop-state",
    data: {
      feature: "feature-a",
      workDir: "/repo",
      phases: ["spec", "implement"],
      maxIterations: 10,
      startedAt: 1,
      currentPhase: "implement",
      currentPhaseIndex: 1,
      phaseStatus: "executing",
      pipelineStatus,
    },
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("pipeline message delivery after pause", () => {
  it("does not deliver a deferred follow-up after the pipeline is paused", async () => {
    vi.useFakeTimers();
    const branch: FakeEntry[] = [];
    pushState(branch, "running");
    const idleState = { idle: false };
    const { pi, sendUserMessages } = makeFakePi(branch);
    const ctx = makeContext(branch, idleState);

    sendPipelineUserMessage(pi as any, ctx as any, "queued Ralph follow-up", { deliverAs: "followUp" });
    pushState(branch, "paused");
    idleState.idle = true;

    await vi.advanceTimersByTimeAsync(25);

    expect(sendUserMessages).toHaveLength(0);
  });
});
