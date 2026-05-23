import type { RalphImplementationTask, RalphReviewTaskInput, RalphTaskStatus } from "./domain";

export interface RalphTaskLedger {
  feature: string;
  specPath?: string;
  status?: string;
  version?: number;
  tasks: RalphImplementationTask[];
}

const TASK_HEADING_RE = /^### (TASK-\d{4}): (.+)$/gm;

function metadataValue(block: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = block.match(new RegExp(`^- ${escaped}:\\s*(.*)$`, "im"));
  return match?.[1]?.trim();
}

function rootValue(content: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(new RegExp(`^${escaped}:\\s*(.*)$`, "im"));
  return match?.[1]?.trim();
}

function listValue(value: string | undefined): string[] {
  if (!value || value.toLowerCase() === "none") return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function sectionBullets(block: string, heading: string): string[] {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = block.match(new RegExp(`^#### ${escaped}\\s*$([\\s\\S]*?)(?=^#### |^### |\\z)`, "im"));
  if (!match) return [];
  return match[1]
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*-\s+(.*)$/)?.[1]?.trim())
    .filter((line): line is string => Boolean(line));
}

function parseTaskBlock(id: string, title: string, block: string): RalphImplementationTask {
  const status = metadataValue(block, "Status") as RalphTaskStatus | undefined;
  const priority = metadataValue(block, "Priority") as RalphImplementationTask["priority"] | undefined;
  const source = metadataValue(block, "Source") as RalphImplementationTask["source"] | undefined;
  const reviewFindingRef = metadataValue(block, "Review Finding Ref");
  const completed = metadataValue(block, "Completed");
  return {
    id,
    title: title.trim(),
    status: status ?? "pending",
    priority: priority ?? "P3",
    source: source ?? "hardened_spec",
    dependsOn: listValue(metadataValue(block, "Depends On")),
    reviewFindingRef: reviewFindingRef && reviewFindingRef.toLowerCase() !== "none" ? reviewFindingRef : undefined,
    filesHint: listValue(metadataValue(block, "Files Hint")),
    createdAt: metadataValue(block, "Created") ?? "",
    updatedAt: metadataValue(block, "Updated") ?? "",
    completedAt: completed && completed.toLowerCase() !== "none" ? completed : undefined,
    acceptanceCriteria: sectionBullets(block, "Acceptance Criteria"),
    testPlan: sectionBullets(block, "Test Plan"),
  };
}

export function parseTaskLedger(content: string): RalphTaskLedger {
  const feature = content.match(/^# Implementation Tasks - (.+)$/m)?.[1]?.trim() ?? "";
  const matches = [...content.matchAll(TASK_HEADING_RE)];
  const tasks = matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = index + 1 < matches.length ? (matches[index + 1].index ?? content.length) : content.length;
    return parseTaskBlock(match[1], match[2], content.slice(start, end));
  });
  return {
    feature,
    specPath: rootValue(content, "Spec"),
    status: rootValue(content, "Status"),
    version: Number(rootValue(content, "Version") ?? 0) || undefined,
    tasks,
  };
}

function replaceMetadata(block: string, label: string, value: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^- ${escaped}:\\s*.*$`, "im");
  if (re.test(block)) return block.replace(re, `- ${label}: ${value}`);
  return block.replace(/(\n#### Acceptance Criteria)/, `\n- ${label}: ${value}$1`);
}

export function updateTaskStatus(
  content: string,
  taskId: string,
  status: RalphTaskStatus,
  timestamp = new Date().toISOString(),
): string {
  const matches = [...content.matchAll(TASK_HEADING_RE)];
  const matchIndex = matches.findIndex((match) => match[1] === taskId);
  if (matchIndex < 0) return content;
  const start = matches[matchIndex].index ?? 0;
  const end = matchIndex + 1 < matches.length ? (matches[matchIndex + 1].index ?? content.length) : content.length;
  let block = content.slice(start, end);
  block = replaceMetadata(block, "Status", status);
  block = replaceMetadata(block, "Updated", timestamp);
  block = replaceMetadata(block, "Completed", status === "complete" ? timestamp : "none");
  return `${content.slice(0, start)}${block}${content.slice(end)}`;
}

function nextTaskNumber(tasks: RalphImplementationTask[]): number {
  return (
    tasks.reduce((max, task) => {
      const numeric = Number(task.id.replace(/^TASK-/, ""));
      return Number.isFinite(numeric) ? Math.max(max, numeric) : max;
    }, 0) + 1
  );
}

function formatTaskId(value: number): string {
  return `TASK-${String(value).padStart(4, "0")}`;
}

function taskBlock(task: RalphImplementationTask): string {
  return `### ${task.id}: ${task.title}
- Status: ${task.status}
- Priority: ${task.priority}
- Source: ${task.source}
- Depends On: ${task.dependsOn.length ? task.dependsOn.join(", ") : "none"}
- Review Finding Ref: ${task.reviewFindingRef ?? "none"}
- Files Hint: ${task.filesHint.length ? task.filesHint.join(", ") : "none"}
- Created: ${task.createdAt}
- Updated: ${task.updatedAt}
- Completed: ${task.completedAt ?? "none"}

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
  const ledger = parseTaskLedger(content);
  let next = nextTaskNumber(ledger.tasks);
  const blocks = reviewTasks.map((task) => {
    const fullTask: RalphImplementationTask = {
      id: formatTaskId(next++),
      title: task.title,
      status: "pending",
      priority: task.priority,
      source: "review_critical",
      dependsOn: [],
      reviewFindingRef: task.reviewFindingRef,
      filesHint: task.filesHint,
      createdAt: timestamp,
      updatedAt: timestamp,
      acceptanceCriteria: task.acceptanceCriteria,
      testPlan: task.testPlan,
    };
    return taskBlock(fullTask);
  });
  const trimmed = content.trimEnd();
  return `${trimmed}\n\n${blocks.join("\n")}`;
}
