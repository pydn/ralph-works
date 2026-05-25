# Technical Requirements: Replace Per-Task TDD Compaction With Fresh Session Resume

## Background

RalphWorks currently calls Pi compaction after each completed TDD task and only schedules the next TDD task from the compaction `onComplete` callback. In observed sessions, this causes long idle gaps between TDD tasks because compaction performs model-based summarization over the existing conversation history.

For TDD implementation, durable project artifacts should be the source of truth:

- `spec.md`
- `tasks.md`
- `implementation-status.md`
- gate results
- source files and tests
- RalphWorks persisted phase/task state

The conversation history should be treated as disposable coordination context. The preferred strategy is to start a fresh Pi session between TDD tasks, seed it with bounded resume context, and continue from durable state instead of summarizing the old session.

## Goal

Replace automatic per-task TDD compaction with a fresh-session resume strategy that improves task-to-task latency while preserving implementation correctness and workflow continuity.

## Non-Goals

- Do not remove Pi compaction globally.
- Do not change the RalphWorks phase model.
- Do not rely on editing or deleting Pi JSONL session history.
- Do not make chat history the source of truth for TDD progress.
- Do not introduce network-dependent behavior.

## Pi API Constraints

RalphWorks must follow the documented Pi session APIs:

- `ctx.compact()` is the supported summarization path, but it is model-backed and can be slow.
- `ctx.newSession()` creates a replacement session and is the closest supported substitute for clearing history.
- `ctx.sessionManager` in normal extension contexts is read-only.
- `SessionManager` is append-only; entries cannot be modified or deleted.
- `ctx.newSession()`, `ctx.fork()`, and `ctx.switchSession()` provide replacement-session contexts. Follow-up work must use the replacement context passed to `withSession`.

The implementation must not attempt to truncate, rewrite, or delete the current Pi session file.

## Functional Requirements

### Session Strategy

1. RalphWorks must support a TDD task-boundary session strategy that starts a fresh Pi session after a TDD task is marked complete.
2. The fresh-session strategy must replace the current per-task call to `ctx.compact()` for TDD task continuation.
3. Compaction must remain available for phase boundaries, manual usage, or an explicit fallback path.
4. The default TDD behavior should prefer fresh-session resume over per-task compaction when Pi exposes `ctx.newSession()`.
5. If `ctx.newSession()` is unavailable in the current context, RalphWorks must fail gracefully by either:
   - falling back to existing compaction behavior, or
   - continuing in the current session with a bounded resume prompt.

The chosen fallback must be explicit in logs and tests.

### Durable State

1. Before replacing the session, RalphWorks must persist all TDD progress required to resume:
   - completed task ID
   - remaining task list
   - current phase
   - implementation status path
   - latest gate result summary
   - transition history required by the workflow controller
2. The new session must not depend on previous assistant messages for correctness.
3. The new session must include a custom entry containing RalphWorks state that does not participate in LLM context.
4. The new session must include a bounded resume message that does participate in LLM context.

### Resume Context

The resume message in the new session must include only bounded, high-value context:

- workflow name and current phase
- next incomplete task ID and title
- task acceptance criteria or task text
- artifact paths the agent must inspect
- latest gate status summary
- explicit instruction that repository files and RalphWorks artifacts are authoritative

The resume message must not include full prior conversation transcripts.

### Continuation Flow

1. After completing a TDD task, RalphWorks must:
   - mark the task complete
   - update implementation status
   - persist RalphWorks state
   - determine the next incomplete task
   - replace the Pi session or apply the configured fallback
   - send the next TDD continuation prompt
2. The continuation prompt must be sent from the replacement-session context returned by `ctx.newSession({ withSession })`.
3. The implementation must not use stale captured `ctx` or `pi` objects after session replacement.
4. If there is no next incomplete task, RalphWorks must continue to the normal post-TDD phase transition without starting an unnecessary new session.

### Configuration

RalphWorks should expose a narrowly scoped configuration option for TDD session handling.

Recommended shape:

```json
{
  "tdd": {
    "sessionStrategy": "fresh-session"
  }
}
```

Supported values should be:

- `"fresh-session"`: replace the session at TDD task boundaries.
- `"compact"`: preserve existing per-task compaction behavior.
- `"none"`: continue in the current session without compaction or session replacement.

If this project already has a stronger configuration convention, use that convention instead of introducing a separate config file.

### Observability

RalphWorks must log enough information to diagnose session-boundary behavior:

- selected TDD session strategy
- completed task ID
- next task ID, if any
- whether a fresh session was created
- whether fallback was used
- time spent in session replacement or compaction
- session file before and after replacement, when available

Logs must avoid dumping full prompt contents unless debug logging is explicitly enabled.

## Performance Requirements

1. The time between recording one TDD task complete and sending the next TDD continuation prompt should not depend on model summarization latency when using `"fresh-session"`.
2. Resume context size must remain bounded as the number of TDD tasks grows.
3. Per-task transition overhead should be dominated by state persistence and session creation, not LLM summarization.

## Correctness Requirements

1. A fresh-session resume must produce the same task ordering as the current compaction-based flow.
2. Completed tasks must never be reselected unless task state is explicitly reset by the user.
3. Gate failures must still be visible to the next TDD turn.
4. The agent must still be instructed to follow the TDD phase skill contract.
5. The workflow must remain resumable after Pi restart.

## Testing Requirements

Add or update tests for:

1. Completing a TDD task with `"fresh-session"` persists state before session replacement.
2. Completing a TDD task with `"fresh-session"` calls `ctx.newSession()` instead of `ctx.compact()`.
3. The next prompt is sent through the replacement-session context.
4. The old context is not used after replacement.
5. The resume message contains bounded context and artifact paths.
6. No new session is created when all TDD tasks are complete.
7. Fallback behavior is exercised when `ctx.newSession()` is unavailable.
8. Existing `"compact"` behavior remains covered.
9. Existing `"none"` behavior continues immediately without compaction.

## Acceptance Criteria

The change is complete when:

- TDD task boundaries no longer compact by default.
- A fresh Pi session is created between TDD tasks when configured.
- The next TDD task starts from durable RalphWorks state and bounded resume context.
- Existing compaction behavior remains available behind configuration or fallback.
- Unit tests cover the new session strategy and legacy compaction path.
- Manual log inspection shows no multi-minute compaction wait between consecutive TDD tasks under the fresh-session strategy.
