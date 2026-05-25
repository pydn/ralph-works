import type { RalphWorksPhaseDefinition } from "../state/phase-types.ts";

export const createTasksPhase = {
  id: "create_tasks",
  label: "Task Creation",
  skillDirectory: "create-tasks",
  artifactKey: "taskList",
  artifactPath: "task-list.md",
} satisfies RalphWorksPhaseDefinition;
