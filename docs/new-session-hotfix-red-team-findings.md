# new-session-hotfix Red-Team Findings

## Critical Findings

### 1. Tool transitions can still bypass review completion rules unless the spec explicitly blocks review-phase advancement

**Risk:** The spec says the hotfix must not let model tool calls bypass review requirements, but it does not make review-phase `ralph_works_transition` behavior explicit. RalphWorks workflow invariants require review to complete only on LGTM, and review changes must loop back to `tdd_implement`. If the implementation simply routes the tool through the existing generic phase advancement with handoff mode, a model could call `ralph_works_transition` during `review` and advance directly to `complete` without an LGTM decision.

**Why it matters:** This would create a correctness and safety regression at the final quality gate. It also conflicts with the repository invariant that `RALPH_PHASE_COMPLETE` is ignored during review unless there is LGTM-specific approval.

**Recommended spec change:** Add a functional requirement and acceptance criteria stating that `ralph_works_transition` must not advance from `review` to `complete`. During review, completion must still require LGTM or the existing `/ralph-works approve` review approval path, and change requests must still use the review loopback path. Add tests proving a tool call in `review` does not create a completion boundary or mark the pipeline complete without LGTM.

## Material Warnings

### 2. Duplicate pending-boundary prevention needs stricter ordering and matching rules

**Risk:** The spec requires preventing duplicate pending boundaries, but it does not define when the duplicate check must run or how to choose the boundary to reuse. If the implementation checks for duplicates after gate execution or after `advancePhase`, a repeated tool call could rerun required gates, skip ahead to the next phase, or append another boundary. If it treats any old retryable boundary as globally blocking, it could also block legitimate later workflow progress due to stale state.

**Why it matters:** Idempotency is central to this hotfix. A model may call the tool again before the queued follow-up command runs. The implementation needs deterministic behavior that reuses the unresolved handoff without mutating phase state or causing side effects.

**Recommended spec change:** Specify that `ralph_works_transition` must check for an unresolved pending/retryable boundary before running gates, computing a new transition, or changing state. Define the matching rule, such as reusing the latest pending/retryable boundary whose target/current phase matches the already-persisted state and whose status is still launchable. Require that repeated tool calls requeue or report that same boundary ID without appending a new event, rerunning gates, or changing phases.

### 3. The harden-approval pause behavior is underspecified across tool call and continued boundary contexts

**Risk:** The spec says the harden-spec tool workflow should show the same approval message it shows today and that the queued boundary should launch approval-pause session behavior, but it does not say whether the message must appear during the tool call, during the replacement session, or both. It also does not clearly state that no agent kickoff prompt may be sent from either context.

**Why it matters:** Harden approval is a required human pause. Ambiguity here could produce duplicate notifications, no visible approval instruction in the replacement session, or an accidental next-phase prompt before approval.

**Recommended spec change:** State explicitly that the tool call must preserve the current harden approval notification when it changes `phaseStatus` to `awaiting_harden_approval`, and that `continue-boundary` for this boundary must create the approval-pause session with visible approval instructions but no phase kickoff prompt. Add tests for both the tool-call notification and the replacement-session no-kickoff behavior.

### 4. Manual continuation when `sendUserMessage` is unavailable should be tied to durable recovery behavior

**Risk:** The spec requires notifying the user to run `/ralph-works continue-boundary <boundary-id>` manually if follow-up queueing is unavailable, but it does not require a durable indication that enqueueing failed or prove that a later manual command works after restoration.

**Why it matters:** This is the recovery path for environments without follow-up message support. If the pending boundary is not persisted before the notification, or if restoration loses the boundary, the user could be given a command that cannot resume the workflow.

**Recommended spec change:** Add requirements that state persistence and boundary append happen before the manual notification, the notification includes the exact persisted boundary ID, and a manually invoked `continue-boundary` after state restoration launches the same boundary. Test this with a fake Pi object lacking `sendUserMessage`.

### 5. Regression coverage should include unchanged command and assistant-marker paths, not only the new tool path

**Risk:** The spec says slash-command and assistant-marker behavior must be preserved, but the acceptance criteria do not require focused regression tests that prove the handoff-mode changes did not accidentally alter those paths.

**Why it matters:** The proposed change likely touches shared helpers such as phase advancement and harden approval pause. A small signature change could unintentionally make `/ralph-works next` enqueue instead of launch immediately, or change assistant-marker handoff behavior.

**Recommended spec change:** Add test requirements confirming that `/ralph-works next` still launches immediately from command context, assistant `RALPH_PHASE_COMPLETE` still persists and enqueues a boundary as before, and required gate failures still block without creating a boundary in both command and tool paths.
