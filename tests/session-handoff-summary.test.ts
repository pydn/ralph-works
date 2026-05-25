import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { recordArtifact } from "../src/artifacts/artifact-tracker.ts";
import {
  type ArtifactInventoryRecord,
  buildArtifactInventory,
  buildSessionHandoffSummary,
} from "../src/artifacts/session-handoff-summary.ts";
import { HARDEN_APPROVAL_STATUS } from "../src/state/phase-completion.ts";
import { createPhaseState } from "../src/state/phase-state.ts";
import { transitionToPhase } from "../src/state/phase-transitions.ts";
import { createPendingSessionHandoff } from "../src/state/session-handoff-state.ts";

async function createWorkspace(t: TestContext): Promise<{
  outside: string;
  workspace: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "ralph-handoff-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  await mkdir(path.join(workspace, "docs"), { recursive: true });
  await mkdir(outside, { recursive: true });
  return { outside, workspace };
}

test("session handoff summary includes deterministic workflow context and next action", async (t) => {
  const { workspace } = await createWorkspace(t);
  await writeFile(
    path.join(workspace, "docs", "create-new-session-generated-spec.md"),
    "Generated spec excerpt\n",
  );

  let state = createPhaseState({
    feature: "create-new-session",
    promptText: "Update the extension to create a new pi session.",
    now: () => "2026-05-24T00:00:00.000Z",
  });
  state = recordArtifact(state, "generatedSpec", "generated-spec.md");
  state = transitionToPhase(state, "red_team", {
    reason: "completed generate_spec",
    now: () => "2026-05-24T01:00:00.000Z",
  });
  state = createPendingSessionHandoff(state, {
    id: "handoff-42",
    boundary: "phase",
    reason: "completed red_team",
    targetPhase: "harden_spec",
    now: () => "2026-05-24T02:00:00.000Z",
  });
  state = {
    ...state,
    loopbackCount: 1,
    tddCompletedTasks: 2,
    gateResults: [
      {
        name: "unit",
        command: "npm test",
        required: true,
        passed: true,
        code: 0,
        blocksTransition: false,
      },
    ],
    implementationStatus: {
      claimedTaskIds: [],
      completedTaskIds: ["T001", "T002"],
      gateResultsByTask: {},
    },
  };

  const summary = buildSessionHandoffSummary(state, { cwd: workspace });

  assert.match(summary, /# RalphWorks Session Handoff/);
  assert.match(summary, /Extension: ralph-works/);
  assert.match(summary, /Feature: create-new-session/);
  assert.match(
    summary,
    /Prompt: Update the extension to create a new pi session\./,
  );
  assert.match(summary, /Boundary: phase/);
  assert.match(summary, /Handoff id: handoff-42/);
  assert.match(summary, /Reason: completed red_team/);
  assert.match(summary, /Source phase: red_team/);
  assert.match(summary, /Target phase: harden_spec/);
  assert.match(summary, /Phase status: handoff_pending/);
  assert.match(summary, /Pipeline status: running/);
  assert.match(summary, /Completed phases: generate_spec/);
  assert.match(summary, /Loopbacks: 1/);
  assert.match(summary, /TDD completed tasks: 2/);
  assert.match(summary, /Implementation status: T001, T002/);
  assert.match(summary, /unit: passed \(required, `npm test`, code 0\)/);
  assert.match(summary, /start -> generate_spec \(start\)/);
  assert.match(
    summary,
    /generatedSpec \(Generate Spec\): docs\/create-new-session-generated-spec\.md \[present\]/,
  );
  assert.match(summary, /```text artifact excerpt \(untrusted\)/);
  assert.match(summary, /Generated spec excerpt/);
  assert.match(
    summary,
    /Next expected action: Launch harden_spec phase prompt\./,
  );
});

test("artifact inventory safely classifies existing, missing, large, binary, outside, and symlink-escaped artifacts", async (t) => {
  const { outside, workspace } = await createWorkspace(t);
  const outsideSecret = path.join(outside, "secret.md");
  await writeFile(
    path.join(workspace, "docs", "handoff-generated-spec.md"),
    "safe handoff artifact\n",
  );
  await writeFile(
    path.join(workspace, "docs", "large.txt"),
    `${"large artifact line\n".repeat(20)}`,
  );
  await writeFile(
    path.join(workspace, "docs", "binary.bin"),
    Buffer.from([0xff, 0xfe, 0xfd]),
  );
  await writeFile(outsideSecret, "outside secret\n");
  await symlink(outsideSecret, path.join(workspace, "docs", "secret-link.md"));

  const state = {
    ...createPhaseState({ feature: "handoff" }),
    completedPhases: ["generate_spec"],
    artifacts: {
      binaryThing: "docs/binary.bin",
      generatedSpec: "docs/handoff-generated-spec.md",
      largeThing: "docs/large.txt",
      missingThing: "docs/missing.md",
      outsideThing: outsideSecret,
      unsafeSymlink: "docs/secret-link.md",
    },
  };

  const inventory = buildArtifactInventory(state, {
    cwd: workspace,
    limits: {
      perArtifactBytes: 24,
      perArtifactLines: 4,
      totalArtifactBytes: 1024,
    },
  });

  const byKey = new Map(inventory.map((artifact) => [artifact.key, artifact]));
  const artifactFor = (key: string): ArtifactInventoryRecord => {
    const artifact = byKey.get(key);
    assert.ok(artifact, `expected artifact ${key}`);
    return artifact;
  };

  assert.equal(artifactFor("generatedSpec").status, "present");
  assert.match(
    artifactFor("generatedSpec").excerpt ?? "",
    /safe handoff artifact/,
  );
  assert.equal(artifactFor("missingThing").status, "missing");
  assert.equal(
    artifactFor("missingThing").omissionReason,
    "file does not exist",
  );
  assert.equal(artifactFor("binaryThing").status, "skipped");
  assert.equal(
    artifactFor("binaryThing").omissionReason,
    "binary or non-UTF-8 file",
  );
  assert.equal(artifactFor("outsideThing").status, "skipped");
  assert.equal(artifactFor("outsideThing").omissionReason, "outside workspace");
  assert.equal(artifactFor("unsafeSymlink").status, "skipped");
  assert.equal(
    artifactFor("unsafeSymlink").omissionReason,
    "symlink target escapes workspace",
  );
  assert.equal(artifactFor("largeThing").status, "present");
  assert.ok((artifactFor("largeThing").excerpt?.length ?? 0) <= 24);
  assert.equal(
    artifactFor("largeThing").omissionReason,
    "excerpt truncated to configured budget",
  );
});

test("artifact inventory marks safe text artifacts skipped when the total excerpt budget is exhausted", async (t) => {
  const { workspace } = await createWorkspace(t);
  await writeFile(path.join(workspace, "docs", "first.md"), "first artifact\n");
  await writeFile(
    path.join(workspace, "docs", "second.md"),
    "second artifact\n",
  );

  const inventory = buildArtifactInventory(
    {
      ...createPhaseState({ feature: "handoff" }),
      artifacts: {
        first: "docs/first.md",
        second: "docs/second.md",
      },
    },
    {
      cwd: workspace,
      limits: {
        perArtifactBytes: 100,
        totalArtifactBytes: 5,
      },
    },
  );

  assert.equal(
    inventory.find((artifact) => artifact.key === "first")?.status,
    "present",
  );
  assert.equal(
    inventory.find((artifact) => artifact.key === "second")?.status,
    "skipped",
  );
  assert.equal(
    inventory.find((artifact) => artifact.key === "second")?.omissionReason,
    "artifact excerpt budget exhausted",
  );
});

test("session handoff summary keeps harden approval instructions when approval is pending", () => {
  const summary = buildSessionHandoffSummary(
    {
      ...createPhaseState({ feature: "handoff" }),
      currentPhase: "harden_spec",
      phaseStatus: HARDEN_APPROVAL_STATUS,
    },
    {
      boundary: "approval",
      handoffId: "approval-wait",
      reason: "hardened spec awaiting approval",
      sourcePhase: "harden_spec",
      targetPhase: "harden_spec",
    },
  );

  assert.match(summary, /## Action Required/);
  assert.match(
    summary,
    /must not continue until the user explicitly approves/i,
  );
  assert.match(summary, /\/ralph-works approve\b/);
  assert.match(summary, /\/ralph-works approve --render-html\b/);
  assert.match(
    summary,
    /Next expected action: Wait for hardened spec approval\./,
  );
});

test("session handoff summary tells task-boundary TDD sessions to inspect artifacts", () => {
  let state = createPhaseState({ feature: "hello-world" });
  for (const phase of [
    "red_team",
    "harden_spec",
    "create_tasks",
    "tdd_implement",
  ]) {
    state = transitionToPhase(state, phase, { reason: `test:${phase}` });
  }
  state = createPendingSessionHandoff(state, {
    id: "task-handoff",
    boundary: "task",
    reason: "completed T001",
    sourcePhase: "tdd_implement",
    targetPhase: "tdd_implement",
    taskId: "T001",
  });

  const summary = buildSessionHandoffSummary(state);

  assert.match(
    summary,
    /Next expected action: Inspect task list and implementation status artifacts, then continue TDD implementation with the next incomplete task\./,
  );
});

test("session handoff summary surfaces review loopback reason", () => {
  const summary = buildSessionHandoffSummary(
    createPhaseState({ feature: "handoff" }),
    {
      boundary: "review_loopback",
      handoffId: "review-loop",
      reason: "review requested changes: fix critical bug",
      sourcePhase: "review",
      targetPhase: "tdd_implement",
    },
  );

  assert.match(
    summary,
    /Review loopback reason: review requested changes: fix critical bug/,
  );
});
