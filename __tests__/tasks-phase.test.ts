import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PipelineState, RalphImplementationTask } from "../src/domain";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function taskLedger(feature: string): string {
  return `# Implementation Tasks - ${feature}

Spec: docs/specs/${feature}.md
Status: active
Version: 1

## Tasks

### TASK-0001: Add task support
- Status: pending
- Priority: P0
- Source: hardened_spec
- Depends On: none
- Review Finding Ref: none
- Files Hint: src/domain.ts
- Created: 2026-05-23T00:00:00.000Z
- Updated: 2026-05-23T00:00:00.000Z
- Completed: none

#### Acceptance Criteria
- Task state is persisted.

#### Test Plan
- Unit test task parsing.

#### Notes
- Ready.
`;
}

afterEach(() => {
  delete process.env.PI_SKILL_BASE;
  vi.resetModules();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("tasks phase", () => {
  it("validates a strict Markdown task ledger as the tasks phase artifact", async () => {
    const workDir = makeTempDir("ralph-tasks-phase-");
    fs.mkdirSync(path.join(workDir, "docs", "specs"), { recursive: true });
    fs.writeFileSync(path.join(workDir, "docs", "specs", "todo_feature-a.md"), taskLedger("feature-a"), "utf-8");

    const { runPostHook } = await import("../src/phaseConfig");

    const result = runPostHook("tasks", {
      feature: "feature-a",
      workDir,
      phases: ["spec", "redteam", "harden", "tasks", "implement", "review"],
      maxIterations: 10,
      startedAt: Date.now(),
    });

    expect(result).toEqual({ pass: true });
  });

  it("exposes the task ledger as an expected tasks phase artifact", async () => {
    const { getExpectedArtifactPaths } = await import("../src/workdir");
    const paths = getExpectedArtifactPaths("tasks", {
      feature: "feature-a",
      workDir: "/workspace/project",
      phases: [],
      maxIterations: 10,
      startedAt: 0,
    });

    expect(paths.map((item) => item.relativePath)).toEqual(["docs/specs/todo_feature-a.md"]);
  });
});

describe("task-scoped implement prompt", () => {
  it("includes the selected task and task file in the implement prompt", async () => {
    const selectedTask: RalphImplementationTask = {
      id: "TASK-0001",
      title: "Add task support",
      priority: "P0",
      status: "in_progress",
      source: "hardened_spec",
      acceptanceCriteria: ["Task state is persisted."],
      testPlan: ["Unit test task parsing."],
      filesHint: ["src/domain.ts"],
      dependsOn: [],
      createdAt: "2026-05-23T00:00:00.000Z",
      updatedAt: "2026-05-23T00:00:00.000Z",
    };
    const { buildPhasePrompt } = await import("../src/prompts");
    const prompt = buildPhasePrompt("implement", {
      feature: "feature-a",
      workDir: "/workspace/project",
      phases: ["tasks", "implement"],
      maxIterations: 10,
      startedAt: 0,
      taskFile: "docs/specs/todo_feature-a.md",
      selectedTask,
    } satisfies PipelineState);

    expect(prompt).toContain("## Selected Task");
    expect(prompt).toContain("<selected_task>");
    expect(prompt).toContain("id: TASK-0001");
    expect(prompt).toContain("Task ledger: docs/specs/todo_feature-a.md");
    expect(prompt).toContain("may not implement adjacent pending tasks");
    expect(prompt).toContain("RALPH_TASK_COMPLETE");
    expect(prompt).toContain("Do not use `RALPH_PHASE_COMPLETE` during implement");
    expect(prompt).not.toContain("complete with the phase marker");
    expect(prompt).not.toContain("When this phase is fully complete");
  });
});
