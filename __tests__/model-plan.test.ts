import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildModelPlanFromOptions,
  createModelSwitchEvent,
  formatModelSelector,
  parseModelSelector,
  parseRalphFlags,
  resolvePhaseModelSelector,
  selectorFromCurrentModel,
} from "../src/modelPlan";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("model selector parsing", () => {
  it("sanitizes persisted display labels and model-switch reasons", () => {
    const current = selectorFromCurrentModel(
      { provider: "anthropic", id: "claude", name: "\u001b[31mSneaky\nName" },
      "high",
    );
    expect(current?.displayName).toBe("Sneaky Name");

    const event = createModelSwitchEvent("failure", current, "failure", {
      reason: "Authorization: Bearer sk-secret\nrequest failed" + "x".repeat(400),
    });
    expect(event.reason).not.toContain("sk-secret");
    expect(event.reason).not.toContain("\n");
    expect(event.reason?.length).toBeLessThanOrEqual(300);
  });

  it("splits provider/model selectors and only treats final known suffixes as thinking levels", () => {
    expect(parseModelSelector("anthropic/claude-sonnet-4-5:high")).toEqual({
      ok: true,
      selector: {
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        thinkingLevel: "high",
        source: "cli",
        explicit: true,
      },
    });

    const ollama = parseModelSelector("ollama/qwen2.5-coder:7b:off");
    expect(ollama.ok).toBe(true);
    if (ollama.ok) {
      expect(ollama.selector.model).toBe("qwen2.5-coder:7b");
      expect(ollama.selector.thinkingLevel).toBe("off");
      expect(formatModelSelector(ollama.selector)).toBe("ollama/qwen2.5-coder:7b:off");
    }
  });

  it("rejects unsafe or ambiguous selector text", () => {
    expect(parseModelSelector("bad provider/model").ok).toBe(false);
    expect(parseModelSelector("anthropic/model\nspoof").ok).toBe(false);
    expect(parseModelSelector(`anthropic/${"x".repeat(201)}`).ok).toBe(false);
    expect(parseModelSelector("anthropic/model:ultra")).toEqual({
      ok: false,
      error: "Unsupported thinking level: ultra",
    });
  });
});

describe("ralph-works model flag parsing", () => {
  it("preserves prompt and phase args while extracting model flags", () => {
    const parsed = parseRalphFlags([
      "quoted prompt",
      "spec,implement",
      "--model",
      "anthropic/claude-sonnet-4-5:medium",
      "--models",
      "implement=anthropic/claude-opus-4-5:xhigh",
      "--render-html",
      "--yolo",
      "--allow-weak-model",
    ]);

    expect(parsed.args).toEqual(["quoted prompt", "spec,implement"]);
    expect(parsed.renderHtml).toBe(true);
    expect(parsed.yolo).toBe(true);
    expect(parsed.allowWeakModel).toBe(true);
    expect(parsed.model).toBe("anthropic/claude-sonnet-4-5:medium");
    expect(parsed.models).toBe("implement=anthropic/claude-opus-4-5:xhigh");
  });

  it("ignores untrusted workspace model-plan config but accepts it with --trust-model-plan", () => {
    const workDir = makeTempDir("ralph-model-plan-");
    fs.mkdirSync(path.join(workDir, ".ralph"), { recursive: true });
    fs.writeFileSync(
      path.join(workDir, ".ralph", "model-plan.json"),
      JSON.stringify({
        version: "1.0",
        default: { provider: "anthropic", model: "claude-sonnet-4-5", thinkingLevel: "high" },
        phases: { review: { provider: "anthropic", model: "claude-opus-4-5", thinkingLevel: "xhigh" } },
      }),
      "utf-8",
    );

    const ignored = buildModelPlanFromOptions(parseRalphFlags([]), ["spec", "review"], workDir);
    expect(ignored.plan).toBeUndefined();
    expect(ignored.warnings).toContain("Workspace model plan ignored because --trust-model-plan was not provided.");

    const trusted = buildModelPlanFromOptions(parseRalphFlags(["--trust-model-plan"]), ["spec", "review"], workDir);
    expect(trusted.errors).toEqual([]);
    expect(trusted.plan?.trustApproved).toBe(true);
    expect(trusted.plan?.trustSource).toBe("cli-flag");
    expect(resolvePhaseModelSelector(trusted.plan, "review")?.provider).toBe("anthropic");
    expect(resolvePhaseModelSelector(trusted.plan, "review")?.model).toBe("claude-opus-4-5");
  });
});
