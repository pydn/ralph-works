# new-session Red-Team Findings

## Summary

The generated spec captures the user's main intent, but it has several implementation-critical gaps around Pi's session replacement lifecycle. The largest risk is that many RalphWorks boundaries currently happen from event handlers, while Pi documents `ctx.newSession()` as a command-context session control API. If the hardening pass does not resolve that mismatch, the implementation will either call an unsupported API, fall back to compaction for the most important automatic boundaries, or lose workflow state after replacement.

## Critical Findings

### 1. `ctx.newSession()` is specified for boundaries that are currently event-driven

**Risk:** The spec requires fresh sessions at all RalphWorks boundaries, including phase completion markers, TDD task markers, review loopbacks, harden pauses, and final LGTM. In the current extension, many of these are triggered from `agent_end` event handling. Pi's extension docs describe `ctx.newSession()` under `ExtensionCommandContext` and state that session control methods are only available in commands because they can deadlock if called from event handlers.

**Why it matters:** If implementation calls `ctx.newSession()` directly from `agent_end`, it may fail or be unavailable. If the implementation treats that as the fallback path, the normal automatic workflow would continue compacting after most assistant-driven boundaries, which defeats the feature goal.

**Recommended spec change:** Add an explicit requirement for a supported session-replacement orchestration path for assistant-driven boundaries. The hardened spec should state whether RalphWorks will move automatic boundary continuation into a command/tool context that supports session control, schedule a clear deferred continuation command when automatic session replacement is not supported, or use another documented Pi mechanism. Compaction fallback should be reserved for genuine API absence/failure in a context expected to support `newSession()`, not as the default path for all event-triggered boundaries. Add tests for phase-marker and TDD-marker boundaries proving they do not silently compact on the normal path.

### 2. State persistence into the replacement session is underspecified

**Risk:** The spec says state must be persisted before replacement and the replacement session must include a custom RalphWorks state entry, but it does not specify the required sequencing. The existing persistence model appends RalphWorks state to the current session. A fresh session will not automatically contain that state unless the implementation writes it during `ctx.newSession({ setup })` or equivalent replacement-session setup.

**Why it matters:** Pi runs the new extension instance's `session_start` before `withSession` work completes. If the new session does not already contain the RalphWorks custom state entry, restore logic may show no active pipeline, model routing/TUI state may be wrong, and follow-up prompts may be launched from stale closure state rather than restored durable state.

**Recommended spec change:** Require the boundary handler to serialize the next RalphWorks state before replacement, write that state both to the old session before attempting replacement and to the new session during `newSession` setup via the documented custom entry mechanism, and ensure the new session can restore state on `session_start` before any follow-up prompt is sent. Add tests that inspect the replacement session entries and verify a new extension instance can restore the workflow state without prior chat history.

### 3. Stale `pi`/`ctx` usage is only partially addressed

**Risk:** The spec says not to use stale captured contexts after replacement, but it still requires model routing, TUI updates, notifications, and prompt sending after replacement without defining replacement-safe interfaces. Current RalphWorks code routes models via `pi.setModel`, sends prompts via `pi.sendUserMessage`, and updates UI through the old `ctx`. Pi's docs warn that captured old `pi` and command `ctx` session-bound objects are stale after replacement and that `withSession` must use the replacement context.

**Why it matters:** A naive implementation could create a fresh session and then fail when launching the next phase, or worse, send the next prompt to the old session. Model routing may also silently stop applying after replacement if it depends on stale `pi.setModel` behavior.

**Recommended spec change:** Harden the spec to require a replacement-safe boundary API: only plain serialized data may be captured across replacement, and all session-bound work after replacement must use the `withSession` replacement context. The spec should define how phase prompt delivery, TUI updates, notifications, and model selection are performed safely after replacement, including a concrete safe path for model routing such as appending model-change state during setup or using a documented replacement-session-safe model API. Tests should fail if old `pi.sendUserMessage`, old `pi.setModel`, old `ctx.ui`, or old `ctx.sessionManager` are used after a successful replacement.

### 4. Prompt seeding semantics are ambiguous and could trigger duplicate or malformed turns

**Risk:** The spec asks for a visible "system message," bounded resume context that participates in LLM context, and a follow-up phase/TDD prompt, but it does not distinguish which entries are setup-only context and which message starts the next agent turn. Pi session format documents custom entries that do not enter LLM context and custom message entries that do enter LLM context; it does not document arbitrary persisted `system` role messages in normal session history.

**Why it matters:** Implementers may send the announcement or resume context as normal user messages, accidentally queueing extra agent turns, or may attempt to append an unsupported system-role entry. That could cause duplicate phase prompts, confusing user-visible messages, or invalid session entries.

**Recommended spec change:** Replace "system message" with a Pi-specific requirement: use a displayed RalphWorks `custom_message` entry for the visible announcement/resume context, and use a separate `custom` entry for non-context state. The setup context should be present before the kickoff prompt but must not itself trigger an agent turn. The only message that should start the next agent turn is the intended phase/TDD continuation prompt sent from the replacement context.

## Warnings

### 5. Cancellation and partial-failure behavior for `newSession()` is not defined

**Risk:** The spec covers unavailable `ctx.newSession()` and throws before replacement, but not `result.cancelled`, extension-cancelled switches, failures after a new session is created, or retry behavior.

**Why it matters:** State may already have advanced when a new session is cancelled or a follow-up prompt fails. Without an idempotency rule, RalphWorks can duplicate prompts, double-record boundary events, or strand a pipeline in a phase whose prompt was never delivered.

**Recommended spec change:** Define outcome handling for `newSession()` success, cancellation, pre-switch failure, post-switch follow-up failure, and compaction fallback failure. Require a per-boundary launch-once guard or boundary event ID so callbacks and retries cannot deliver duplicate prompts.

### 6. Durable implementation status artifact requirements need to be explicit

**Risk:** The spec says repository files and RalphWorks artifacts are authoritative and names `docs/<feature>-implementation-status.json`, but it does not explicitly require writing or updating that artifact when TDD status changes.

**Why it matters:** If TDD progress only lives in session custom entries, the fresh-session design still depends heavily on session history and contradicts the stated durable-artifact source of truth. This is especially risky for restart recovery and task reselection correctness.

**Recommended spec change:** Require RalphWorks to write/update the implementation status artifact whenever TDD task state changes, record the artifact reference, and include that path in resume context. Add tests that task selection after session replacement reads durable state correctly and does not reselect completed tasks.

### 7. Boundary event naming and migration need a precise compatibility rule

**Risk:** The spec suggests replacing or distinguishing `compactionEvents` with fresh-session-oriented tracking but does not define the schema or migration behavior.

**Why it matters:** Existing persisted sessions and tests may contain `compactionEvents`. A broad rename could break restoration or lose transition history used by summaries and TUI display.

**Recommended spec change:** Define a concrete boundary event schema, such as `sessionBoundaryEvents`, and state exactly how existing `compactionEvents` are preserved, mapped, or read for backward compatibility. Tests should cover restoring old state that only has `compactionEvents`.

### 8. Parent-session linkage and safe observability should be required, not optional

**Risk:** The spec says to log session identifiers or file paths "when safely available," but does not require `parentSession` linkage or define what is safe to log.

**Why it matters:** Without parent linkage, users may have trouble tracing the sequence of fresh sessions. Without safe logging boundaries, logs could either omit useful diagnostics or expose too much session detail.

**Recommended spec change:** Require fresh sessions to set `parentSession` to the previous session file when available, and define safe observability fields: boundary type, reason, elapsed time, fallback flag, previous session basename/path only when Pi already exposes it safely, and replacement session basename/path when available. Continue to prohibit prompt/transcript dumps.
