# new-session Task List

Source spec: `docs/new-session-hardened-spec.md`

## Selection Rules

- Work tasks in ascending priority (`P0`, then `P1`, then `P2`) and list order unless a dependency is already complete.
- Claim a task by editing its status details during implementation if useful; complete it by changing the checkbox to `[x]` only after tests and required gates pass.
- Do not add user-facing session strategy config and do not add runtime git branch management.

## Tasks

- [x] T001 P0 Add session-boundary state primitives and backward-compatible restore
  - Scope: `src/state/phase-state.js`, `src/harness/pi-state-persistence.js`, and a focused helper module such as `src/state/session-boundaries.js`.
  - Implement `sessionBoundaryEvents` as the primary new boundary history field, plus helpers to create, append, find, and update pending boundary events by ID.
  - Include boundary metadata required by the spec: ID, boundary type, reason, from/to phase, task IDs when relevant, timestamp, status, fresh-session attempt/creation flags, fallback flag, elapsed time, and safe previous/replacement session IDs when available.
  - Preserve existing `compactionEvents` on restore as historical compatibility data; do not require an in-place migration and do not make it authoritative for new-session behavior.
  - Completion evidence: unit tests cover initial state shape, event helper idempotency, restored replacement-session state, and restore of older state containing only `compactionEvents`.

- [x] T002 P0 Build plain boundary plans and bounded resume-context messages
  - Scope: new focused artifact/harness helper such as `src/harness/session-boundary-plan.js` or `src/artifacts/session-boundary-summary.js`.
  - Produce JSON-compatible boundary plans containing boundary ID, reason, next state snapshot, next action type, optional kickoff prompt, artifact paths, selected model target, task details, and latest bounded gate summary.
  - Produce a Pi-supported displayed custom message payload announcing: `RalphWorks is starting a new session for <boundary>. Repository files and RalphWorks artifacts are authoritative.`
  - Include bounded resume context fields from the hardened spec; exclude full transcripts, full specs/task lists, long gate output, credentials, environment dumps, and unbounded transition history.
  - Completion evidence: unit tests assert plans contain only plain serializable data, include relevant artifacts/task/gate fields, and omit transcript-like or long gate content.

- [x] T003 P0 Implement the fresh-session boundary launcher with safe fallback handling
  - Scope: replace normal usage of `src/harness/pi-compaction-trigger.js` with a new launcher module such as `src/harness/pi-session-boundary-launcher.js`; keep compaction as fallback only.
  - In command-capable contexts, call `ctx.waitForIdle()` when available, then `ctx.newSession({ parentSession, setup, withSession })`.
  - During `setup`, append the RalphWorks state custom entry, the visible custom announcement/resume message, and replacement-safe session/model metadata without triggering an agent turn.
  - During `withSession`, use only replacement context and captured plain data; send at most one kickoff user message, and send none for pause/completion boundaries.
  - Handle unavailable/throwing `ctx.newSession()` by invoking existing compaction fallback and notifying/logging the fallback; handle `cancelled` without compaction or duplicate prompts; record `followup_failed` if kickoff fails after replacement.
  - Completion evidence: focused tests with fake contexts cover normal new-session launch, parent session linkage, setup entries, replacement-context prompt sending, cancellation, fallback compaction, unavailable fallback, and no stale old-context prompt after replacement.

- [x] T004 P0 Add internal command-context handoff for assistant-driven boundaries
  - Scope: `src/harness/pi-harness-adapter.js` command registration and `agent_end` handlers.
  - Add an internal subcommand such as `/ralph-works continue-boundary <boundary-id>` that validates the pending boundary from restored state and invokes the fresh-session launcher from a command context.
  - Change phase-marker, TDD-marker, review-loopback, and review-LGTM event handling to do only event-safe work: parse/validate, update durable state/artifacts, persist state, append a pending boundary event, and enqueue the internal command as a follow-up user message.
  - Ensure event handlers never call `ctx.newSession()`, `ctx.fork()`, `ctx.switchSession()`, or normal-path `ctx.compact()` directly.
  - Completion evidence: adapter tests prove marker-driven phase and TDD boundaries enqueue the launcher command, command retry is idempotent, stale boundary IDs are ignored with a notification, and no duplicate kickoff prompt is sent.

- [x] T005 P0 Route command-driven phase boundaries through fresh sessions
  - Scope: `startWorkflow`, `launchCurrentPhase`, `enterPhase`, `advanceWorkflow`, `pauseForHardenApproval`, `approveHardenedSpec`, and `completePipeline` in `src/harness/pi-harness-adapter.js`.
  - Pipeline start must persist initial state, create a fresh session, and launch `generate_spec` from the replacement context.
  - Normal phase transitions must persist next state, create a fresh session, and launch the next phase prompt from the replacement context without normal-path compaction.
  - Harden-spec completion must persist `phaseStatus: "awaiting_harden_approval"`, create an approval-pause fresh session, show the approval instruction, and not start a next phase.
  - `/ralph-works approve` and `/ralph-works approve --render-html` must create a fresh session and launch either `create_tasks` or `render_html_optional`; render completion then continues through another normal boundary.
  - Final completion must persist completed state, create a completion fresh session, and not send an unnecessary phase prompt.
  - Completion evidence: adapter tests cover start, next, harden pause, approval with/without render, render-to-tasks, and final completion; normal paths assert `ctx.newSession()` is used and `ctx.compact()` is not.

- [x] T006 P0 Make TDD task boundaries durable and avoid duplicate final-task sessions
  - Scope: `src/tasks/task-status-updater.js`, `src/tasks/task-selector.js`, `src/harness/pi-harness-adapter.js`, and artifact tracking.
  - Write/update `docs/<feature>-implementation-status.json` whenever TDD implementation status changes; include completed task IDs, claimed task IDs when relevant, gate results by task, update metadata, and enough data to avoid reselecting completed tasks after session replacement or restart.
  - Record the implementation status artifact path in RalphWorks artifacts when TDD begins or when the file is first written.
  - After gates pass for a TDD task, persist gate results and implementation status before creating any boundary session.
  - If another incomplete task exists, create one task boundary and send the next TDD kickoff from the replacement context; if none exists, create only the TDD-to-review phase boundary and launch review from that replacement context.
  - Completion evidence: tests cover status file creation/update, task selection from durable status, required gate result persistence, next-task fresh session, and final-task transition to review without a redundant task-boundary session.

- [x] T007 P1 Preserve gate blocking across new-session boundaries
  - Scope: `src/harness/pi-gate-runner.js`, `src/gates/*`, and boundary calls in `src/harness/pi-harness-adapter.js`.
  - Required gates from `gate.config.json` must still run before TDD task completion and before advancement from `tdd_implement` to review.
  - Required gate failures must leave the task/phase incomplete, persist visible gate results, update TUI/status, and not create a fresh-session boundary.
  - Bounded gate summaries may appear in resume context, but raw long command output must not be copied.
  - Completion evidence: tests cover gate-pass boundary creation, gate-failure blocking with no `newSession`/fallback compaction, and bounded gate summary rendering.

- [x] T008 P1 Apply model routing safely in replacement sessions
  - Scope: `src/harness/pi-model-router.js`, `src/models/*`, boundary plan/launcher setup, and adapter tests.
  - Resolve the target model for the next phase before replacement as plain provider/model identifiers.
  - Apply the selected model during replacement using a documented replacement-safe mechanism, such as `SessionManager.appendModelChange()` in setup or a replacement-context model setter if supported; do not call old `pi.setModel` or use old command context after replacement.
  - Preserve existing behavior for default fallback, missing configured models, and unavailable API keys; do not silently launch a phase on an unintended model when the current behavior would warn or error.
  - Completion evidence: tests cover phase-specific model, default fallback, missing model warning/error behavior, setup model-change entry, and stale old-context setters not being called after successful replacement.

- [x] T009 P1 Restore replacement sessions from their own seeded state
  - Scope: `src/harness/pi-state-persistence.js`, `session_start` handling, implementation status restoration, and tests.
  - Ensure a fresh replacement session containing only the seeded RalphWorks custom state and custom messages can restore current phase, phase status, artifacts, gates, transition history, TDD implementation status, and pending boundary metadata.
  - If the implementation status artifact exists, use it as durable support for task selection after replacement/restart without relying on previous chat history.
  - Keep `compactionEvents` readable as historical data for older sessions.
  - Completion evidence: tests simulate `session_start` in a replacement session with no prior chat entries and verify TUI/status restoration and next task selection from durable state/artifact.

- [x] T010 P1 Preserve review loopback and LGTM completion semantics with fresh sessions
  - Scope: review handling in `src/harness/pi-harness-adapter.js` and prompt construction as needed.
  - `RALPH_REVIEW_CHANGES_REQUESTED` or equivalent critical review output must persist a loopback to `tdd_implement`, create a fresh session, and launch the TDD prompt with bounded review context.
  - LGTM review must persist completed pipeline state, create the final fresh session, and not launch a new phase prompt.
  - `RALPH_PHASE_COMPLETE` during review must remain ignored with the existing warning behavior.
  - Completion evidence: adapter tests cover review loopback fresh-session launch, LGTM completion fresh session, no kickoff on completion, and ignored phase-complete marker during review.

- [x] T011 P1 Add user-visible session-boundary messages, TUI status, and diagnostics
  - Scope: boundary launcher, `src/tui/*` if needed, and adapter tests.
  - Every fresh session must include a displayed RalphWorks custom message announcing the new session and stating that repository files/artifacts are authoritative.
  - Pause/completion boundaries must show clear status without starting an agent turn.
  - Fallback compaction, new-session cancellation, stale boundary IDs, and follow-up failures must notify/log with boundary ID and reason without dumping prompts, transcripts, credentials, or raw gate logs.
  - TUI should continue to show current workflow and gate status after replacement using replacement context, not stale old context.
  - Completion evidence: tests assert custom message payload/display, notification text for fallback/cancel/stale cases, and TUI update calls use the correct context.

- [x] T012 P2 Remove compaction-first assumptions while keeping fallback compatibility
  - Scope: `src/harness/pi-compaction-trigger.js`, `src/artifacts/compaction-summary.js`, tests, and any naming/docs comments touched by the implementation.
  - Ensure normal RalphWorks boundaries no longer record new work primarily as `compactionEvents` or call compaction first.
  - Keep existing compaction summary behavior available for fallback and old tests where appropriate, but update tests that assumed compaction-first behavior to assert new-session-first behavior.
  - Ensure no user-facing session strategy configuration is introduced and no runtime git branch management is added.
  - Completion evidence: targeted tests and grep/review confirm normal boundary paths call the new launcher, fallback still uses compaction summaries, session strategy config is absent, and git branch management is absent.

- [x] T013 P2 Add end-to-end regression coverage for all RalphWorks boundaries
  - Scope: primarily `tests/pi-harness-adapter.test.js` plus focused unit tests near changed helpers.
  - Cover all boundaries listed in the hardened spec: pipeline start, phase transition, harden approval pause, approval continuation, optional render continuation, TDD next-task boundary, final TDD-to-review boundary, review loopback, and final completion.
  - Include failure/idempotency regressions: duplicate boundary launcher command, unavailable `newSession`, throwing `newSession`, cancelled replacement, follow-up prompt failure, unavailable compaction fallback, and old `compactionEvents` restore.
  - Include stale-context regressions: after successful replacement, prompts/notifications/TUI/model application use replacement-safe paths only.
  - Completion evidence: `npm run check` and `npm test` pass with the new regression coverage.

- [x] T014 P0 Make retryable session-boundary states resumable
  - Scope: `src/harness/pi-harness-adapter.js`, `src/state/session-boundaries.js`, `src/harness/pi-session-boundary-launcher.js`, and boundary retry tests.
  - Fixed `/ralph-works continue-boundary <boundary-id>` so persisted retryable boundary states can be retried/resumed instead of being treated as stale after a crash/restart or partial handoff failure.
  - Covered `launching` persisted before `ctx.newSession()`, user-cancelled fresh-session replacement, unavailable fallback, and follow-up prompt failure after replacement, while still preventing duplicate kickoff prompts for already-created and fallback-completed boundaries.
  - Completion evidence: `npm test`, `npm run lint`, `npm run format:check`, and `npm run check` pass with retry/resume coverage and no normal-path compaction or duplicate prompt delivery.
