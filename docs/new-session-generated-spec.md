# new-session Generated Spec

## 1. Purpose And User Value

RalphWorks should replace model-backed compaction at RalphWorks workflow boundaries with fresh Pi sessions. The value is faster phase-to-phase and task-to-task continuation, lower dependence on long conversation history, and clearer reliance on durable repository artifacts and persisted RalphWorks state.

A successful implementation starts the next RalphWorks step from a fresh Pi session, seeds that session with bounded resume context, and preserves workflow correctness without requiring model summarization of the previous session.

## 2. Intended Users And Context

The intended users are RalphWorks users running the Pi extension, maintainers of this repository, and downstream RalphWorks agent phases that depend on correct phase state and artifact paths.

Relevant context:

- RalphWorks currently uses Pi compaction at phase and TDD task boundaries.
- Pi exposes `ctx.newSession()` as the supported way to create a replacement session.
- Pi compaction remains available in Pi, but RalphWorks should not use it on the normal boundary path.
- Durable state and repository artifacts, not chat history, must be authoritative for workflow continuation.
- This implementation work should be done on a git feature branch, but RalphWorks must not gain runtime git branch management behavior.

## 3. Scope

In scope:

- Replace normal RalphWorks boundary compaction with fresh Pi session creation.
- Apply fresh-session behavior at all RalphWorks workflow boundaries, including pipeline start, phase transitions, harden approval pause and approval continuation, TDD task boundaries, review loopbacks, and final completion.
- Persist RalphWorks state before replacing a session.
- Seed replacement sessions with bounded resume context and a visible system message that a new session is starting.
- Send any follow-up phase or TDD continuation prompt from the replacement-session context.
- Fall back to existing compaction behavior when `ctx.newSession()` is unavailable or fails before replacement.
- Preserve gate behavior, model routing behavior, artifact paths, phase state, and workflow semantics.
- Add or update automated tests for the new-session path and compaction fallback.

Out of scope:

- Removing Pi compaction globally.
- Adding a user-facing session strategy configuration option.
- Editing, truncating, deleting, or rewriting Pi JSONL session history.
- Making chat history the source of truth for RalphWorks progress.
- Changing the RalphWorks phase model or skill responsibilities.
- Adding runtime git branch creation, switching, verification, or branch lifecycle management to the RalphWorks extension.
- Introducing network-dependent behavior.

## 4. User Workflows

Main workflow:

1. The user starts or continues a RalphWorks pipeline.
2. RalphWorks persists the current workflow state and artifact references before each boundary transition.
3. RalphWorks creates a fresh Pi session using `ctx.newSession()`.
4. The new session receives a brief system message stating that RalphWorks is starting a new session.
5. The new session receives bounded resume context that points to authoritative repository files and RalphWorks artifacts.
6. RalphWorks sends the next phase prompt, TDD continuation prompt, approval pause message, loopback prompt, or completion notification from the replacement-session context as applicable.
7. The agent continues by inspecting durable artifacts and repository files instead of relying on prior chat history.

Fallback workflow:

1. RalphWorks reaches a boundary and persists state.
2. If `ctx.newSession()` is unavailable or fails before replacement, RalphWorks invokes the existing compaction path.
3. RalphWorks clearly notifies or logs that compaction fallback was used.
4. After fallback completion, RalphWorks continues with the same next prompt or pause behavior that the fresh-session path would have used.

TDD task workflow:

1. A TDD task is marked complete only after required gates pass.
2. RalphWorks updates implementation status and persisted workflow state.
3. If another incomplete task remains, RalphWorks starts a fresh session and sends the next TDD continuation prompt from that replacement context.
4. If no incomplete task remains, RalphWorks starts a fresh session at the boundary and advances normally to review.

## 5. Functional Requirements

1. RalphWorks must use `ctx.newSession()` instead of `ctx.compact()` on the normal path for all RalphWorks workflow boundaries.
2. RalphWorks must not expose a user-facing session strategy configuration option for this feature.
3. RalphWorks must keep compaction available only as an explicit fallback when fresh session creation is unavailable or fails before replacement.
4. RalphWorks must persist workflow state before attempting session replacement.
5. Persisted state must include current phase, phase status, completed phases, transition history, artifact references, gate results, TDD implementation status, TDD completed task count, and any pending harden approval status.
6. Replacement sessions must not depend on previous assistant messages for correctness.
7. Replacement sessions must include a custom RalphWorks state entry that does not participate in LLM context when the Pi API supports such entries.
8. Replacement sessions must include bounded resume context that does participate in LLM context.
9. Replacement sessions must include a visible system message such as: `RalphWorks is starting a new session for <boundary>. Repository files and RalphWorks artifacts are authoritative.`
10. Resume context must include only high-value bounded information: workflow name, current phase, boundary reason, next task ID and title when applicable, relevant artifact paths, latest gate status summary, pending approval state when applicable, and an instruction to inspect authoritative files.
11. Resume context must not include full prior conversation transcripts.
12. Follow-up prompts after replacement must use the replacement-session context returned by `ctx.newSession({ withSession })`.
13. RalphWorks must not use stale captured context objects for follow-up prompts, model routing, TUI updates, or notifications after replacement when a replacement context is available.
14. Gate failures must continue to block TDD task completion and review advancement.
15. Model routing must continue to respect `model.config.json` after session replacement.
16. Gate execution must continue to respect `gate.config.json` before TDD task completion and review advancement.
17. Review loopback must still return to `tdd_implement`, but the returned TDD turn must start from a fresh session.
18. Hardened spec completion must still pause for explicit user approval, but the pause state must be persisted and visible after session replacement.
19. Final LGTM completion must persist completed pipeline state and create a fresh session boundary without starting an unnecessary new phase prompt.
20. Existing in-progress pipelines with older compaction-oriented state fields must remain restorable or migrate safely.

## 6. Inputs, Outputs, And Interfaces

Inputs:

- RalphWorks commands such as `/ralph-works start`, `/ralph-works next`, `/ralph-works approve`, `/ralph-works tdd-complete`, `/ralph-works loopback`, and `/ralph-works reset`.
- Assistant markers such as `RALPH_PHASE_COMPLETE`, `RALPH_TDD_TASK_COMPLETE <task-id>`, review LGTM, and review change requests.
- Existing artifact files under `docs/`.
- `gate.config.json` for gate execution.
- `model.config.json` for per-phase model routing.

Interfaces:

- Normal path: `ctx.newSession()` with the documented replacement-session callback/context flow.
- Fallback path: existing `ctx.compact()` behavior.
- Pi message sending must occur through the active replacement context when a new session is created.
- TUI and notification updates must reflect the current persisted RalphWorks state.

Outputs:

- A fresh Pi session at every RalphWorks boundary on the normal path.
- A visible system message announcing the new RalphWorks session.
- A bounded resume message in the new session.
- The same phase prompts, TDD prompts, approval pause messages, and completion notifications RalphWorks would otherwise produce, delivered from the correct session context.
- Diagnostic logs or notifications indicating new-session creation or compaction fallback.

## 7. Data, State, And Artifacts

The generated specification artifact for this phase is `docs/new-session-generated-spec.md`.

RalphWorks runtime artifacts should remain under `docs/` using the existing feature-prefixed naming convention, including:

- `docs/<feature>-generated-spec.md`
- `docs/<feature>-red-team-findings.md`
- `docs/<feature>-hardened-spec.md`
- `docs/<feature>-hardened-spec.html`
- `docs/<feature>-task-list.md`
- `docs/<feature>-implementation-status.json`
- `docs/<feature>-review-findings.md`

State requirements:

- RalphWorks must persist state before session replacement.
- Session boundary tracking should use fresh-session-oriented naming, such as `sessionBoundaryEvents`, or otherwise clearly distinguish fresh-session events from compaction events.
- Existing persisted state that contains `compactionEvents` must remain readable for compatibility.
- Each boundary event should record boundary type, reason, timestamp, whether a fresh session was created, whether fallback was used, and session identifiers or file paths when safely available.
- The implementation status artifact must remain the durable source of truth for completed TDD tasks.
- No full chat transcript should be copied into RalphWorks state or artifacts.

## 8. Non-Functional Requirements

- Performance: boundary continuation should not depend on model summarization latency on the normal path.
- Bounded context: resume messages must remain small as the number of phases, tasks, and previous turns grows.
- Reliability: workflow continuation must be resumable after Pi restart from persisted state and repository artifacts.
- Maintainability: keep orchestration logic in `src/harness/`, state helpers in `src/state/`, and artifact/session summary helpers near existing artifact utilities.
- Compatibility: preserve existing command names, phase IDs, marker contracts, gate behavior, and model config behavior.
- Observability: log or notify enough information to diagnose selected boundary behavior, boundary reason, fallback use, elapsed replacement time, and safe session identifiers when available.
- Usability: users should see a concise system message when a new session starts, without noisy transcript dumps.

## 9. Security, Privacy, And Abuse Considerations

- RalphWorks must not edit, delete, truncate, or rewrite Pi session history files.
- Resume context must not leak full prior conversation history into a new session.
- Repository files and RalphWorks artifacts must be identified as authoritative to reduce prompt-injection risk from prior chat content.
- Logs must avoid dumping full prompts, transcripts, credentials, environment variables, or gate command output unless existing debug behavior explicitly allows it.
- Fallback compaction must use the same bounded summary principles as the current RalphWorks compaction summary and must not become a transcript-copying mechanism.
- No network calls should be introduced.

## 10. Edge Cases And Failure Modes

- `ctx.newSession()` is unavailable: fall back to existing compaction behavior and notify/log the fallback.
- `ctx.newSession()` throws before a replacement context is available: fall back to existing compaction behavior and notify/log the fallback.
- Replacement session is created but follow-up prompt fails: state must already be persisted, and the user should be able to resume from status and artifacts.
- `ctx.compact()` is also unavailable during fallback: RalphWorks should persist state, notify the user of degraded behavior, and avoid corrupting workflow state.
- Required gates fail: do not mark a TDD task complete, do not start a boundary new session for task completion, and show the existing failure notification.
- No next incomplete TDD task exists: advance to the next phase through the boundary flow instead of sending another TDD task prompt.
- Harden spec completes: persist `awaiting_harden_approval`, start a fresh session boundary, and wait for explicit approval.
- User approves harden spec from a resumed session: proceed through the boundary flow and launch the next phase from a fresh session.
- Review requests changes: loop back to TDD through a fresh session with bounded context.
- Review returns LGTM: persist completion and create the completion boundary session without launching another phase.
- Existing persisted state has only compaction event history: restore it without losing workflow progress.

## 11. RalphWorks Workflow Impact

This feature changes the RalphWorks coordination layer, not the agent phase responsibilities. The extension remains responsible for phase tracking, TUI display, gate coordination, model routing, artifact references, and session-boundary handoff. The agent skills remain responsible for writing specs, red-team review, hardening, task creation, implementation, and review.

Workflow impact:

- Normal boundary handling changes from compaction-first to new-session-first.
- Phase transitions must persist state and then continue from replacement-session context.
- TDD task completion must persist implementation status before replacement and must continue with the next task from durable state.
- `gate.config.json` remains the source for required gates and must still block TDD completion or review advancement on failure.
- `model.config.json` remains the source for phase model routing and must still be applied after session replacement.
- TUI should continue to show current RalphWorks status; the primary new user-visible feedback is the system message announcing a new session.
- Compaction summary utilities may become fallback/session-resume utilities, but the feature should avoid a broad project-management refactor.

## 12. Acceptance Criteria

- Starting a RalphWorks pipeline creates and launches the first phase from a fresh session after state is persisted.
- Each phase transition creates a fresh session on the normal path and does not call `ctx.compact()`.
- TDD task completion persists gate results and implementation status before creating a fresh session.
- The next TDD continuation prompt is sent from the replacement-session context, not the old context.
- Review loopback to TDD starts from a fresh session with bounded resume context.
- Harden approval pause and approval continuation preserve the approval gate and use fresh-session boundaries.
- Final LGTM completion persists completed state and creates a final fresh-session boundary without launching another phase.
- Every replacement session includes a visible system message that RalphWorks is starting a new session.
- Resume context includes current phase, relevant artifact paths, next task details when applicable, latest gate summary, and an instruction that repository files and RalphWorks artifacts are authoritative.
- Resume context does not include full previous conversation transcripts.
- No user-facing session strategy config is added.
- If `ctx.newSession()` is unavailable or fails before replacement, RalphWorks falls back to existing compaction behavior and logs/notifies that fallback was used.
- Existing gate and model configuration behavior remains unchanged.
- Existing persisted pipelines with compaction event state can still be restored.
- Tests cover fresh-session boundaries, fallback compaction, stale context avoidance, bounded resume context, no-next-task behavior, harden approval behavior, review loopback, and final completion.
- `npm run check` and `npm test` pass after implementation.

## 13. Assumptions And Open Questions

Assumptions:

- “All RalphWorks boundaries” includes pipeline start, every phase transition, harden approval pause, harden approval continuation, TDD task boundaries, review loopback, and final completion.
- Compaction remains available only as a fallback for RalphWorks boundary handling.
- No user-facing session strategy configuration should be added.
- The implementation work should occur on a git feature branch, but the RalphWorks extension should not create or manage git branches at runtime.
- Pi replacement-session APIs support sending follow-up messages from the replacement context passed to `withSession`.

Open questions: none that block task creation.
