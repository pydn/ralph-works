import assert from "node:assert/strict";
import test from "node:test";

import {
  claimTask,
  createImplementationStatus,
  markTaskComplete,
} from "../src/tasks/task-status-updater.ts";

test("task status updater claims tasks idempotently", () => {
  const status = createImplementationStatus();

  const claimed = claimTask(status, "T001");
  const claimedAgain = claimTask(claimed, "T001");

  assert.deepEqual(claimed.claimedTaskIds, ["T001"]);
  assert.deepEqual(claimedAgain.claimedTaskIds, ["T001"]);
});

test("task status updater marks tasks complete with gate evidence", () => {
  const status = createImplementationStatus({
    claimedTaskIds: ["T001"],
  });

  const next = markTaskComplete(status, "T001", {
    gateResults: [{ name: "unit_tests", passed: true }],
  });

  assert.deepEqual(next.claimedTaskIds, []);
  assert.equal(next.completedTaskIds.includes("T001"), true);
  assert.equal(next.gateResultsByTask.T001[0].name, "unit_tests");
});
