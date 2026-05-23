import { describe, expect, it } from "vitest";
import { appendReviewTasks } from "../src/taskLedger";

const LEDGER = `# Implementation Tasks - feature-a

Spec: docs/specs/feature-a.md
Status: active
Version: 1

## Tasks

### TASK-0001: Existing completed task
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
- Existing behavior works.

#### Test Plan
- Existing test passes.

#### Notes
- Done.
`;

describe("appendReviewTasks", () => {
  it("appends CRITICAL review remediation tasks without parsing the existing ledger", () => {
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

    expect(updated).toContain("### TASK-REVIEW-20260523000300-001: Restore selector after review CRITICAL");
    expect(updated).toContain("- Status: pending");
    expect(updated).toContain("- Priority: P0");
    expect(updated).toContain("- Source: review_critical");
    expect(updated).toContain("- Review Finding Ref: review-1 finding-1");
    expect(updated).toContain("- Critical review finding is fixed.");
    expect(updated).toContain("- Regression test fails before the fix.");
  });
});
