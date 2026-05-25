import assert from "node:assert/strict";
import test from "node:test";

import { recordArtifact } from "../src/artifacts/artifact-tracker.js";
import {
  buildSessionBoundaryPlan,
  RALPH_WORKS_SESSION_BOUNDARY_MESSAGE_TYPE,
} from "../src/harness/session-boundary-plan.js";
import { HARDEN_APPROVAL_STATUS } from "../src/state/phase-completion.js";
import { createPhaseState } from "../src/state/phase-state.js";

function assertJsonCompatible(value) {
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value);
}

test("session boundary plans are plain data with artifacts, task, model, and bounded gates", () => {
  const longOutput = `RAW_GATE_OUTPUT:${"x".repeat(5000)}`;
  let state = createPhaseState({
    feature: "new-session",
    promptText: "create a new session between each phase",
  });
  state = {
    ...recordArtifact(state, "taskList", "task-list.md"),
    currentPhase: "tdd_implement",
    gateResults: [
      {
        name: "unit_tests",
        command: "npm test",
        required: true,
        passed: true,
        code: 0,
        stdout: longOutput,
        stderr: "API_KEY=super-secret",
        blocksTransition: false,
      },
    ],
    previousTranscript: "BEGIN TRANSCRIPT user said secret things",
    environmentDump: "API_KEY=super-secret",
  };

  const plan = buildSessionBoundaryPlan(state, {
    boundaryId: "boundary-1",
    boundaryType: "task",
    reason: "completed T001",
    nextActionType: "tdd_task_prompt",
    kickoffPrompt: "Continue TDD with T002.",
    selectedModelTarget: {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      raw: "anthropic/claude-sonnet-4-5",
    },
    task: {
      id: "T002",
      title: "Build plain boundary plans and bounded resume-context messages",
      priority: 0,
      lineNumber: 2,
      raw: "- [ ] T002 P0 Build plain boundary plans and bounded resume-context messages",
      acceptanceCriteria: ["Plans are JSON-compatible and bounded."],
    },
  });

  assertJsonCompatible(plan);
  assert.equal(plan.boundaryId, "boundary-1");
  assert.equal(plan.boundaryType, "task");
  assert.equal(plan.reason, "completed T001");
  assert.equal(plan.nextActionType, "tdd_task_prompt");
  assert.equal(plan.kickoffPrompt, "Continue TDD with T002.");
  assert.deepEqual(plan.artifactPaths, [
    { key: "taskList", path: "docs/new-session-task-list.md" },
  ]);
  assert.deepEqual(plan.selectedModelTarget, {
    provider: "anthropic",
    id: "claude-sonnet-4-5",
    raw: "anthropic/claude-sonnet-4-5",
  });
  assert.equal(plan.taskDetails.id, "T002");
  assert.equal(
    plan.taskDetails.title,
    "Build plain boundary plans and bounded resume-context messages",
  );
  assert.equal(plan.latestGateSummary.results[0].name, "unit_tests");
  assert.equal(plan.latestGateSummary.results[0].passed, true);
  assert.equal(plan.latestGateSummary.results[0].stdout, undefined);
  assert.equal(plan.latestGateSummary.results[0].stderr, undefined);

  const serialized = JSON.stringify(plan);
  assert.doesNotMatch(serialized, /RAW_GATE_OUTPUT/);
  assert.doesNotMatch(serialized, /BEGIN TRANSCRIPT/);
  assert.doesNotMatch(serialized, /API_KEY=super-secret/);
});

test("session boundary custom message announces fresh sessions and carries bounded resume context", () => {
  let state = createPhaseState({ feature: "new-session" });
  state = {
    ...recordArtifact(state, "hardenedSpec", "hardened-spec.md"),
    currentPhase: "create_tasks",
  };

  const plan = buildSessionBoundaryPlan(state, {
    boundaryId: "boundary-2",
    boundaryType: "phase",
    reason: "entered create_tasks",
    nextActionType: "phase_prompt",
  });

  assert.equal(
    plan.customMessage.customType,
    RALPH_WORKS_SESSION_BOUNDARY_MESSAGE_TYPE,
  );
  assert.equal(plan.customMessage.display, true);
  assert.match(
    plan.customMessage.content,
    /^RalphWorks is starting a new session for phase\. Repository files and RalphWorks artifacts are authoritative\./,
  );
  assert.match(plan.customMessage.content, /Boundary ID: boundary-2/);
  assert.match(plan.customMessage.content, /Current phase: create_tasks/);
  assert.match(
    plan.customMessage.content,
    /hardenedSpec: docs\/new-session-hardened-spec\.md/,
  );
  assert.doesNotMatch(plan.customMessage.content, /Transition History/i);
  assert.doesNotMatch(plan.customMessage.content, /transcript/i);
});

test("approval pause plans omit kickoff prompts and include bounded approval context", () => {
  const state = {
    ...createPhaseState({ feature: "new-session" }),
    currentPhase: "harden_spec",
    phaseStatus: HARDEN_APPROVAL_STATUS,
  };

  const plan = buildSessionBoundaryPlan(state, {
    boundaryId: "boundary-3",
    boundaryType: "approval_pause",
    reason: "hardened spec awaiting approval",
    nextActionType: "approval_pause",
  });

  assert.equal(Object.hasOwn(plan, "kickoffPrompt"), false);
  assert.equal(plan.resumeContext.phaseStatus, HARDEN_APPROVAL_STATUS);
  assert.match(
    plan.resumeContext.pendingApprovalInstruction,
    /\/ralph-works approve/,
  );
  assert.match(plan.customMessage.content, /Action required:/);
  assert.match(plan.customMessage.content, /approve --render-html/);
});
