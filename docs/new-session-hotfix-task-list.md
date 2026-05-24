# new-session-hotfix Task List

Source hardened spec: `docs/new-session-hotfix-hardened-spec.md`
Source prompt: `docs/ralph-works-transition-fresh-session-fix.md`

## Selection Rules

- Work tasks in ascending priority (`P0`, then `P1`, then `P2`) and list order unless a dependency is already complete.
- Claim a task by adding implementation notes under it if useful; mark it complete by changing `[ ]` to `[x]` only after the task's tests and required gates pass.
- Keep the hotfix scoped to RalphWorks orchestration. Do not add a session strategy option, do not enqueue Pi's `/new` command as text, and do not change phase definitions, skill responsibilities, artifact naming, or gate semantics.
- Use red-green TDD for each task: add or update the focused failing assertion first, then implement the smallest change.

## Tasks

- [x] T001 P0 Add reusable unresolved-boundary lookup helpers
  - Scope: `src/state/session-boundaries.js` and `tests/session-boundaries.test.js`.
  - Add a pure helper that returns the latest launchable/retryable phase boundary for the current persisted phase, using the hardened spec matching rule: pending or retryable status, `boundaryType: "phase"`, and `toPhase` equal to `state.currentPhase`.
  - Reuse the existing pending/retryable status model where possible, including `pending`, retryable launch statuses, and `followup_failed`; ignore completed, stale, fallback-completed, or mismatched `toPhase` events.
  - Completion evidence: unit tests cover latest-match selection, stale `toPhase` ignored, handled statuses ignored, missing/empty boundary arrays, and deterministic behavior when multiple unresolved events exist.

- [x] T002 P0 Create a tool-safe boundary handoff path in the harness
  - Scope: `src/harness/pi-harness-adapter.js` and focused adapter tests.
  - Split boundary creation so tool handoff can persist state, append one pending boundary event, update the TUI, and queue the continuation command without calling `launchSessionBoundary(...)`, `launchPiSessionBoundary(...)`, `ctx.newSession(...)`, or `ctx.compact(...)`.
  - Preserve the existing command-context path for slash commands, which may still launch immediately via `ctx.newSession(...)`.
  - Completion evidence: a normal `ralph_works_transition` tool test from an active non-review phase advances persisted state, appends exactly one pending phase boundary, queues `/ralph-works continue-boundary <boundary-id>` with `deliverAs: "followUp"`, and records no new session or compaction call from the tool context.

- [x] T003 P0 Make follow-up queue failure durable and recoverable
  - Scope: `enqueueBoundaryLauncher`/handoff helpers in `src/harness/pi-harness-adapter.js`, `src/state/session-boundaries.js` if needed, and `tests/pi-boundary-handoff.test.js` or nearest adapter tests.
  - Persist the advanced state and pending boundary before attempting `pi.sendUserMessage(...)`.
  - If `pi.sendUserMessage` is unavailable or throws, keep the boundary resumable, persist a durable retryable indication such as `status: "followup_failed"`, and notify the user with the exact command `/ralph-works continue-boundary <boundary-id>`.
  - If no UI notification channel exists, include enough recovery detail in the tool result for the caller to surface the same manual command.
  - Completion evidence: tests cover missing `sendUserMessage`, throwing `sendUserMessage`, no compaction during either failure, durable retryable persisted state, exact manual command notification/result, and manual continuation after state restoration launching the same boundary.

- [x] T004 P0 Route `ralph_works_transition` through handoff mode for normal phase advancement
  - Scope: the `ralph_works_transition` tool executor and shared advancement helpers in `src/harness/pi-harness-adapter.js`.
  - The tool must advance only to the next legal workflow state, preserve existing `renderHtml` semantics where applicable, run required gates before leaving `tdd_implement`, and then use the tool-safe handoff path.
  - The tool result may simply report the updated/current RalphWorks state on successful queueing; no extra success notification is required.
  - Completion evidence: tests replace the old compaction-expectation case, prove the tool advances for a normal phase without direct launch/compaction, and prove the queued `continue-boundary` command later calls `ctx.newSession(...)`, avoids compaction on the normal path, and sends the correct replacement-session phase prompt.

- [x] T005 P0 Prevent duplicate unresolved tool boundaries before side effects
  - Scope: `src/harness/pi-harness-adapter.js`, the helper from T001, and adapter tests with gate spies.
  - At the start of `ralph_works_transition`, before gates, phase computation, or state mutation, check for a reusable unresolved phase boundary whose `toPhase` matches the current persisted `currentPhase`.
  - When found, do not advance state, rerun gates, or append another boundary; requeue the same `/ralph-works continue-boundary <boundary-id>` command when possible or report the same manual command when queueing is unavailable.
  - Completion evidence: repeated tool-call tests assert unchanged phase, unchanged boundary count, same boundary ID requeued/reported, gate runner not invoked again, and stale unresolved boundaries for a different `toPhase` ignored.

- [x] T006 P0 Implement harden-spec tool approval-pause handoff
  - Scope: harden pause logic in `src/harness/pi-harness-adapter.js`, boundary action/plan handling if needed, and adapter/command-boundary tests.
  - Calling `ralph_works_transition` from `harden_spec` must change only `phaseStatus` to `awaiting_harden_approval`, persist one pending phase boundary from `harden_spec` to `harden_spec`, queue or report its continuation command, and show the existing approval instruction during the tool call.
  - If already awaiting approval, the tool must not append a duplicate approval boundary and must preserve the approval-pause notification behavior.
  - Continuing the boundary must create the approval-pause replacement session, make the approval instruction visible there, and send no next-phase kickoff prompt until `/ralph-works approve` or `/ralph-works approve --render-html` is run.
  - Completion evidence: tests cover initial harden-spec tool pause, already-awaiting idempotency, `renderHtml` not bypassing approval, replacement-session approval instructions, and no create-tasks/render kickoff before approval.

- [x] T007 P0 Block generic tool completion from review
  - Scope: `ralph_works_transition` review handling in `src/harness/pi-harness-adapter.js` and review regression tests.
  - A tool call during `review` without an LGTM completion signal must leave state in `review`, not mark the pipeline completed, not create a `complete` boundary, and not send a completion continuation command.
  - Preserve existing review-specific paths: LGTM review output or the review approval command may complete, and critical findings or `RALPH_REVIEW_CHANGES_REQUESTED` must still loop back to `tdd_implement`.
  - Completion evidence: tests cover blocked review tool transition, unchanged review loopback handoff, unchanged LGTM completion handoff, and unchanged warning for generic `RALPH_PHASE_COMPLETE` during review.

- [x] T008 P1 Preserve required gate blocking in both tool and command paths
  - Scope: `runReviewAdvancementGates`, `completeTddTask`, tool handoff integration, and existing gate tests.
  - Required gates from `gate.config.json` must still block TDD task completion and advancement from `tdd_implement` to `review`; failures must persist visible gate results, update the TUI, and create no boundary.
  - Duplicate-boundary reuse must happen before gate execution, but a new legitimate `tdd_implement` tool advancement must still run gates once before creating a review boundary.
  - Completion evidence: tests cover failing gates for tool advancement, failing gates for `/ralph-works next`, failing gates for task completion/markers, no new boundary on failure, and passing gates creating exactly one review boundary.

- [x] T009 P1 Preserve slash-command immediate-launch behavior
  - Scope: command handlers in `src/harness/pi-harness-adapter.js` and `tests/pi-command-boundary-sessions.test.js`.
  - `/ralph-works next`, `/ralph-works approve`, `/ralph-works approve --render-html`, `/ralph-works start`, and other command-context transitions must continue launching boundaries immediately from command context when `ctx.newSession(...)` is available.
  - The hotfix must not accidentally convert command paths to queued tool handoffs.
  - Completion evidence: tests assert command paths call `ctx.newSession(...)` on the normal path, do not enqueue a `continue-boundary` command instead of launching, and preserve existing harden approval and render-html approval behavior.

- [x] T010 P1 Preserve assistant-marker handoff behavior
  - Scope: `agent_end` handling in `src/harness/pi-harness-adapter.js` and `tests/pi-boundary-handoff.test.js`/nearest marker tests.
  - `RALPH_PHASE_COMPLETE`, `RALPH_TDD_TASK_COMPLETE <task-id>`, review loopback markers, and LGTM completion must continue using their existing persisted-state plus follow-up `continue-boundary` handoff pattern.
  - The tool hotfix must not change marker parsing, TDD implementation status updates, review loopback feedback, or LGTM completion semantics.
  - Completion evidence: regression tests assert marker boundaries are still queued, TDD task markers still run gates and update implementation status, review loopback still returns to `tdd_implement`, LGTM still completes, and stale/already-handled boundary behavior remains idempotent.

- [x] T011 P1 Keep TUI, model routing, and artifact state consistent across handoff and continuation
  - Scope: `src/harness/pi-tui-updater.js`, `src/harness/pi-model-router.js`, `src/harness/session-boundary-plan.js`, and adapter tests only as needed.
  - After the tool call, the TUI should reflect the persisted current phase or approval-pause status without implying a fresh session was already created.
  - The later `continue-boundary` command must continue to validate the boundary ID, build the session boundary plan from persisted state, apply phase model routing, preserve artifact references, and send the correct next prompt or approval-pause behavior from replacement context.
  - Completion evidence: tests assert TUI updates after tool handoff, model routing still occurs during continuation, artifact paths remain in seeded state/plan, manual continuation after restore has enough state to launch, and no arbitrary user-provided slash command is enqueued.

- [x] T012 P2 Update legacy expectations and run the full verification suite
  - Scope: tests and small comments touched by the implementation.
  - Remove or rewrite old assertions that expected `ralph_works_transition` to use compaction fallback from tool context; keep compaction fallback coverage only for the boundary launcher path where command-context fresh-session creation is unavailable or fails.
  - Confirm no code path enqueues Pi's `/new` command as text and no broad architecture or phase-definition changes were introduced.
  - Completion evidence: `npm test` and `npm run check` pass, with focused tests covering normal tool handoff, command continuation, harden pause, queue failure, duplicate prevention, review blocking, gate failures, command regressions, and assistant-marker regressions.
