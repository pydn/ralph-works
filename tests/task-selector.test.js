import assert from "node:assert/strict";
import test from "node:test";

import { parseTaskList } from "../src/tasks/task-list-loader.js";
import { selectNextTask } from "../src/tasks/task-selector.js";
import {
  createImplementationStatus,
  markTaskComplete,
} from "../src/tasks/task-status-updater.js";

test("task list loader parses markdown checkboxes with priorities", () => {
  const tasks = parseTaskList(`
- [ ] T001 P0 Build phase state
- [x] T002 P1 Done item
- [ ] T003 P2 Later item
`);

  assert.deepEqual(
    tasks.map((task) => ({
      id: task.id,
      priority: task.priority,
      completed: task.completed,
      title: task.title,
    })),
    [
      {
        id: "T001",
        priority: 0,
        completed: false,
        title: "Build phase state",
      },
      { id: "T002", priority: 1, completed: true, title: "Done item" },
      { id: "T003", priority: 2, completed: false, title: "Later item" },
    ],
  );
});

test("task selector chooses the highest-priority unclaimed incomplete task", () => {
  const tasks = parseTaskList(`
- [ ] T001 P0 Build phase state
- [ ] T002 P1 Add gates
- [ ] T003 P0 Add models
`);
  const status = createImplementationStatus({
    claimedTaskIds: ["T001"],
  });

  const selected = selectNextTask(tasks, status);

  assert.equal(selected.id, "T003");
});

test("task status updater marks tasks complete with gate evidence", () => {
  const status = createImplementationStatus();
  const next = markTaskComplete(status, "T001", {
    gateResults: [{ name: "unit_tests", passed: true }],
  });

  assert.equal(next.completedTaskIds.includes("T001"), true);
  assert.equal(next.gateResultsByTask.T001[0].name, "unit_tests");
});
