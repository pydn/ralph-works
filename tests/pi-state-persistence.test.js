import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  RALPH_WORKS_STATE_ENTRY_TYPE,
  restoreRalphWorksState,
} from "../src/harness/pi-state-persistence.js";
import { createPhaseState } from "../src/state/phase-state.js";
import { createSessionBoundaryEvent } from "../src/state/session-boundaries.js";

test("restored sessions rebuild artifact paths with the feature prefix", () => {
  const saved = {
    ...createPhaseState({ feature: "../Hello World!!" }),
    phases: [
      {
        id: "generate_spec",
        artifactPath: "generated-spec.md",
      },
    ],
  };

  const restored = restoreRalphWorksState({
    sessionManager: {
      getEntries() {
        return [
          {
            type: "custom",
            customType: RALPH_WORKS_STATE_ENTRY_TYPE,
            data: saved,
          },
        ];
      },
    },
  });

  assert.equal(
    restored.phases.find((phase) => phase.id === "generate_spec").artifactPath,
    "docs/hello-world-generated-spec.md",
  );
});

test("restored replacement sessions keep seeded state without previous chat history", () => {
  const boundaryEvent = createSessionBoundaryEvent({
    id: "boundary-1",
    boundaryType: "phase",
    reason: "entered tdd_implement",
    fromPhase: "create_tasks",
    toPhase: "tdd_implement",
    now: () => "2026-05-24T00:00:00.000Z",
  });
  const saved = {
    ...createPhaseState({ feature: "new-session" }),
    currentPhase: "tdd_implement",
    gateResults: [{ name: "unit_tests", passed: true, required: true }],
    artifacts: { taskList: "docs/new-session-task-list.md" },
    implementationStatus: {
      completedTaskIds: ["T001"],
      gateResultsByTask: {
        T001: [{ name: "unit_tests", passed: true, required: true }],
      },
    },
    sessionBoundaryEvents: [boundaryEvent],
  };

  const restored = restoreRalphWorksState({
    sessionManager: {
      getEntries() {
        return [
          {
            type: "custom_message",
            customType: "ralph-works-session-boundary",
            content: "RalphWorks is starting a new session.",
          },
          {
            type: "custom",
            customType: RALPH_WORKS_STATE_ENTRY_TYPE,
            data: saved,
          },
        ];
      },
    },
  });

  assert.equal(restored.currentPhase, "tdd_implement");
  assert.deepEqual(restored.sessionBoundaryEvents, [boundaryEvent]);
  assert.deepEqual(restored.gateResults, saved.gateResults);
  assert.deepEqual(restored.artifacts, saved.artifacts);
  assert.deepEqual(restored.implementationStatus, saved.implementationStatus);
});

test("restored sessions hydrate implementation status from the durable artifact", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-state-"));
  try {
    await mkdir(path.join(tempDir, "docs"));
    await writeFile(
      path.join(tempDir, "docs/new-session-implementation-status.json"),
      `${JSON.stringify(
        {
          feature: "new-session",
          status: "in_progress",
          updatedAt: "2026-05-24T00:00:00.000Z",
          completedTaskIds: ["T001"],
          claimedTaskIds: ["T002"],
          gateResultsByTask: {
            T001: [
              {
                name: "unit_tests",
                command: "npm test",
                required: true,
                passed: true,
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );

    const saved = {
      ...createPhaseState({ feature: "new-session" }),
      currentPhase: "tdd_implement",
      artifacts: {
        implementationStatus: "docs/new-session-implementation-status.json",
      },
      implementationStatus: {
        completedTaskIds: [],
        claimedTaskIds: [],
        gateResultsByTask: {},
      },
    };

    const restored = restoreRalphWorksState({
      cwd: tempDir,
      sessionManager: {
        getEntries() {
          return [
            {
              type: "custom",
              customType: RALPH_WORKS_STATE_ENTRY_TYPE,
              data: saved,
            },
          ];
        },
      },
    });

    assert.equal(
      restored.artifacts.implementationStatus,
      "docs/new-session-implementation-status.json",
    );
    assert.deepEqual(restored.implementationStatus.completedTaskIds, ["T001"]);
    assert.deepEqual(restored.implementationStatus.claimedTaskIds, ["T002"]);
    assert.equal(
      restored.implementationStatus.gateResultsByTask.T001[0].name,
      "unit_tests",
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("older restored states preserve compaction events and add session boundary history", () => {
  const saved = {
    ...createPhaseState({ feature: "new-session" }),
    sessionBoundaryEvents: undefined,
    compactionEvents: [
      {
        boundary: "phase",
        reason: "entered red_team",
        at: "2026-05-23T00:00:00.000Z",
      },
    ],
  };
  delete saved.sessionBoundaryEvents;

  const restored = restoreRalphWorksState({
    sessionManager: {
      getEntries() {
        return [
          {
            type: "custom",
            customType: RALPH_WORKS_STATE_ENTRY_TYPE,
            data: saved,
          },
        ];
      },
    },
  });

  assert.deepEqual(restored.compactionEvents, saved.compactionEvents);
  assert.deepEqual(restored.sessionBoundaryEvents, []);
});
