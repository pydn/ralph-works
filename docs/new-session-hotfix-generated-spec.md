# new-session-hotfix Generated Spec

## 1. Purpose And User Value

The feature fixes the RalphWorks `ralph_works_transition` tool so model-initiated workflow transitions use the same fresh-session handoff pattern as assistant-marker transitions. Today, the tool can advance RalphWorks state, but it launches the next session boundary directly from tool execution context. Pi tool context does not expose command-only session controls such as `ctx.newSession(...)`, so RalphWorks records a compaction fallback even though no fresh-session attempt was possible.

The user value is that a model can safely call `ralph_works_transition` without causing avoidable fallback compaction. A successful fix advances the workflow, persists a pending boundary, queues `/ralph-works continue-boundary <boundary-id>` for command-context execution, and lets the queued command create the fresh session.

## 2. Intended Users And Context

Intended users and readers are:

- RalphWorks users who rely on model/tool-driven phase transitions.
- The Pi agent model, which may call `ralph_works_transition` at phase completion.
- RalphWorks maintainers implementing and reviewing the hotfix.
- Later RalphWorks phases that depend on accurate persisted state and boundary metadata.

Repository context:

- The source prompt is `docs/ralph-works-transition-fresh-session-fix.md`.
- The current generated spec artifact is `docs/new-session-hotfix-generated-spec.md`.
- Pi exposes `ctx.newSession(...)` only from command-capable contexts, not from tools or general event handlers.
- RalphWorks already has a command-context handoff pattern for assistant-marker events: persist the new state, append a pending session boundary event, enqueue `/ralph-works continue-boundary <boundary-id>` as a follow-up user message, then let the command handler launch the fresh session.
- Existing slash commands such as `/ralph-works next` already run in command context and should keep launching boundaries immediately.

## 3. Scope

In scope:

- Change `ralph_works_transition` so it uses a command-context handoff instead of launching the session boundary directly from tool context.
- Ensure the tool advances to the next legal workflow state, persists that state, and records a pending session boundary before queuing the handoff command.
- Apply the same handoff behavior when the tool is called from `harden_spec` and must pause for explicit harden approval.
- Prevent duplicate pending boundaries when `ralph_works_transition` is called again before the previously queued boundary has been continued.
- Preserve required gate checks, phase transition legality, artifact tracking, model routing, TUI updates, and existing command behavior.
- Add or update focused automated tests for the normal tool handoff, command continuation, harden-spec pause handoff, unavailable follow-up queueing, duplicate pending-boundary prevention, and regression behavior.

Out of scope:

- Redesigning RalphWorks fresh-session architecture beyond this hotfix.
- Changing Pi's tool, command, or session-control APIs.
- Enqueuing Pi's `/new` command as text.
- Adding a user-facing session strategy option.
- Changing RalphWorks phase definitions, skill responsibilities, gate semantics, review semantics, or artifact naming conventions.
- Changing slash-command behavior for `/ralph-works next`, `/ralph-works approve`, `/ralph-works start`, or assistant-marker handoff paths except where tests need to assert they remain unchanged.

## 4. User Workflows

Main model-tool workflow:

1. A RalphWorks pipeline is active and the model calls `ralph_works_transition`.
2. RalphWorks validates that the transition is legal and runs any required gates for the current phase.
3. RalphWorks computes the next workflow state using the existing transition rules.
4. RalphWorks persists the advanced state and appends one pending session boundary event.
5. RalphWorks attempts to enqueue `/ralph-works continue-boundary <boundary-id>` with `deliverAs: "followUp"`.
6. The tool returns the updated state. No extra user-facing tool notification is required on the successful queueing path.
7. The queued `continue-boundary` command later runs in command context and performs the actual fresh-session launch.

Unavailable follow-up queue workflow:

1. The model calls `ralph_works_transition` and the transition is otherwise valid.
2. RalphWorks persists the advanced state and pending boundary.
3. If `pi.sendUserMessage` is unavailable, RalphWorks does not trigger compaction from the tool call.
4. RalphWorks notifies the user with the exact manual command to run: `/ralph-works continue-boundary <boundary-id>`.
5. The pending boundary remains resumable.

Duplicate pending-boundary workflow:

1. `ralph_works_transition` is called while a pending or retryable boundary from a previous handoff has not been continued.
2. RalphWorks does not advance to another phase and does not append another pending boundary for the same unresolved handoff.
3. If follow-up messages are available, RalphWorks may requeue the same `continue-boundary` command; otherwise it notifies the user with the same manual command.
4. The tool returns the current persisted state.

Harden-spec tool workflow:

1. `ralph_works_transition` is called while `currentPhase` is `harden_spec` and the phase is not already awaiting approval.
2. RalphWorks changes only `phaseStatus` to `awaiting_harden_approval`, persists that state, and appends one pending phase boundary from `harden_spec` to `harden_spec`.
3. RalphWorks shows the same harden-approval message it shows today: approval must be done with `/ralph-works approve` or `/ralph-works approve --render-html`.
4. The queued `continue-boundary` command launches the approval-pause session behavior and does not start the next phase prompt.

Slash-command workflow:

1. A user runs `/ralph-works next` or another command-context transition command.
2. Existing behavior is preserved: command handlers may launch the session boundary immediately because command context can provide `ctx.newSession(...)`.

## 5. Functional Requirements

1. `ralph_works_transition` must not call the session-boundary launcher directly from tool execution context.
2. `ralph_works_transition` must not call `ctx.newSession(...)` directly.
3. `ralph_works_transition` must not trigger `ctx.compact(...)` during the tool call when a command-context handoff can be recorded.
4. A successful tool transition must advance RalphWorks to the next legal workflow state using existing phase transition rules.
5. A successful tool transition must persist the advanced state before the next session launch is attempted.
6. A successful tool transition must append exactly one pending `sessionBoundaryEvents` entry for the unresolved boundary.
7. A successful tool transition must enqueue `/ralph-works continue-boundary <boundary-id>` via `pi.sendUserMessage(..., { deliverAs: "followUp" })` when follow-up messages are available.
8. If `pi.sendUserMessage` is unavailable, RalphWorks must keep the pending boundary and notify the user with the exact manual `continue-boundary` command instead of falling back to compaction in the tool call.
9. The queued `continue-boundary` command must perform the actual fresh-session launch from command context.
10. Compaction fallback must remain allowed only inside the later boundary launcher path when command-context fresh-session creation is unavailable or fails before replacement.
11. The tool must preserve the existing `renderHtml` parameter behavior for transitions where it already applies.
12. Calling the tool from `harden_spec` must pause for harden approval rather than advancing to `render_html_optional` or `create_tasks`.
13. The harden approval pause must preserve the existing user-facing approval message and must wait for `/ralph-works approve` or `/ralph-works approve --render-html`.
14. The tool must detect an existing unresolved pending or retryable boundary before advancing again, and must not create duplicate pending boundaries or skip ahead to another phase.
15. When an unresolved boundary already exists, RalphWorks should requeue the existing `continue-boundary` command when possible, or notify the user to run it manually when follow-up messages are unavailable.
16. Required gates from `gate.config.json` must still block TDD task completion and advancement from `tdd_implement` to review when they fail.
17. The fix must not change assistant-marker handoff behavior for `RALPH_PHASE_COMPLETE`, `RALPH_TDD_TASK_COMPLETE <task-id>`, review loopback, or LGTM completion.
18. The fix must not change normal slash-command immediate launch behavior, especially `/ralph-works next` and `/ralph-works approve`.
19. RalphWorks must not enqueue Pi's `/new` command as text; it must continue to use `/ralph-works continue-boundary <boundary-id>` so the extension can seed state, model metadata, TUI state, and the next phase prompt correctly.
20. The tool result may simply return the updated RalphWorks state; no additional success message is required.

## 6. Inputs, Outputs, And Interfaces

Inputs:

- Tool call: `ralph_works_transition` with optional `{ "renderHtml": true | false }`.
- Current persisted RalphWorks state restored from Pi custom state entries.
- `gate.config.json` when the current phase requires gates before advancement.
- `model.config.json` indirectly through the later `continue-boundary` session launch.
- Existing session boundary events used to detect unresolved pending boundaries.

Outputs:

- Updated persisted RalphWorks state.
- A pending session boundary event with boundary type, reason, source phase, target phase, and status metadata.
- A follow-up user message containing `/ralph-works continue-boundary <boundary-id>` when `pi.sendUserMessage` is available.
- A TUI update reflecting the new state.
- If follow-up queueing is unavailable, a user notification containing the manual continuation command.

Interfaces:

- `ralph_works_transition` remains the model-facing tool interface.
- `/ralph-works continue-boundary <boundary-id>` remains the command-context boundary launcher interface.
- `/ralph-works next` remains the user-facing command-context transition interface.
- The implementation may use any internal design that satisfies the behavior, but it should stay near existing harness and state modules.

## 7. Data, State, And Artifacts

The generated specification artifact for this phase is `docs/new-session-hotfix-generated-spec.md`.

No new runtime artifact file is required for this hotfix. RalphWorks should continue using existing state and artifact mechanisms:

- Persist RalphWorks state through the existing Pi custom state entry mechanism.
- Track unresolved handoffs in `sessionBoundaryEvents`.
- Use existing boundary IDs and statuses rather than introducing a second queue format.
- Keep phase artifacts under `docs/` with the feature-prefixed filenames already produced by RalphWorks, such as `docs/<feature>-generated-spec.md`, `docs/<feature>-red-team-findings.md`, `docs/<feature>-hardened-spec.md`, `docs/<feature>-task-list.md`, `docs/<feature>-implementation-status.json`, and `docs/<feature>-review-findings.md`.

State persisted for the handoff must be sufficient for `continue-boundary` to validate the boundary ID, build the session boundary plan, route the model, update the TUI, and send the correct next prompt or approval-pause behavior without relying on the old tool context.

## 8. Non-Functional Requirements

- Reliability: tool transitions must not cause avoidable compaction fallback merely because tool context lacks `ctx.newSession(...)`.
- Idempotency: repeated tool calls while a pending boundary is unresolved must not create duplicate pending boundaries or advance through multiple phases.
- Maintainability: changes should be small and localized to existing harness/state boundary handling where practical.
- Compatibility: existing persisted pipelines and older session boundary events must remain readable.
- Testability: behavior must be covered by focused unit or adapter tests using fake Pi contexts for both tool and command execution.
- Usability: when automatic follow-up queueing is unavailable, the user must receive a clear manual recovery command.
- Performance: the tool call should do only state transition, persistence, gate checks when required, TUI update, and follow-up queueing; fresh-session creation belongs to the command boundary.

## 9. Security, Privacy, And Abuse Considerations

This hotfix should not add new sensitive data handling. It must preserve existing RalphWorks trust boundaries:

- Do not copy full chat transcripts into state, notifications, follow-up messages, or artifacts.
- Do not let model tool calls bypass gate checks, harden approval, review requirements, or boundary validation.
- Do not enqueue arbitrary user-provided slash commands; only enqueue the structured RalphWorks continuation command for a known persisted boundary ID.
- `continue-boundary` must continue validating that the supplied boundary ID exists and is pending or retryable before launching.
- If follow-up queueing is unavailable, the manual command notification should include only the boundary ID and necessary instructions, not secrets or long state dumps.

## 10. Edge Cases And Failure Modes

- No active pipeline: the tool returns the existing "pipeline not started" result and does not create a boundary.
- Existing pending boundary: the tool does not advance again, does not create a duplicate boundary, and reuses or reports the existing continuation command.
- `pi.sendUserMessage` unavailable: the tool persists the pending boundary, updates visible state, notifies the manual command, and does not compact.
- `harden_spec` already awaiting approval: the tool keeps the approval-pause state, preserves the current approval notification behavior, and does not append duplicate approval boundaries.
- Required gate failure: advancement remains blocked and no boundary is created.
- `continue-boundary` run with stale or already handled ID: existing stale-boundary handling remains in effect and no duplicate prompt is sent.
- Command-context `ctx.newSession(...)` unavailable or failing before replacement: existing boundary-launcher compaction fallback may be used there, not in the tool call.
- `renderHtml` requested from the tool: existing transition semantics are preserved, and harden-spec approval is not bypassed.
- TUI unavailable: state persistence and follow-up queueing should still proceed where existing harness behavior permits.

## 11. RalphWorks Workflow Impact

The hotfix affects RalphWorks orchestration only. It does not change the substantive responsibilities of generate-spec, red-team, harden-spec, render-html, create-tasks, TDD implementation, or review skills.

Phase transitions:

- Model/tool phase advancement moves to a persisted pending-boundary handoff.
- User slash-command phase advancement remains immediate from command context.
- Assistant-marker phase advancement remains on the existing handoff path.
- Harden-spec completion and tool advancement still pause with `phaseStatus: "awaiting_harden_approval"` until explicit approval.

Gates:

- `gate.config.json` remains authoritative for required gates.
- The hotfix must not create a boundary when required gates fail.

Models:

- `model.config.json` remains authoritative for phase model routing.
- Model routing for the next phase occurs during the later boundary launch, as it does for other handoff paths.

TUI:

- The TUI should reflect the persisted current phase or approval-pause status after the tool call.
- The TUI should not imply that a fresh session was already created during the tool call.
- If manual continuation is required, a notification should make the exact command visible.

Controller boundary:

- The extension coordinates state, boundaries, TUI, gates, models, and prompts.
- The agent phases continue to perform the substantive spec, review, hardening, implementation, and final review work.

## 12. Acceptance Criteria

- Calling `ralph_works_transition` from a non-command tool context advances the state to the next legal phase, persists that state, appends a pending boundary, and queues `/ralph-works continue-boundary <boundary-id>` with `deliverAs: "followUp"`.
- The same tool call does not call `ctx.newSession(...)` and does not call `ctx.compact(...)`.
- Running the queued `continue-boundary` command from a command-capable context calls `ctx.newSession(...)`, does not use compaction on the normal path, and sends the correct next phase prompt from the replacement-session context.
- `/ralph-works next` still launches the boundary immediately when run as a slash command with command-context fresh-session support.
- Calling `ralph_works_transition` from `harden_spec` sets `phaseStatus` to `awaiting_harden_approval`, persists a pending boundary, queues or reports the continuation command, shows the existing approval message, and does not launch the next phase prompt.
- Continuing the harden-spec pending boundary produces the approval-pause session behavior and still waits for `/ralph-works approve` or `/ralph-works approve --render-html`.
- If `pi.sendUserMessage` is unavailable during tool handoff, RalphWorks leaves a pending boundary, notifies the user to run `/ralph-works continue-boundary <boundary-id>` manually, and does not compact.
- Repeating `ralph_works_transition` while an unresolved pending boundary exists does not advance another phase and does not append a duplicate pending boundary.
- Required gate failures still block TDD task completion and review advancement without creating a boundary.
- Assistant-marker handoff behavior is unchanged.
- Existing stale or already handled `continue-boundary` behavior remains idempotent and does not send duplicate kickoff prompts.
- `npm test` and `npm run check` pass.

## 13. Assumptions And Open Questions

Assumptions accepted during the interview:

- The prompt document is a guide for expected behavior; implementation may use a different internal design if tests prove the same behavior.
- The hotfix is intentionally scoped to `ralph_works_transition` tool handoff behavior, including the harden-spec pause path, with no broader fresh-session architecture redesign.
- The tool does not need an extra success notification; returning the updated state is enough.
- `pi.sendUserMessage` is needed only to hand off from tool context into command context, not to create the new session itself.
- If follow-up queueing is unavailable, RalphWorks should notify the user to run the `continue-boundary` command manually.
- Compaction fallback remains allowed only inside the later `continue-boundary` command path.
- Existing slash-command behavior must be preserved.
- The tests named in the prompt are a guide, not the complete expected test plan.
- Duplicate pending boundaries should be prevented.

Open questions: none that block task creation.
