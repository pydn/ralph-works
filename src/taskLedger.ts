import type { RalphReviewTaskInput } from "./domain";

function formatReviewTaskId(timestamp: string, index: number): string {
  const compactTimestamp = timestamp.replace(/\D/g, "").slice(0, 14) || String(Date.now());
  return `TASK-REVIEW-${compactTimestamp}-${String(index + 1).padStart(3, "0")}`;
}

function taskBlock(task: RalphReviewTaskInput, id: string, timestamp: string): string {
  return `### ${id}: ${task.title}
- Status: pending
- Priority: ${task.priority}
- Source: review_critical
- Depends On: none
- Review Finding Ref: ${task.reviewFindingRef ?? "none"}
- Files Hint: ${task.filesHint.length ? task.filesHint.join(", ") : "none"}
- Created: ${timestamp}
- Updated: ${timestamp}
- Completed: none

#### Acceptance Criteria
${task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}

#### Test Plan
${task.testPlan.map((item) => `- ${item}`).join("\n")}

#### Notes
- Generated from review CRITICAL findings.
`;
}

export function appendReviewTasks(
  content: string,
  reviewTasks: RalphReviewTaskInput[],
  timestamp = new Date().toISOString(),
): string {
  const blocks = reviewTasks.map((task, index) => taskBlock(task, formatReviewTaskId(timestamp, index), timestamp));
  const trimmed = content.trimEnd();
  return `${trimmed}\n\n${blocks.join("\n")}`;
}
