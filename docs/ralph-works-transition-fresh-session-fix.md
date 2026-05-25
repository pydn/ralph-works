# RalphWorks Tool Transition Fresh-Session Fix

## Problem

The `ralph_works_transition` tool can advance the workflow, but it currently launches the next phase boundary directly from the tool execution context. Pi tool executions receive `ExtensionContext`, which includes `ctx.compact(...)` but does not include command-only session controls such as `ctx.newSession(...)`.

As a result, when the model calls `ralph_works_transition`, RalphWorks records the next boundary with:

- `freshSessionAttempted: false`
- `freshSessionCreated: false`
- `fallbackUsed: true`
- `status: "fallback_compaction"`

This is not a failed fresh-session attempt. It is the extension detecting that `ctx.newSession` is unavailable and using the intended fallback path.

## Root Cause

Pi exposes new-session creation through `ctx.newSession(...)`, but only on `ExtensionCommandContext`. This matches Pi's safety model: session replacement is only available from command handlers, not from tools or general event handlers.

RalphWorks already has the right command-context handoff path for assistant marker events:

1. Persist the advanced workflow state.
2. Append a pending `sessionBoundaryEvents` entry.
3. Enqueue `/ralph-works continue-boundary <boundary-id>` as a follow-up message.
4. Let the command handler run `continueBoundary(...)`.
5. Create the fresh session from the command context using `ctx.newSession(...)`.

The tool transition path should use the same handoff pattern.

## Required Behavior

When `ralph_works_transition` is called:

1. It must advance the RalphWorks state to the next legal phase.
2. It must persist a pending session boundary.
3. It must enqueue `/ralph-works continue-boundary <boundary-id>` with `deliverAs: "followUp"`.
4. It must not call `launchPiSessionBoundary(...)` directly from the tool context.
5. It must not trigger compaction during the tool call when a command handoff can be queued.
6. The queued `continue-boundary` command must perform the actual fresh-session launch.

## Implementation Plan

### 1. Add handoff support to phase advancement

Update `advanceToNextPhase(...)` in `src/harness/pi-harness-adapter.js` to accept an options object:

```js
async function advanceToNextPhase(
  ctx,
  commandArgs,
  reason,
  { handoff = false } = {},
) {
  // existing validation, harden pause handling, and gate checks
}
```

For normal phase advancement, branch between direct command launch and handoff launch:

```js
const fromPhase = state.currentPhase;
const nextState = advancePhase(state, {
  renderHtml: commandArgs.includes("--render-html"),
  reason,
});

const boundary = {
  boundaryType: "phase",
  reason: `entered ${nextState.currentPhase}`,
  fromPhase,
  toPhase: nextState.currentPhase,
};

return handoff
  ? persistAndEnqueueBoundary(ctx, nextState, boundary)
  : enterPhase(ctx, nextState, { reason: boundary.reason });
```

Preserve the existing behavior for user slash commands: `/ralph-works next` should still launch immediately because command handlers already receive `ExtensionCommandContext`.

### 2. Thread handoff through harden-spec pause

`advanceToNextPhase(...)` currently calls `pauseForHardenApproval(ctx)` when the current phase is `harden_spec`. That path can also create a boundary. Add handoff support there too:

```js
async function pauseForHardenApproval(ctx, { handoff = false } = {}) {
  // existing no-state and already-waiting checks

  const nextState = {
    ...state,
    phaseStatus: HARDEN_APPROVAL_STATUS,
  };

  const boundary = {
    boundaryType: "phase",
    reason: "hardened spec awaiting approval",
    fromPhase: "harden_spec",
    toPhase: "harden_spec",
  };

  return handoff
    ? persistAndEnqueueBoundary(ctx, nextState, boundary)
    : launchSessionBoundary(ctx, nextState, boundary);
}
```

Then call it as:

```js
if (state.currentPhase === "harden_spec") {
  return pauseForHardenApproval(ctx, { handoff });
}
```

### 3. Change `ralph_works_transition` to use handoff mode

Update the tool executor in `src/harness/pi-harness-adapter.js`:

```js
await advanceToNextPhase(
  ctx,
  params.renderHtml ? ["--render-html"] : [],
  "command:next",
  { handoff: true },
);
```

This keeps the tool useful for the model while ensuring the actual session replacement happens later in command context.

### 4. Do not call Pi's `/new` command as text

Do not enqueue `/new` directly. RalphWorks needs the structured setup hooks from `ctx.newSession({ setup, withSession })` so it can seed:

- persisted RalphWorks state
- session-boundary plan metadata
- bounded resume context
- model-change entries
- TUI state
- the next phase prompt from the replacement-session context

The correct user-facing follow-up command is still:

```text
/ralph-works continue-boundary <boundary-id>
```

## Tests To Update

### `tests/pi-harness-adapter.test.js`

Update the existing `ralph_works_transition tool stores state and uses compaction fallback without newSession` test. It should no longer expect compaction from the tool call.

Expected assertions:

- The tool result state is advanced to `red_team`.
- The latest persisted state has a pending phase boundary.
- `pi.sendUserMessage(...)` was called with `/ralph-works continue-boundary <boundary-id>`.
- No compaction is triggered by the tool call.

### `tests/pi-command-boundary-sessions.test.js`

Add or update coverage using a command-capable fake context:

1. Start a pipeline with fresh-session support.
2. Call the `ralph_works_transition` tool from a non-command context.
3. Assert no new session is created during the tool call.
4. Run the queued `/ralph-works continue-boundary <boundary-id>` command with command context.
5. Assert `ctx.newSession(...)` is called.
6. Assert `ctx.compact(...)` is not called.
7. Assert the replacement session receives the red-team kickoff prompt.

Also cover the harden-spec tool transition case:

1. Enter `harden_spec`.
2. Call `ralph_works_transition` from the tool context.
3. Assert the workflow enters `awaiting_harden_approval`.
4. Assert the pending boundary is queued, not launched directly from the tool.
5. Run `continue-boundary` from command context and verify the approval-pause session behavior.

## Acceptance Criteria

- `/ralph-works next` still creates a fresh session immediately when run as a slash command.
- Assistant marker handoff behavior is unchanged.
- `ralph_works_transition` no longer triggers fallback compaction just because tool context lacks `ctx.newSession`.
- `ralph_works_transition` queues `continue-boundary` and the queued command creates the fresh session.
- Required gate failures still block TDD task completion and review advancement without creating a boundary.
- The harden-spec approval pause still waits for `/ralph-works approve` or `/ralph-works approve --render-html`.
- `npm test` and `npm run check` pass.
