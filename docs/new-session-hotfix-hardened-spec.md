# new-session-hotfix Hardened Spec

## 1. Purpose And User Value

The feature fixes the RalphWorks `ralph_works_transition` tool so model-initiated workflow transitions use the same fresh-session handoff pattern as assistant-marker transitions. Today, the tool can advance RalphWorks state, but it launches the next session boundary directly from tool execution context. Pi tool context does not expose command-only session controls such as `ctx.newSession(...)`, so RalphWorks records a compaction fallback even though no fresh-session attempt was possible.

The user value is that a model can safely call `ralph_works_transition` without causing avoidable fallback compaction. A successful fix advances the workflow when advancement is legal, persists a pending boundary, queues `/ralph-works continue-boundary <boundary-id>` for command-context execution, and lets the queued command create the fresh session.

The hotfix must not weaken RalphWorks workflow safety. Tool calls must not bypass harden approval, required gates, review LGTM requirements, review loopback behavior, or boundary validation.

## 2. Intended Users And Context

Intended users and readers are:

- RalphWorks users who rely on model/tool-driven phase transitions.
- The Pi agent model, which may call `ralph_works_transition` at phase completion.
- RalphWorks maintainers implementing and reviewing the hotfix.
- Later RalphWorks phases that depend on accurate persisted state and boundary metadata.

Repository context:

- The source prompt is `docs/ralph-works-transition-fresh-session-fix.md`.
- The generated spec artifact is `docs/new-session-hotfix-generated-spec.md`.
- The red-team findings artifact is `docs/new-session-hotfix-red-team-findings.md`.
- The hardened spec artifact is `docs/new-session-hotfix-hardened-spec.md`.
- Pi exposes `ctx.newSession(...)` only from command-capable contexts, not from tools or general event handlers.
- RalphWorks already has a command-context handoff pattern for assistant-marker events: persist the new state, append a pending session boundary event, enqueue `/ralph-works continue-boundary <boundary-id>` as a follow-up user message, then let the command handler launch the fresh session.
- Existing slash commands such as `/ralph-works next` already run in command context and should keep launching boundaries immediately.

## 3. Scope

In scope:

- Change `ralph_works_transition` so it uses a command-context handoff instead of launching the session boundary directly from tool context.
- Ensure the tool advances to the next legal workflow state only when the current phase permits tool advancement.
- Persist the advanced state and record a pending session boundary before queuing the handoff command.
- Apply the same handoff behavior when the tool is called from `harden_spec` and must pause for explicit harden approval.
- Prevent duplicate pending boundaries when `ralph_works_transition` is called again before the previously queued boundary has been continued.
- Preserve required gate checks, phase transition legality, artifact tracking, model routing, TUI updates, and existing command behavior.
- Preserve review completion safety: review completes only through LGTM or the existing review approval path, and changes requested still loop back to `tdd_implement`.
- Add or update focused automated tests for normal tool handoff, command continuation, harden-spec pause handoff, unavailable follow-up queueing, duplicate pending-boundary prevention, review-phase blocking, and regression behavior.

Out of scope:

- Redesigning RalphWorks fresh-session architecture beyond this hotfix.
- Changing Pi's tool, command, or session-control APIs.
- Enqueuing Pi's `/new` command as text.
- Adding a user-facing session strategy option.
- Changing RalphWorks phase definitions, skill responsibilities, gate semantics, review semantics, or artifact naming conventions.
- Changing slash-command behavior for `/ralph-works next`, `/ralph-works approve`, `/ralph-works start`, or assistant-marker handoff paths except where tests need to assert they remain unchanged.

## 4. User Workflows

### Main model-tool workflow

1. A RalphWorks pipeline is active and the model calls `ralph_works_transition`.
2. RalphWorks first checks whether an unresolved boundary already targets the current persisted phase. If so, it reuses that boundary and does not advance state.
3. If no reusable unresolved boundary exists, RalphWorks validates that tool advancement is allowed from the current phase and runs any required gates for the current phase.
4. RalphWorks computes the next workflow state using the existing transition rules, except for protected phases such as `harden_spec` and `review` where special workflow rules apply.
5. RalphWorks persists the advanced state and appends one pending session boundary event.
6. RalphWorks attempts to enqueue `/ralph-works continue-boundary <boundary-id>` with `deliverAs: "followUp"`.
7. The tool returns the updated state. No extra user-facing tool notification is required on the successful queueing path.
8. The queued `continue-boundary` command later runs in command context and performs the actual fresh-session launch.

### Unavailable follow-up queue workflow

1. The model calls `ralph_works_transition` and the transition is otherwise valid, or the call reuses an existing unresolved boundary.
2. RalphWorks persists the state and pending/retryable boundary before reporting recovery instructions.
3. If `pi.sendUserMessage` is unavailable or throws, RalphWorks does not trigger compaction from the tool call.
4. RalphWorks marks the boundary with a durable retryable indication such as `status: "followup_failed"` or an equivalent persisted field.
5. RalphWorks notifies the user with the exact manual command to run: `/ralph-works continue-boundary <boundary-id>`.
6. The pending/retryable boundary remains resumable after state restoration.

### Duplicate pending-boundary workflow

1. `ralph_works_transition` is called while a pending or retryable boundary from a previous handoff has not been continued.
2. RalphWorks checks for the unresolved boundary before running gates, computing a new transition, or changing state.
3. RalphWorks reuses the latest unresolved phase boundary whose `toPhase` matches the current persisted `currentPhase` and whose status is still launchable/retryable.
4. RalphWorks does not advance to another phase, does not append another pending boundary, and does not rerun gates.
5. If follow-up messages are available, RalphWorks may requeue the same `continue-boundary` command. If not, it notifies the user with the same manual command.
6. The tool returns the current persisted state.

### Harden-spec tool workflow

1. `ralph_works_transition` is called while `currentPhase` is `harden_spec` and the phase is not already awaiting approval.
2. RalphWorks changes only `phaseStatus` to `awaiting_harden_approval`, persists that state, and appends one pending phase boundary from `harden_spec` to `harden_spec`.
3. During the tool call, RalphWorks preserves the same harden-approval user message it shows today: approval must be done with `/ralph-works approve` or `/ralph-works approve --render-html`.
4. The queued `continue-boundary` command creates the approval-pause session behavior, makes the approval instruction visible in the replacement session, and does not send a next-phase kickoff prompt.
5. RalphWorks remains paused until the user explicitly runs `/ralph-works approve` or `/ralph-works approve --render-html`.

### Review-phase workflow

1. `ralph_works_transition` must not advance directly from `review` to `complete`.
2. Review completion still requires LGTM through the existing review completion path, such as recognized LGTM review output or the existing review approval command behavior.
3. Review changes requested still use the existing loopback path to `tdd_implement`.
4. A tool call made during `review` without a valid LGTM completion signal must not create a completion boundary, mark the pipeline complete, or skip review feedback handling.

### Slash-command workflow

1. A user runs `/ralph-works next` or another command-context transition command.
2. Existing behavior is preserved: command handlers may launch the session boundary immediately because command context can provide `ctx.newSession(...)`.
3. Command-context behavior is tested separately from tool handoff behavior so the hotfix cannot accidentally make command paths enqueue instead of launching.

## 5. Functional Requirements

1. `ralph_works_transition` must not call the session-boundary launcher directly from tool execution context.
2. `ralph_works_transition` must not call `ctx.newSession(...)` directly.
3. `ralph_works_transition` must not trigger `ctx.compact(...)` during the tool call when a command-context handoff can be recorded.
4. Before running gates, computing a new transition, or mutating state, the tool must check for a reusable unresolved session boundary.
5. A reusable unresolved boundary is the latest pending or retryable phase boundary whose target phase matches the current persisted phase and whose status can still be continued by `/ralph-works continue-boundary <boundary-id>`.
6. When a reusable unresolved boundary exists, the tool must not advance state, rerun gates, or append a duplicate boundary. It must requeue or report the same continuation command.
7. A successful new tool transition must advance RalphWorks to the next legal workflow state using existing phase transition rules, except where protected phase rules in this spec override generic advancement.
8. A successful new tool transition must persist the advanced state before the next session launch is attempted.
9. A successful new tool transition must append exactly one pending `sessionBoundaryEvents` entry for the unresolved boundary.
10. A successful new tool transition must enqueue `/ralph-works continue-boundary <boundary-id>` via `pi.sendUserMessage(..., { deliverAs: "followUp" })` when follow-up messages are available.
11. If `pi.sendUserMessage` is unavailable or fails, RalphWorks must keep the pending/retryable boundary, persist a durable recovery indication, and notify the user with the exact manual `continue-boundary` command instead of falling back to compaction in the tool call.
12. The queued or manual `continue-boundary` command must perform the actual fresh-session launch from command context.
13. A manually invoked `continue-boundary` after state restoration must launch the same persisted boundary.
14. Compaction fallback must remain allowed only inside the later boundary launcher path when command-context fresh-session creation is unavailable or fails before replacement.
15. The tool must preserve the existing `renderHtml` parameter behavior for transitions where it already applies.
16. Calling the tool from `harden_spec` must pause for harden approval rather than advancing to `render_html_optional` or `create_tasks`.
17. The harden approval pause must preserve the existing user-facing approval message during the tool call and in the replacement approval-pause session.
18. The harden approval pause must not send a next-phase kickoff prompt before `/ralph-works approve` or `/ralph-works approve --render-html`.
19. Calling the tool from `review` must not advance to `complete`, create a completion boundary, or mark the pipeline complete without LGTM through the existing review completion path.
20. Review changes requested must continue to loop back to `tdd_implement` through the existing review loopback path.
21. Required gates from `gate.config.json` must still block TDD task completion and advancement from `tdd_implement` to review when they fail.
22. Required gate failures must not create a new session boundary in either tool or command paths.
23. The fix must not change assistant-marker handoff behavior for `RALPH_PHASE_COMPLETE`, `RALPH_TDD_TASK_COMPLETE <task-id>`, review loopback, or LGTM completion.
24. The fix must not change normal slash-command immediate launch behavior, especially `/ralph-works next` and `/ralph-works approve`.
25. RalphWorks must not enqueue Pi's `/new` command as text; it must continue to use `/ralph-works continue-boundary <boundary-id>` so the extension can seed state, model metadata, TUI state, and the next phase prompt correctly.
26. The tool result may simply return the updated or current RalphWorks state on successful queueing. If automatic queueing is unavailable and no UI notification channel exists, the tool result should include enough recovery detail for the caller to surface the manual continuation command.

## 6. Inputs, Outputs, And Interfaces

Inputs:

- Tool call: `ralph_works_transition` with optional `{ "renderHtml": true | false }`.
- Current persisted RalphWorks state restored from Pi custom state entries.
- `gate.config.json` when the current phase requires gates before advancement.
- `model.config.json` indirectly through the later `continue-boundary` session launch.
- Existing `sessionBoundaryEvents` used to detect unresolved pending or retryable boundaries.
- Review completion signals handled by existing review-specific logic, not by generic tool advancement.

Outputs:

- Updated persisted RalphWorks state for new legal transitions, or the unchanged current state when an unresolved boundary is reused or review advancement is blocked.
- A single pending or retryable session boundary event with boundary type, reason, source phase, target phase, and status metadata.
- A follow-up user message containing `/ralph-works continue-boundary <boundary-id>` when `pi.sendUserMessage` is available.
- A TUI update reflecting the new state or the current reused-boundary state.
- If follow-up queueing is unavailable, a durable retryable boundary status and a user notification containing the manual continuation command.

Interfaces:

- `ralph_works_transition` remains the model-facing tool interface.
- `/ralph-works continue-boundary <boundary-id>` remains the command-context boundary launcher interface.
- `/ralph-works next` remains the user-facing command-context transition interface.
- Existing review LGTM and review loopback interfaces remain authoritative for completion or return to TDD implementation.
- The implementation may use any internal design that satisfies the behavior, but it should stay near existing harness and state modules.

## 7. Data, State, And Artifacts

The hardened specification artifact for this phase is `docs/new-session-hotfix-hardened-spec.md`.

No new runtime artifact file is required for this hotfix. RalphWorks should continue using existing state and artifact mechanisms:

- Persist RalphWorks state through the existing Pi custom state entry mechanism.
- Track unresolved handoffs in `sessionBoundaryEvents`.
- Use existing boundary IDs and statuses rather than introducing a second queue format.
- Use a retryable persisted state, such as existing retryable statuses, when follow-up queueing fails.
- Keep phase artifacts under `docs/` with the feature-prefixed filenames already produced by RalphWorks, such as `docs/<feature>-generated-spec.md`, `docs/<feature>-red-team-findings.md`, `docs/<feature>-hardened-spec.md`, `docs/<feature>-task-list.md`, `docs/<feature>-implementation-status.json`, and `docs/<feature>-review-findings.md`.

State persisted for the handoff must be sufficient for `continue-boundary` to validate the boundary ID, build the session boundary plan, route the model, update the TUI, and send the correct next prompt or approval-pause behavior without relying on the old tool context.

Unresolved boundary reuse must be deterministic. The implementation should prefer the latest launchable/retryable boundary for the current phase target and ignore stale unresolved events whose target phase no longer matches `state.currentPhase`.

## 8. Non-Functional Requirements

- Reliability: tool transitions must not cause avoidable compaction fallback merely because tool context lacks `ctx.newSession(...)`.
- Idempotency: repeated tool calls while a pending boundary is unresolved must not create duplicate pending boundaries, advance through multiple phases, or rerun gates.
- Safety: tool calls must not bypass harden approval, required gates, review LGTM, or review loopback rules.
- Maintainability: changes should be small and localized to existing harness/state boundary handling where practical.
- Compatibility: existing persisted pipelines and older session boundary events must remain readable.
- Testability: behavior must be covered by focused unit or adapter tests using fake Pi contexts for both tool and command execution.
- Usability: when automatic follow-up queueing is unavailable, the user must receive a clear manual recovery command with the persisted boundary ID.
- Performance: the tool call should do only state restoration, duplicate-boundary detection, transition validation, gate checks when required, state persistence, TUI update, and follow-up queueing; fresh-session creation belongs to the command boundary.

## 9. Security, Privacy, And Abuse Considerations

This hotfix should not add new sensitive data handling. It must preserve existing RalphWorks trust boundaries:

- Do not copy full chat transcripts into state, notifications, follow-up messages, or artifacts.
- Do not let model tool calls bypass gate checks, harden approval, review requirements, or boundary validation.
- Do not let model tool calls complete review without LGTM through the existing review-specific completion path.
- Do not enqueue arbitrary user-provided slash commands; only enqueue the structured RalphWorks continuation command for a known persisted boundary ID.
- `continue-boundary` must continue validating that the supplied boundary ID exists and is pending or retryable before launching.
- If follow-up queueing is unavailable, the manual command notification should include only the boundary ID and necessary instructions, not secrets or long state dumps.

## 10. Edge Cases And Failure Modes

- No active pipeline: the tool returns the existing "pipeline not started" result and does not create a boundary.
- Existing pending/retryable boundary for the current phase target: the tool does not advance again, does not rerun gates, does not create a duplicate boundary, and reuses or reports the existing continuation command.
- Stale pending/retryable boundary whose target phase no longer matches `state.currentPhase`: the tool ignores it for duplicate prevention and relies on existing stale-boundary handling if the stale ID is later continued.
- `pi.sendUserMessage` unavailable or failing: the tool persists the boundary first, marks durable retryable recovery state, updates visible state, notifies the manual command when possible, and does not compact.
- Manual continuation after restoration: `/ralph-works continue-boundary <boundary-id>` validates the persisted retryable boundary and launches it from command context.
- `harden_spec` already awaiting approval: the tool keeps the approval-pause state, preserves the current approval notification behavior, and does not append duplicate approval boundaries.
- Harden approval boundary continued: the replacement session shows approval instructions and sends no phase kickoff prompt.
- `review` without LGTM: the tool does not advance to `complete`, does not create a completion boundary, and leaves review completion to existing LGTM/approval handling.
- Required gate failure: advancement remains blocked and no boundary is created in tool or command paths.
- `continue-boundary` run with stale or already handled ID: existing stale-boundary handling remains in effect and no duplicate prompt is sent.
- Command-context `ctx.newSession(...)` unavailable or failing before replacement: existing boundary-launcher compaction fallback may be used there, not in the tool call.
- `renderHtml` requested from the tool: existing transition semantics are preserved, and harden-spec approval is not bypassed.
- TUI unavailable: state persistence and follow-up queueing should still proceed where existing harness behavior permits; recovery instructions should be present in the tool result if no UI notification channel can display them.

## 11. RalphWorks Workflow Impact

The hotfix affects RalphWorks orchestration only. It does not change the substantive responsibilities of generate-spec, red-team, harden-spec, render-html, create-tasks, TDD implementation, or review skills.

Phase transitions:

- Model/tool phase advancement moves to a persisted pending-boundary handoff.
- User slash-command phase advancement remains immediate from command context.
- Assistant-marker phase advancement remains on the existing handoff path.
- Harden-spec completion and tool advancement still pause with `phaseStatus: "awaiting_harden_approval"` until explicit approval.
- Review still completes only on LGTM or the existing review approval behavior; generic tool advancement cannot complete review.
- Review change requests still loop back to `tdd_implement`.

Gates:

- `gate.config.json` remains authoritative for required gates.
- The hotfix must not create a boundary when required gates fail.
- Duplicate-boundary reuse must happen before gates so repeated tool calls do not rerun gates unnecessarily.

Models:

- `model.config.json` remains authoritative for phase model routing.
- Model routing for the next phase occurs during the later boundary launch, as it does for other handoff paths.

TUI:

- The TUI should reflect the persisted current phase or approval-pause status after the tool call.
- The TUI should not imply that a fresh session was already created during the tool call.
- If manual continuation is required, a notification should make the exact command visible.
- The replacement approval-pause session should make the harden approval instruction visible without sending a next-phase kickoff prompt.

Controller boundary:

- The extension coordinates state, boundaries, TUI, gates, models, and prompts.
- The agent phases continue to perform the substantive spec, review, hardening, implementation, and final review work.

## 12. Acceptance Criteria

- Calling `ralph_works_transition` from a non-command tool context advances the state to the next legal phase, persists that state, appends one pending boundary, and queues `/ralph-works continue-boundary <boundary-id>` with `deliverAs: "followUp"`.
- The same tool call does not call `ctx.newSession(...)` and does not call `ctx.compact(...)`.
- Running the queued `continue-boundary` command from a command-capable context calls `ctx.newSession(...)`, does not use compaction on the normal path, and sends the correct next phase prompt from the replacement-session context.
- `/ralph-works next` still launches the boundary immediately when run as a slash command with command-context fresh-session support.
- Assistant `RALPH_PHASE_COMPLETE` still persists state and enqueues/continues a boundary as it did before this hotfix.
- Calling `ralph_works_transition` from `harden_spec` sets `phaseStatus` to `awaiting_harden_approval`, persists one pending boundary, queues or reports the continuation command, shows the existing approval message during the tool call, and does not launch the next phase prompt.
- Continuing the harden-spec pending boundary produces the approval-pause session behavior, shows approval instructions in the replacement session, sends no phase kickoff prompt, and still waits for `/ralph-works approve` or `/ralph-works approve --render-html`.
- If `pi.sendUserMessage` is unavailable or fails during tool handoff, RalphWorks leaves a persisted pending/retryable boundary, records durable recovery state, notifies the user to run `/ralph-works continue-boundary <boundary-id>` manually, and does not compact.
- A manually invoked `continue-boundary` after state restoration launches the same boundary created by the tool handoff.
- Repeating `ralph_works_transition` while an unresolved boundary targets the current persisted phase does not advance another phase, does not rerun gates, and does not append a duplicate pending boundary.
- Repeating `ralph_works_transition` with follow-up support requeues the same boundary ID or otherwise reports the same continuation command.
- Calling `ralph_works_transition` during `review` without LGTM does not advance to `complete`, does not mark the pipeline complete, and does not create a completion boundary.
- Review loopback from critical findings or `RALPH_REVIEW_CHANGES_REQUESTED` remains unchanged and returns to `tdd_implement`.
- Required gate failures still block TDD task completion and review advancement without creating a boundary in both tool and command paths.
- Existing stale or already handled `continue-boundary` behavior remains idempotent and does not send duplicate kickoff prompts.
- `npm test` and `npm run check` pass.

## 13. Test Coverage Requirements

Automated coverage should include focused tests for:

- Normal `ralph_works_transition` tool handoff from a non-command context: state advances, one pending boundary is persisted, a follow-up `continue-boundary` command is queued, and no compaction or direct new session occurs.
- Command continuation of that boundary: command context calls `ctx.newSession(...)` and sends the correct next phase prompt.
- Existing `/ralph-works next` command behavior: immediate command-context launch remains unchanged.
- Assistant-marker regression: `RALPH_PHASE_COMPLETE` continues to use its existing handoff behavior.
- Harden-spec tool pause: `phaseStatus` becomes `awaiting_harden_approval`, the approval message is shown, and no next-phase prompt is sent.
- Harden-spec continued boundary: replacement session shows approval instructions and no kickoff prompt.
- Missing or failing `pi.sendUserMessage`: persisted retryable boundary, manual-command notification, and no compaction from the tool call.
- Manual continuation after restoration for a boundary created when follow-up queueing was unavailable.
- Duplicate pending-boundary prevention: repeated tool call reuses the same boundary before gates or state mutation.
- Review-phase safety: tool calls cannot complete review without LGTM.
- Gate failure regressions: required gate failures block and create no boundary in both tool and command paths.
- Stale/already-handled boundary idempotency for `continue-boundary`.

## 14. Assumptions And Open Questions

Assumptions accepted during the interview:

- The prompt document is a guide for expected behavior; implementation may use a different internal design if tests prove the same behavior.
- The hotfix is intentionally scoped to `ralph_works_transition` tool handoff behavior, including the harden-spec pause path, with no broader fresh-session architecture redesign.
- The tool does not need an extra success notification; returning the updated state is enough on the normal successful queueing path.
- `pi.sendUserMessage` is needed only to hand off from tool context into command context, not to create the new session itself.
- If follow-up queueing is unavailable, RalphWorks should notify the user to run the `continue-boundary` command manually.
- Compaction fallback remains allowed only inside the later `continue-boundary` command path.
- Existing slash-command behavior must be preserved.
- The tests named in the source prompt are a guide, not the complete expected test plan.
- Duplicate pending boundaries should be prevented.

Open questions: none that block task creation.
