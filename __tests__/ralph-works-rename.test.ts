import { describe, expect, it, vi } from "vitest";
import { refreshWidget } from "../src/widget";

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("ralph-works rename", () => {
  it("registers /ralph-works as the user-facing command", async () => {
    const commands = new Map<string, unknown>();
    const pi = {
      on(): void {},
      registerTool(): void {},
      registerCommand(name: string, config: unknown): void {
        commands.set(name, config);
      },
    };

    const { default: registerExtension } = await import("../index");
    registerExtension(pi as any);

    expect(commands.has("ralph-works")).toBe(true);
    expect(commands.has("ralph")).toBe(false);
  });

  it("renders ralph-works as the widget product wordmark", () => {
    const styled: Array<{ tone: string; text: string }> = [];
    const ctx = {
      ui: {
        setWidget: vi.fn(),
        theme: {
          fg: (tone: string, text: string) => {
            styled.push({ tone, text });
            return text;
          },
        },
      },
    };

    refreshWidget(ctx as any, {
      feature: "feature-a",
      workDir: "/tmp/work",
      phases: ["spec", "implement"],
      maxIterations: 10,
      startedAt: 1,
      currentPhase: "spec",
      currentPhaseIndex: 0,
      phaseStatus: "executing",
      pipelineStatus: "running",
      reviewIterations: 0,
      phaseAttempts: 0,
      turnWriteCount: 0,
      autoClearContext: false,
    });

    const widgetLines = ctx.ui.setWidget.mock.calls[0]?.[1] as string[];
    expect(stripAnsi(widgetLines.join("\n"))).toContain("ralph-works");
    expect(widgetLines[0]).toContain("\u001b[38;2;38;54;61mralph\u001b[39m");
    expect(widgetLines[0]).toContain("\u001b[38;2;230;165;27m-\u001b[39m");
    expect(widgetLines[0]).toContain("\u001b[38;2;38;54;61mworks\u001b[39m");
    expect(styled).toEqual(expect.arrayContaining([{ tone: "accent", text: "RUNNING" }]));
  });
});
