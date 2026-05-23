import { describe, expect, it } from "vitest";
import { appendReviewTasks, parseTaskLedger, updateTaskStatus } from "../src/taskLedger";

const LEDGER = `# Implementation Tasks - feature-a

Spec: docs/specs/feature-a.md
Status: active
Version: 1

## Tasks

### TASK-0001: Add selected task state
- Status: complete
- Priority: P0
- Source: hardened_spec
- Depends On: none
- Review Finding Ref: none
- Files Hint: src/domain.ts
- Created: 2026-05-23T00:00:00.000Z
- Updated: 2026-05-23T00:00:00.000Z
- Completed: 2026-05-23T00:01:00.000Z

#### Acceptance Criteria
- PipelineState persists selectedTask.

#### Test Plan
- Unit test selected task serialization.

#### Notes
- Done.

### TASK-0002: Implement task selector
- Status: pending
- Priority: P1
- Source: hardened_spec
- Depends On: TASK-0001
- Review Finding Ref: none
- Files Hint: src/taskLedger.ts, src/extension.ts
- Created: 2026-05-23T00:00:00.000Z
- Updated: 2026-05-23T00:00:00.000Z
- Completed: none

#### Acceptance Criteria
- Selector prompt can read the task details.
- Controller can persist the selected task.

#### Test Plan
- Unit test task parsing.
- Unit test status updates.

#### Notes
- Ready.

### TASK-0003: Blocked prerequisite
- Status: blocked
- Priority: P0
- Source: hardened_spec
- Depends On: none
- Review Finding Ref: none
- Files Hint: src/extension.ts
- Created: 2026-05-23T00:00:00.000Z
- Updated: 2026-05-23T00:00:00.000Z
- Completed: none

#### Acceptance Criteria
- Blocked tasks are not selected.

#### Test Plan
- Unit test blocked skip.

#### Notes
- Missing dependency.
`;

describe("parseTaskLedger", () => {
  it("parses strict Markdown task entries into controller task objects", () => {
    const ledger = parseTaskLedger(LEDGER);

    expect(ledger.feature).toBe("feature-a");
    expect(ledger.specPath).toBe("docs/specs/feature-a.md");
    expect(ledger.tasks).toHaveLength(3);
    expect(ledger.tasks[1]).toMatchObject({
      id: "TASK-0002",
      title: "Implement task selector",
      status: "pending",
      priority: "P1",
      source: "hardened_spec",
      dependsOn: ["TASK-0001"],
      filesHint: ["src/taskLedger.ts", "src/extension.ts"],
      acceptanceCriteria: ["Selector prompt can read the task details.", "Controller can persist the selected task."],
      testPlan: ["Unit test task parsing.", "Unit test status updates."],
    });
  });
});

describe("updateTaskStatus", () => {
  it("updates only the selected task metadata and preserves the rest of the ledger", () => {
    const updated = updateTaskStatus(LEDGER, "TASK-0002", "complete", "2026-05-23T00:02:00.000Z");
    const ledger = parseTaskLedger(updated);

    expect(ledger.tasks.find((task) => task.id === "TASK-0001")?.status).toBe("complete");
    expect(ledger.tasks.find((task) => task.id === "TASK-0002")).toMatchObject({
      status: "complete",
      updatedAt: "2026-05-23T00:02:00.000Z",
      completedAt: "2026-05-23T00:02:00.000Z",
    });
    expect(updated).toContain("### TASK-0003: Blocked prerequisite");
  });
});

describe("appendReviewTasks", () => {
  it("appends CRITICAL review remediation tasks using the next stable IDs", () => {
    const updated = appendReviewTasks(
      LEDGER,
      [
        {
          title: "Restore selector after review CRITICAL",
          priority: "P0",
          reviewFindingRef: "review-1 finding-1",
          acceptanceCriteria: ["Critical review finding is fixed."],
          testPlan: ["Regression test fails before the fix."],
          filesHint: ["src/extension.ts"],
        },
      ],
      "2026-05-23T00:03:00.000Z",
    );

    const ledger = parseTaskLedger(updated);
    expect(ledger.tasks.at(-1)).toMatchObject({
      id: "TASK-0004",
      title: "Restore selector after review CRITICAL",
      status: "pending",
      priority: "P0",
      source: "review_critical",
      reviewFindingRef: "review-1 finding-1",
    });
  });
});
