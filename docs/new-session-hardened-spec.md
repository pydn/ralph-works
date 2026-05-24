# new-session Hardened Spec

## 1. Purpose And User Value

RalphWorks should replace model-backed compaction at RalphWorks workflow boundaries with fresh Pi sessions. The value is faster phase-to-phase and task-to-task continuation, lower dependence on long conversation history, and clearer reliance on durable repository artifacts and persisted RalphWorks state.

A successful implementation starts the next RalphWorks step from a fresh Pi session, seeds that session with bounded resume context, and preserves workflow correctness without requiring model summarization of the previous session. Repository files, RalphWorks artifacts, and RalphWorks persisted state are authoritative; prior chat history is disposable coordination context.

## 2. Intended Users And Context

The intended users are RalphWorks users running the Pi extension, maintainers of this repository, and downstream RalphWorks agent phases that depend on correct phase state and artifact paths.

Relevant context:

- RalphWorks currently uses Pi compaction at phase and TDD task boundaries.
- Pi exposes `ctx.newSession()` as the supported way to create a replacement session from command-capable contexts.
- Pi documents `ctx.newSession()`, `ctx.fork()`, and `ctx.switchSession()` as `ExtensionCommandContext` session-control APIs. They must not be called directly from event handlers such as assistant/agent-end marker handling.
- Pi compaction remains available in Pi, but RalphWorks should not use it on the normal RalphWorks boundary path.
- Durable state and repository artifacts, not chat history, must be authoritative for workflow continuation.
- This implementation work should be done on the already-created git feature branch, but RalphWorks must not gain runtime git branch creation, switching, verification, or lifecycle management behavior.
- The `tdd-session-reset-requirements.md` guidance is incorporated, except that this feature intentionally has no user-facing session strategy configuration and applies fresh sessions to all RalphWorks boundaries, not only TDD task boundaries.

## 3. Scope

In scope:

- Replace normal RalphWorks boundary compaction with fresh Pi session creation.
- Apply fresh-session behavior at all RalphWorks workflow boundaries:
  - pipeline start,
  - phase transitions,
  - harden approval pause,
  - harden approval continuation,
  - TDD task boundaries,
  - transition from the final TDD task to review,
  - review loopbacks,
  - final completion.
- Add a supported command-context boundary launcher for assistant-driven boundaries so `ctx.newSession()` is not called from event handlers.
- Persist RalphWorks state before attempting replacement and seed the replacement session with the serialized next state during `newSession({ setup })`.
- Seed replacement sessions with bounded resume context and a visible RalphWorks system-style message implemented with Pi-supported custom message entries.
- Send any follow-up phase or TDD continuation prompt from the replacement-session context passed to `withSession`.
- Fall back to existing compaction behavior when `ctx.newSession()` is unavailable or throws before replacement in a context where it is expected to be available.
- Preserve gate behavior, model routing behavior, artifact paths, phase state, TUI display, review loopback behavior, and workflow semantics.
- Add or update automated tests for the new-session path, command-context orchestration, state seeding, stale-context avoidance, and compaction fallback.

Out of scope:

- Removing Pi compaction globally.
- Adding a user-facing session strategy configuration option.
- Editing, truncating, deleting, or rewriting Pi JSONL session history.
- Making chat history the source of truth for RalphWorks progress.
- Changing the RalphWorks phase model or skill responsibilities.
- Adding runtime git branch management to the RalphWorks extension.
- Introducing network-dependent behavior.
- Creating implementation tasks in this spec.

## 4. Definitions

- **RalphWorks boundary:** A workflow point where RalphWorks completes one coordination step and either starts the next step, pauses for approval, loops back, or completes the pipeline.
- **Boundary plan:** Plain serialized data describing the boundary ID, reason, next state, prompt action, resume context, model target, and artifact references. Boundary plans must not contain live `pi`, `ctx`, `SessionManager`, UI, or model objects.
- **Boundary launcher command:** A RalphWorks command-context entrypoint, such as an internal `/ralph-works continue-boundary <boundary-id>` command, that performs session replacement. Event handlers may enqueue this command as a follow-up user message; they must not call `ctx.newSession()` directly.
- **Replacement session setup:** The `setup` callback passed to `ctx.newSession()`, used to append state, custom messages, model-change entries, and other session entries to the new session before `withSession` sends any kickoff prompt.
- **Kickoff prompt:** The single user message that intentionally starts the next agent turn, such as the next phase prompt or next TDD task prompt.

## 5. User Workflows

### Main workflow

1. The user starts or continues a RalphWorks pipeline.
2. When RalphWorks reaches a boundary, it computes the next workflow state and a boundary plan using only plain serialized data.
3. RalphWorks persists the next workflow state and artifact references to the current session before attempting any session replacement.
4. If the boundary is detected in an event handler, RalphWorks records a pending boundary and enqueues the boundary launcher command as a follow-up. The event handler does not call `ctx.newSession()`.
5. The boundary launcher command waits for the agent to be idle, validates the pending boundary ID, and creates a fresh Pi session with `ctx.newSession()`.
6. The replacement session receives:
   - a RalphWorks custom state entry that does not participate in LLM context,
   - a displayed RalphWorks custom message announcing that a new session is starting,
   - bounded resume context that participates in LLM context,
   - any required model-change/session metadata entries.
7. If the boundary requires agent work, RalphWorks sends exactly one kickoff prompt from the replacement-session context passed to `withSession`.
8. If the boundary is a pause or final completion, RalphWorks does not start an unnecessary agent turn; it shows the pause/completion state through custom messages, TUI, or notifications.
9. The agent continues by inspecting durable artifacts and repository files instead of relying on prior chat history.

### Fallback workflow

1. RalphWorks reaches a boundary and persists the next state.
2. The boundary launcher command attempts fresh session replacement.
3. If `ctx.newSession()` is unavailable in the command context or throws before replacement, RalphWorks invokes the existing compaction fallback path.
4. RalphWorks clearly notifies or logs that compaction fallback was used, including the boundary ID and reason.
5. After fallback completion, RalphWorks continues with the same next prompt or pause behavior that the fresh-session path would have used.
6. If `ctx.newSession()` returns `cancelled`, RalphWorks treats it as an explicit replacement veto, records/notifies cancellation, keeps the boundary resumable, and does not silently start compaction unless Pi exposes the cancellation as a non-user failure that is safe to fall back from.
7. If both fresh session replacement and compaction fallback are unavailable, RalphWorks leaves the persisted boundary state intact, notifies the user of degraded behavior, and avoids duplicate or partially launched prompts.

### TDD task workflow

1. A TDD task is marked complete only after required gates pass.
2. RalphWorks updates implementation status in persisted state and in `docs/<feature>-implementation-status.json`.
3. RalphWorks records gate results for the task before any boundary replacement.
4. If another incomplete task remains, RalphWorks creates one fresh session boundary and sends the next TDD continuation prompt from the replacement context.
5. If no incomplete task remains, RalphWorks creates only the normal TDD-to-review phase boundary session and launches review from that replacement context. It must not create both a redundant task-boundary session and a phase-boundary session for the same completed final task.

### Harden approval workflow

1. When `harden_spec` completes, RalphWorks persists `phaseStatus: "awaiting_harden_approval"` and records the hardened spec artifact.
2. RalphWorks creates a fresh session boundary for the approval pause.
3. The replacement session shows a visible RalphWorks message explaining that harden approval is required.
4. RalphWorks does not start the next agent phase until the user runs `/ralph-works approve` or `/ralph-works approve --render-html`.
5. Approval is a command-context boundary. The approval command persists the approved next state, creates a fresh session, and launches either `render_html_optional` or `create_tasks` from the replacement context.

## 6. Functional Requirements

1. RalphWorks must use `ctx.newSession()` instead of `ctx.compact()` on the normal path for every RalphWorks workflow boundary.
2. RalphWorks must not expose a user-facing session strategy configuration option for this feature.
3. RalphWorks must keep compaction available only as an explicit fallback when fresh session creation is unavailable or fails before replacement in a command-capable context.
4. Event handlers that detect assistant markers, TDD markers, review loopbacks, or final completion must not call `ctx.newSession()` directly. They must persist a pending boundary and route replacement through a command-context boundary launcher.
5. The boundary launcher must use `await ctx.waitForIdle()` before session replacement when that API is available.
6. RalphWorks must persist workflow state to the current session before attempting session replacement.
7. RalphWorks must also write the same serialized next workflow state into the replacement session during `newSession({ setup })` using a RalphWorks custom state entry that does not participate in LLM context.
8. The replacement session must be restorable from its own custom state entry without relying on entries from the previous session.
9. Persisted state must include current phase, phase status, completed phases, transition history, artifact references, gate results, TDD implementation status, TDD completed task count, pending harden approval status, pending boundary metadata, and session boundary events.
10. Replacement sessions must not depend on previous assistant messages for correctness.
11. Replacement sessions must include bounded resume context that participates in LLM context.
12. Replacement sessions must include a visible RalphWorks system-style message such as: `RalphWorks is starting a new session for <boundary>. Repository files and RalphWorks artifacts are authoritative.` This must be implemented with Pi-supported `custom_message`/custom message APIs, not by appending an unsupported arbitrary `system` role message.
13. Custom state entries must not participate in LLM context. Custom resume/announcement messages may participate in LLM context and should be displayed.
14. Setup entries must not themselves trigger an agent turn. The only message that starts the next turn must be the intended kickoff prompt sent from the replacement context.
15. Resume context must include only high-value bounded information: workflow name, feature, current phase, boundary ID, boundary reason, next task ID and title when applicable, relevant artifact paths, latest gate status summary, pending approval state when applicable, and an instruction to inspect authoritative files.
16. Resume context must not include full prior conversation transcripts, long gate output, credentials, environment variables, or unbounded chat summaries.
17. Follow-up prompts after replacement must use the replacement-session context returned by `ctx.newSession({ withSession })`.
18. RalphWorks must not use stale captured `pi`, command `ctx`, `ctx.ui`, `ctx.sessionManager`, or model/session objects after successful replacement. Only plain data may be captured across replacement.
19. TUI updates and notifications after replacement must use the replacement context. The old context may be used only before replacement or after a cancelled replacement where the old session remains active.
20. Model routing must continue to respect `model.config.json` after session replacement, including default fallback when no phase-specific model is defined.
21. Model target resolution must occur before replacement as plain serializable provider/model identifiers. The replacement session must receive the selected model through a replacement-safe mechanism, such as appending Pi's model-change entry during `setup` or using a documented model setter on the replacement context if Pi adds one. Old `pi.setModel` must not be called after replacement.
22. Existing model error behavior must be preserved: missing configured models and unavailable API keys must still produce the same class of warning/error notification, without silently launching the next phase on an unintended model when a safe fallback is not available.
23. Gate execution must continue to respect `gate.config.json` before TDD task completion and review advancement.
24. Gate failures must continue to block TDD task completion and phase advancement when gates are required.
25. Review loopback must still return to `tdd_implement`, and the returned TDD turn must start from a fresh session.
26. Hardened spec completion must still pause for explicit user approval, and the pause state must be persisted and visible after session replacement.
27. Final LGTM completion must persist completed pipeline state and create a fresh completion boundary session without starting an unnecessary new phase prompt.
28. Existing in-progress pipelines with older compaction-oriented state fields must remain restorable or migrate safely.
29. Boundary handling must be idempotent: retrying a boundary launcher command for the same boundary ID must not send duplicate kickoff prompts or append conflicting state.
30. No full chat transcript should be copied into RalphWorks state, artifacts, setup entries, resume messages, or logs.

## 7. Inputs, Outputs, And Interfaces

Inputs:

- User-facing RalphWorks commands such as `/ralph-works start`, `/ralph-works next`, `/ralph-works approve`, `/ralph-works approve --render-html`, `/ralph-works tdd-complete`, `/ralph-works loopback`, and `/ralph-works reset`.
- An internal or implementation-private RalphWorks boundary launcher command, such as `/ralph-works continue-boundary <boundary-id>`, used to enter a command-capable context for automatic boundaries.
- Assistant markers such as `RALPH_PHASE_COMPLETE`, `RALPH_TDD_TASK_COMPLETE <task-id>`, review LGTM, and `RALPH_REVIEW_CHANGES_REQUESTED`.
- Existing artifact files under `docs/`.
- `gate.config.json` for gate execution.
- `model.config.json` for per-phase model routing.

Interfaces:

- Normal replacement path: `ctx.newSession({ parentSession, setup, withSession })` from a command-capable context.
- Parent session linkage: pass `parentSession` from the previous session file when `ctx.sessionManager.getSessionFile()` or equivalent is available.
- Replacement setup: use the provided replacement `SessionManager` to append RalphWorks custom state, displayed RalphWorks custom messages, optional model-change entries, and optional session name metadata.
- Replacement follow-up: use only the replacement context passed to `withSession` for prompt sending, post-switch TUI updates, and post-switch notifications.
- Fallback path: existing RalphWorks compaction behavior, invoked only when fresh session replacement is unavailable or throws before replacement.
- TUI and notification updates must reflect the current persisted RalphWorks state and must not require prior chat history.

Outputs:

- A fresh Pi session at every RalphWorks boundary on the normal path.
- A visible RalphWorks system-style custom message announcing the new session.
- Bounded resume context in the new session.
- The same phase prompts, TDD prompts, approval pause messages, loopback prompts, and completion notifications RalphWorks would otherwise produce, delivered from the correct session context.
- Diagnostic logs or notifications indicating new-session creation, cancellation, fallback compaction, or degraded behavior.

## 8. Data, State, And Artifacts

The hardened specification artifact is `docs/new-session-hardened-spec.md`.

RalphWorks runtime artifacts should remain under `docs/` using the existing feature-prefixed naming convention, including:

- `docs/<feature>-generated-spec.md`
- `docs/<feature>-red-team-findings.md`
- `docs/<feature>-hardened-spec.md`
- `docs/<feature>-hardened-spec.html`
- `docs/<feature>-task-list.md`
- `docs/<feature>-implementation-status.json`
- `docs/<feature>-review-findings.md`

State requirements:

- RalphWorks must persist state before session replacement in the current session.
- RalphWorks must seed the replacement session with an equivalent custom state entry during `newSession({ setup })`.
- The custom state entry should continue to use the existing RalphWorks state custom type unless a migration is explicitly required. Any new custom message type for boundary resume/announcement must be distinct from non-context state.
- Session boundary tracking must use `sessionBoundaryEvents` as the primary new field.
- New `sessionBoundaryEvents` entries must include:
  - `id`,
  - `boundaryType`,
  - `reason`,
  - `fromPhase`,
  - `toPhase` when applicable,
  - `taskId` when applicable,
  - `nextTaskId` when applicable,
  - timestamp,
  - status such as `pending`, `launching`, `created`, `cancelled`, `fallback_compaction`, `followup_failed`, or `complete`,
  - whether fresh session creation was attempted,
  - whether a fresh session was created,
  - whether fallback was used,
  - elapsed replacement/fallback time when available,
  - safe previous/replacement session identifiers when available.
- Existing persisted state that contains `compactionEvents` must remain readable. On restore, RalphWorks must preserve those events as historical compatibility data and must not require them to be renamed in-place.
- New boundary events should be appended to `sessionBoundaryEvents`. If existing utilities still require `compactionEvents` for fallback compatibility, mirroring must be minimal and must not make `compactionEvents` authoritative for new-session behavior.
- The implementation status artifact at `docs/<feature>-implementation-status.json` must be written or updated whenever TDD implementation status changes.
- The implementation status artifact must include enough durable state to avoid reselecting completed tasks after session replacement or Pi restart, including completed task IDs, claimed task IDs when relevant, gate results by task, and update metadata.
- RalphWorks must record the implementation status artifact path in artifact references when TDD begins or when the file is first written.
- Task selection after replacement must use durable state from persisted RalphWorks state and/or the implementation status artifact, not previous chat history.
- No full chat transcript should be copied into RalphWorks state or artifacts.

## 9. Boundary Orchestration Requirements

Assistant-driven boundaries require explicit orchestration because `ctx.newSession()` is command-context-only.

1. Marker/event handling must do only event-safe work:
   - parse the marker,
   - validate gates/review status,
   - compute the next state,
   - write durable artifacts such as implementation status,
   - persist the next state to the current session,
   - append or update a pending `sessionBoundaryEvents` entry,
   - enqueue the boundary launcher command as a follow-up message.
2. Marker/event handling must not call `ctx.newSession()`, `ctx.fork()`, or `ctx.switchSession()` directly.
3. The boundary launcher command must validate that the requested boundary ID is still pending for the restored state. Stale or duplicate boundary IDs must be ignored with a clear notification.
4. The boundary launcher command must build all cross-session data before replacement as plain JSON-compatible values.
5. The boundary launcher command must call `ctx.newSession()` with:
   - `parentSession` set to the previous session file when available,
   - `setup` that appends the next RalphWorks state custom entry,
   - `setup` that appends the displayed RalphWorks announcement/resume custom message,
   - `setup` that appends replacement-safe model/session metadata when applicable,
   - `withSession` that performs only replacement-context work.
6. The `withSession` callback must not reference old session-bound objects. It may use captured strings, IDs, artifact paths, serialized state, and prompt text.
7. The `withSession` callback must send at most one kickoff user message for boundaries that require agent work.
8. Pause and completion boundaries must not send a kickoff user message.
9. If `withSession` fails after the replacement session exists, RalphWorks must rely on the replacement session's seeded state and boundary ID to allow retry/resume. It must not try to send the prompt to the old session.
10. Tests must prove that phase-marker and TDD-marker boundaries reach `ctx.newSession()` through the command-context path and do not silently compact on the normal path.

## 10. Resume Context Requirements

Resume context must be concise, deterministic, and bounded. It should be produced from current state and artifact references rather than from chat history.

Required resume fields when available:

- feature name,
- current phase,
- phase status,
- boundary ID,
- boundary reason,
- next action type: phase prompt, TDD task prompt, approval pause, review loopback, or completion,
- artifact paths relevant to the next action,
- task ID, title, and acceptance criteria or task text for the next TDD task,
- latest gate result summary, without long raw command output,
- pending approval instruction when in `awaiting_harden_approval`,
- explicit instruction that repository files and RalphWorks artifacts are authoritative.

Resume context must not include:

- full prior user/assistant transcript,
- full generated specs or task lists when paths are sufficient,
- unbounded transition history,
- long gate logs,
- secrets, credentials, or environment dumps.

The visible announcement and resume context may be one custom message or separate displayed custom messages. They must be Pi-supported custom messages and must not trigger an agent turn.

## 11. Gate And Model Behavior

Gate behavior:

- `gate.config.json` remains the source of gate configuration.
- Required gates must run before a TDD task is marked complete.
- Required gate failures must block task completion and must not create a task-completion boundary session.
- Gate results must be persisted in RalphWorks state and in the implementation status artifact before any TDD boundary replacement.
- Gate summaries included in resume context must be bounded.

Model behavior:

- `model.config.json` remains the source of per-phase model routing.
- Existing default fallback behavior must remain unchanged when no phase-specific model is configured.
- For a fresh session, model routing must target the phase that will run in the replacement session.
- The selected model must be represented as plain serializable data before replacement.
- Replacement-safe model application must occur during replacement setup or through a documented replacement-context model API. Old `pi` or old command `ctx` must not be used after replacement.
- Missing configured models and unavailable API keys must still notify the user consistently with current behavior.

## 12. Non-Functional Requirements

- Performance: boundary continuation should not depend on model summarization latency on the normal path.
- Bounded context: resume messages must remain small as the number of phases, tasks, and previous turns grows.
- Reliability: workflow continuation must be resumable after Pi restart from persisted state and repository artifacts.
- Maintainability: keep orchestration logic in `src/harness/`, state helpers in `src/state/`, artifact/session summary helpers near existing artifact utilities, gate behavior in `src/gates/`, model behavior in `src/models/`, and TUI rendering in `src/tui/`.
- Compatibility: preserve existing command names, phase IDs, marker contracts, gate behavior, model config behavior, and existing state restoration.
- Observability: log or notify enough information to diagnose selected boundary behavior, boundary reason, fallback use, cancellation, elapsed replacement time, and safe session identifiers when available.
- Usability: users should see a concise RalphWorks system-style message when a new session starts, without noisy transcript dumps.
- Simplicity: the extension should remain a lightweight orchestrator; agent phases and skills continue to own substantive spec writing, hardening, task creation, implementation, and review.

## 13. Security, Privacy, And Abuse Considerations

- RalphWorks must not edit, delete, truncate, or rewrite Pi session history files.
- Resume context must not leak full prior conversation history into a new session.
- Repository files and RalphWorks artifacts must be identified as authoritative to reduce prompt-injection risk from prior chat content.
- Logs must avoid dumping full prompts, transcripts, credentials, environment variables, or gate command output unless existing debug behavior explicitly allows it.
- Safe observability fields are boundary type, boundary ID, reason, elapsed time, fallback/cancellation flags, task IDs, phase IDs, and session basenames or full session paths only when Pi already exposes them safely or existing debug behavior permits them.
- Fresh sessions should set `parentSession` to the previous session file when available so users can trace session lineage without transcript copying.
- Fallback compaction must use the same bounded summary principles as the current RalphWorks compaction summary and must not become a transcript-copying mechanism.
- No network calls should be introduced.

## 14. Edge Cases And Failure Modes

- `ctx.newSession()` is unavailable in the boundary launcher command: fall back to existing compaction behavior and notify/log the fallback.
- `ctx.newSession()` throws before replacement: fall back to existing compaction behavior and notify/log the fallback.
- `ctx.newSession()` returns `cancelled`: record/notify cancellation, keep the boundary resumable, and do not send a duplicate prompt.
- Replacement session is created but follow-up prompt fails: state must already exist in the replacement session, and the user should be able to resume or retry from status and artifacts.
- Boundary launcher command is invoked twice for the same boundary ID: do not send duplicate kickoff prompts; either no-op or report the boundary is already handled.
- Event handler cannot enqueue the internal boundary command: persist state and notify degraded behavior without corrupting workflow state.
- `ctx.compact()` is also unavailable during fallback: persist state, notify the user of degraded behavior, and avoid corrupting workflow state.
- Required gates fail: do not mark a TDD task complete, do not start a boundary new session for task completion, and show the existing failure notification.
- No next incomplete TDD task exists: advance to review through a single TDD-to-review boundary session instead of sending another TDD task prompt or creating redundant sessions.
- Harden spec completes: persist `awaiting_harden_approval`, start a fresh approval-pause session boundary, and wait for explicit approval.
- User approves harden spec from a resumed session: proceed through the command-context boundary flow and launch the next phase from a fresh session.
- Optional HTML render is requested: approval continuation launches `render_html_optional` from a fresh session; render completion then transitions through another normal boundary to task creation.
- Optional HTML render is not requested: approval continuation launches `create_tasks` from a fresh session.
- Review requests changes: loop back to TDD through a fresh session with bounded context and updated state.
- Review returns LGTM: persist completion and create the completion boundary session without launching another phase.
- Existing persisted state has only `compactionEvents`: restore it without losing workflow progress, preserve the historical data, and append new boundary events to `sessionBoundaryEvents`.

## 15. RalphWorks Workflow Impact

This feature changes the RalphWorks coordination layer, not the agent phase responsibilities. The extension remains responsible for phase tracking, TUI display, gate coordination, model routing, artifact references, and session-boundary handoff. The agent skills remain responsible for writing specs, red-team review, hardening, task creation, implementation, and review.

Workflow impact:

- Normal boundary handling changes from compaction-first to new-session-first.
- Automatic marker-driven boundaries require a command-context handoff before replacement.
- Phase transitions must persist state and then continue from replacement-session context.
- TDD task completion must persist implementation status before replacement and must continue with the next task from durable state.
- The final TDD task creates a single phase-transition boundary to review, not an extra redundant task boundary.
- `gate.config.json` remains the source for required gates and must still block TDD completion or review advancement on failure.
- `model.config.json` remains the source for phase model routing and must still be applied after session replacement.
- TUI should continue to show current RalphWorks status; the primary new user-visible feedback is the RalphWorks system-style message announcing a new session.
- Compaction summary utilities may become fallback/session-resume utilities, but the feature should avoid a broad project-management refactor.

## 16. Acceptance Criteria

- Starting a RalphWorks pipeline creates and launches the first phase from a fresh session after state is persisted.
- Assistant-driven phase completion boundaries route through a command-context boundary launcher before calling `ctx.newSession()`.
- Each phase transition creates a fresh session on the normal path and does not call `ctx.compact()`.
- TDD task completion persists gate results, implementation status state, and `docs/<feature>-implementation-status.json` before creating a fresh session.
- The next TDD continuation prompt is sent from the replacement-session context, not the old context.
- The final completed TDD task creates only the TDD-to-review boundary session and does not create a redundant extra task-boundary session.
- Review loopback to TDD starts from a fresh session with bounded resume context.
- Harden approval pause and approval continuation preserve the approval gate and use fresh-session boundaries.
- Final LGTM completion persists completed state and creates a final fresh-session boundary without launching another phase.
- Every replacement session includes a visible RalphWorks system-style custom message that RalphWorks is starting a new session.
- Every replacement session includes a custom RalphWorks state entry that can restore the workflow without prior chat history.
- Resume context includes current phase, relevant artifact paths, next task details when applicable, latest gate summary, and an instruction that repository files and RalphWorks artifacts are authoritative.
- Resume context does not include full previous conversation transcripts.
- No user-facing session strategy config is added.
- If `ctx.newSession()` is unavailable or throws before replacement in the boundary launcher command, RalphWorks falls back to existing compaction behavior and logs/notifies that fallback was used.
- If `ctx.newSession()` is cancelled or follow-up prompt delivery fails after replacement, RalphWorks handles the state without duplicate prompts and remains resumable.
- Existing gate and model configuration behavior remains unchanged.
- Existing persisted pipelines with `compactionEvents` can still be restored.
- Fresh sessions set `parentSession` when the previous session file is safely available.
- Tests cover fresh-session boundaries, command-context orchestration from marker events, setup state seeding, replacement custom messages, fallback compaction, cancellation/partial failure, stale context avoidance, bounded resume context, no-next-task behavior, harden approval behavior, review loopback, final completion, implementation status artifact updates, model routing, gate blocking, and old `compactionEvents` restoration.
- `npm run check` and `npm test` pass after implementation.

## 17. Assumptions And Open Questions

Assumptions:

- “All RalphWorks boundaries” includes pipeline start, every phase transition, harden approval pause, harden approval continuation, TDD task boundaries, review loopback, and final completion.
- Compaction remains available only as a fallback for RalphWorks boundary handling.
- No user-facing session strategy configuration should be added.
- The implementation work occurs on git branch `feature/new-session`, but the RalphWorks extension should not create or manage git branches at runtime.
- Pi replacement-session APIs support sending follow-up user messages from the replacement context passed to `withSession`.
- Pi session setup supports appending custom entries and custom message entries to the replacement session before kickoff prompt delivery.

Open questions: none that block task creation.
