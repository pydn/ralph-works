# AGENTS.md — Pi Ralph Extension

This is a **TypeScript extension for [Pi](https://github.com/earendil-works/pi-coding-agent)** implementing a full dev-cycle pipeline (Ralph loop). All phases run as a single continuous agent workflow with no subprocess spawning.

## Priority Tracker

Always reference `/workspace/prompts/ralph-extension-priority-action-plan.md` before starting work. Treat that file as the source of truth for backlog order, active ownership, and completion state.

If you are taking a tracked item from that file:

- Mark it `[in progress]` in the same turn before making code changes so other agents know it is claimed.
- When the work is complete, mark the task complete in the action plan in the same turn and remove the `[in progress]` marker.
- If you stop before finishing, leave `[in progress]` in place and add a short note describing the handoff state or blocker.

Do not start a tracked item without checking whether another agent has already claimed it.

## Quick Start

```bash
/ralph start <feature>                    # Full pipeline
/ralph start <feature> spec,harden        # Selected phases only
/ralph status                             # Show current state
/ralph cancel                             # Abort pipeline
/ralph gate [paths...]                    # Standalone gate check (no pipeline)
```

## Architecture Overview

### Pipeline Phases (Sequential)

1. **Generate Spec** → Markdown engineering specification (`docs/specs/FEATURE.md`)
2. **Red Team Audit** → Adversarial security review with `[CRITICAL]`/`[WARNING]`/`[INFO]` tags
3. **Harden Spec** → Patch markdown spec in-place, write changelog, convert to HTML for readability
4. **TDD Implementation** → Red-Green-Refactor cycle with pre/post quality gates
5. **Ralph Review Loop** → Multi-pass PR review (Logic + Security + Style) with remediation

### Data Flow

```
/ralph start <feature> [prompt] [phases]
    │
    ▼
Command Handler → saveState() → Session JSONL (custom entries)
    │
    ▼ pi.sendUserMessage(pipelinePrompt)
LLM streams tokens ── message_update ──► Live Widget (real-time phase detection)
    │
    ▼ agent_end (turn complete)
Phase detect + advance → shortcut? → send steer message → all done? → mark complete
```

## Code Structure

### `index.ts` — Main Extension Entry Point

#### Key Components

| Component                    | Purpose                                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `PipelineState` interface    | `{ feature, workDir, phases[], maxIterations, startedAt, currentPhase?, currentPhaseIndex?, promptText? }` |
| `getState(ctx)`              | Walks full branch chain root-to-tip, returns **last** custom entry match (not first)                       |
| `saveState(pi, state)`       | `pi.appendEntry(CUSTOM_TYPE, state)` — appends to session JSONL                                            |
| `buildPipelinePrompt(state)` | Constructs master prompt with phase instructions, anti-shortcut rules, quality gates                       |
| `runLintGates(workDir)`      | Runs configured `.ralph/gate-config.json` commands; returns `GateResult[]`                                 |
| `detectCurrentPhase(ctx)`    | Regex on last 20 assistant messages to infer current phase from conversation text                          |
| `refreshWidget(ctx, state)`  | Updates TUI widget with phase progress (defensive defaults for empty phases)                               |

#### Extension API Hooks

| Hook                 | Fires When                    | Use For                                      |
| -------------------- | ----------------------------- | -------------------------------------------- |
| `session_start`      | New session or reload         | Restore state, widget refresh, auto-resume   |
| `message_start`      | LLM begins generating         | Reset streaming accumulators                 |
| `message_update`     | Each token batch arrives      | Live UI updates, phase detection             |
| `agent_end`          | LLM finishes its turn         | Phase advancement, anti-shortcut, gate check |
| `tool_result`        | After any tool call completes | Auto-gate on writes, side effects            |
| `before_agent_start` | Before system prompt is sent  | Skill injection, context augmentation        |
| `resources_discover` | Extension loads               | Register skills, templates                   |

**⚠️ Critical**: `session_start` fires AFTER the extension function runs. Put startup logic in `session_start`, not module scope.

#### Registered Tool: `ralph_gate_check`

- Runs configured gates from `.ralph/gate-config.json`; reports no configured gates when the file is absent
- Accepts optional `paths[]` parameter (defaults to entire project)
- Resets auto-gate counter on explicit check

#### Auto-Gating Mechanism

During implement/review phases, the extension tracks write operations:

- Counts only `write` and `edit` tool calls (not `bash`, `read`, etc.)
- Resets counter on any non-write tool call
- Triggers after 3 consecutive writes only when gates are explicitly configured

## Critical Development Rules

### Red-Green TDD Is Required

Always implement behavior changes using red-green TDD: add or update the regression test first, run the targeted test to confirm it fails for the expected reason, implement the smallest production change, then rerun the targeted test and relevant gates.

### 1. State Mutation — ALWAYS CREATE COPIES

```typescript
// WRONG — mutates shared reference
state.currentPhaseIndex = idx;
saveState(pi, state);

// CORRECT — shallow copy isolates mutation
const updated = { ...state, currentPhaseIndex: idx };
saveState(pi, updated);
```

`getState()` returns the same object reference from session entry. Repeated mutations on the same call chain can accumulate unexpected changes.

### 2. Context Compaction Survivability

Any field needed after compaction must be an explicit property on the state object. Never rely on inferring state from conversation text alone. If it's not in `saveState()`, it won't survive compaction.

**Fix**: Walk full branch chain root-to-tip in `getState()`, return the _last_ match:

```typescript
let latest = null;
for (const entry of ctx.sessionManager.getBranch()) {
  if (entry.customType === CUSTOM_TYPE && entry.data) {
    latest = entry.data;
  }
}
return latest;
```

### 3. Skill Injection Guard

`before_agent_start` skill injection runs on **every** agent turn, not just pipeline turns. Always guard with `if (!getState(ctx)) return;` — unconditional system prompt augmentation wastes context tokens on every turn.

### 4. Anti-Shortcut Detection

LLMs treat multi-phase prompts as a single task description, not a sequential execution plan. When the model believes it has "answered everything," it terminates — skipping remaining phases.

**Two-layer fix**:

- **`agent_end` anti-shortcut**: Detect `"Complete Summary"` + check unfinished phases → send steer message
- **`session_start` auto-resume**: If agent shortcut on previous turn and session reloaded, immediately inject user-role steering message listing remaining phases

### 5. Live TUI Widget Updates During Streaming

Widget only updating at `agent_end` means frozen UI during long phases (5+ min). Use `message_update` for real-time feedback — fires during token streaming with **cumulative** text (not incremental deltas). Compare `currentText.length > streamingText.length` to detect new tokens.

### 6. Defensive Defaults Everywhere

Never trust state at render time. State loaded from JSONL may have been serialized/deserialized through paths that drop optional fields. Every UI function should validate inputs against defensive defaults:

```typescript
const phases = st.phases && st.phases.length > 0 ? st.phases : ["spec", "redteam", "harden", "implement", "review"];
```

### 7. Command Parsing Ambiguity

`args.trim().split(/\s+/)` creates comma ambiguity. Current heuristic: if arg2 is entirely valid phase names, treat as phase list; otherwise treat as prompt text. Known limitation: prompts with commas (e.g., `"spec, implement"`) are misinterpreted as phase lists.

### 8. Worktree Isolation — NEVER EDIT THE PRIMARY CHECKOUT

Always do implementation work in a dedicated `git worktree`, never in the primary checkout directory. The main checkout is for coordination, review, and recovery only.

Required workflow:

1. Check `/workspace/prompts/ralph-extension-priority-action-plan.md` and claim the item with `[in progress]`.
2. Create or reuse a dedicated worktree for that item.
3. Do all code edits, tests, and commits inside the worktree path, not the primary repo directory.

Example commands:

```bash
git worktree add /tmp/ralph-works-<task> -b <branch-name> HEAD
git worktree list
git worktree remove /tmp/ralph-works-<task>
git worktree prune
```

Worktree rules:

- One active task per worktree.
- One branch per worktree.
- Do not have two agents editing the same file from different worktrees at the same time.
- Name the worktree and branch after the claimed action-plan item when possible.

## TypeScript-Specific Quality Gates

Use these TypeScript gates:

```bash
# Gate 1: Type checking
npx tsc --noEmit

# Gate 2: Linting (if configured)
npx eslint . --ext .ts,.tsx

# Gate 3: Test suite (if applicable)
npx jest  # or npx vitest run
```

### Why TypeScript Fails Differently Than Python

LLMs write more reliably in Python than TypeScript. The key differences that cause TS-specific failures:

| Factor                 | Python                    | TypeScript                                             | What breaks                                                |
| ---------------------- | ------------------------- | ------------------------------------------------------ | ---------------------------------------------------------- |
| Verbosity per function | ~2 lines (`def func(x):`) | ~6+ lines (signature, types, `{`, body, `}`)           | 3× more tokens means truncation hits sooner                |
| Type declarations      | Implicit                  | Explicit everywhere — interfaces, generics, unions     | Missing or mismatched types cascade into downstream errors |
| Structure balance      | Indentation-based         | Brace-heavy — every `{` needs `}`, every `(` needs `)` | One missed brace invalidates everything after it           |
| Error recovery         | Syntax error at line N    | Type error can reference unrelated imported module     | Harder to isolate which edit caused the failure            |

### TypeScript File Editing Rules

Follow these rules **every time** you modify `.ts` files:

1. **Surgical patches, never full rewrites** — For any file over 200 lines, edit one function or block at a time using find-and-replace patterns. Never output the entire file content in a single write operation.

2. **Verify brace balance after each edit** — After patching, count that opening/closing braces match (`{` = `}`, `(` = `)`, `[` = `]`). Even one mismatched pair will cause cascading parse errors across the rest of the file.

3. **Compile-check frequently** — Run `npx tsc --noEmit` after every 2-3 patches to catch type errors before they compound.

4. **For major structural refactors** — If you need to restructure multiple functions or change interfaces, write the new version to a temporary file first (`index.ts.new`), compile it with `npx tsc --noEmit`, verify it passes, then rename over the original. Never do structural changes in-place.

5. **Common TypeScript pitfalls to watch for**:
   - Always declare explicit return types on exported functions (`: Promise<void>`, `: string | null`)
   - Use strict null checks — prefer `??` and optional chaining `?.` everywhere state may be missing
   - When extending interfaces, use `extends` not re-declaration
   - Import ordering convention: `@earendil-works/*` → `typebox` → `node:*` builtins → relative paths
   - Never shadow built-in names (`err`, `event`) with different types in nested scopes
   - Arrow functions in hooks: verify the callback signature matches exactly what the API expects (wrong parameter count is a silent logic bug)

## Common Pitfalls

- **index.ts surgical edits only** — index.ts is 800+ lines with interdependent hooks. Never full-rewrite it. Use `patch` (find-and-replace) for targeted changes. Full rewrites cause cascading bugs across hook references. If you rewrite, verify ALL hooks still connect correctly
- **HTML spec docs: build in chunks** — Large HTML conversions (>20KB output) MUST use sequential file operations to avoid truncation. Do NOT attempt single-shot full document writes. Use this pattern:
  1. Write the shell/head/CSS first: `write_file(output_path, "<!DOCTYPE html>...<body>...")`
  2. Append each content section: `echo '...' >> output_path` or write numbered temp files then concatenate
  3. Close the document: append footer + scripts + `</body></html>`

  The `markdown-to-html/SKILL.md` skill (in `_global/`) defines a 7-chunk strategy with CSS design tokens, sidebar navigation, severity badges, and Mermaid rendering. If available, follow it exactly.

- **TypeScript compilation before testing** — always run `npx tsc --noEmit` before running extension tests. TypeScript errors mask runtime issues

## Common Patterns

### Persisting state across compaction

```typescript
pi.appendEntry("my-custom-type", { field1, field2 }); // append to session JSONL

// Read back (iterate full chain, return last):
let latest = null;
for (const e of ctx.sessionManager.getBranch()) {
  if (e.type === "custom" && e.customType === "my-custom-type" && e.data) {
    latest = e.data;
  }
}
return latest; // null if never saved
```

### Steering the LLM mid-conversation

```typescript
pi.sendMessage(
  { role: "user", content: [{ type: "text", text: "...steer..." }] },
  { triggerTurn: true, deliverAs: "steer" },
);
```

`deliverAs: "steer"` ensures the message is treated as a system-level instruction, not a regular user message.

### Registering a tool available to the agent

```typescript
pi.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "What it does",
  promptSnippet: "Brief hint for LLM",
  parameters: Type.Object({ arg: Type.Optional(Type.String()) }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    return { content: [{ type: "text", text: "result" }] };
  },
});
```

### Registering a slash command

```typescript
pi.registerCommand("mycmd", {
  description: "...",
  handler: async (args, ctx) => {
    const parts = args.trim().split(/\s+/);
    // parse and act
  },
});
```

## Deployment

Copy or symlink this directory to `~/.pi/agent/extensions/ralph-loop/`:

```bash
ln -s $(pwd) ~/.pi/agent/extensions/ralph-loop
```

Or install directly:

```bash
mkdir -p ~/.pi/agent/extensions/ralph-loop
cp index.ts package.json README.md ~/.pi/agent/extensions/ralph-loop/
```

Reload Pi (`/reload`) to activate.

## Skills Directory Structure

Skills are loaded from `~/.pi/agent/skills/_global/` via `before_agent_start`:

- `generate-spec/SKILL.md` — Markdown-first spec generation
- `red-team-audit/SKILL.md` — Adversarial security review with severity tagging
- `harden-spec/SKILL.md` — Patch markdown spec in-place, write changelog
- `tdd-implement/SKILL.md` — Red-Green-Refactor cycle instructions
- `pi-skills/pr-reviewer/SKILL.md` — Multi-pass PR review guidelines
- `markdown-to-html/SKILL.md` — Convert hardened markdown to polished HTML (7-chunk build strategy)

**Note**: The extension currently injects skills individually per-phase via the `PHASE_CONFIGS` registry in `index.ts`. The `markdown-to-html` skill should be referenced from the harden phase prompt. If it is not loaded, the agent will attempt single-shot HTML generation which fails on large specs (>20KB). Ensure the harden phase instruction explicitly tells the agent to use chunked file writes (see Common Pitfalls above).

## Open Risks / Future Work

1. **Phase advancement is heuristic** — regex on conversation text. Replace with explicit tool call (`ralph_phase_complete`).
2. **No rollback mechanism** — if Phase 4 breaks everything, no way to revert without manual git commands. Consider `git stash` or branch-per-phase.
3. **Gate timeout is static (120s)** — should be configurable per-project or auto-scaled based on project size.
4. **No concurrent pipeline support** — only one pipeline per session. Multi-feature parallel pipelines would need state scoping by feature name.
5. **Compaction recovery relies on `currentPhaseIndex`** — if this field gets dropped during extreme compaction, fallback to text detection is unreliable.

## Testing Checklist (Before Pushing)

- [ ] TypeScript compiles: `npx tsc --noEmit`
- [ ] No lint violations: `npx eslint . --ext .ts,.tsx` (if configured)
- [ ] Extension loads in Pi without errors after `/reload`
- [ ] `/ralph start test-feature` starts pipeline with all 5 phases
- [ ] Phase detection works during streaming (`message_update`)
- [ ] Anti-shortcut triggers when agent writes "Complete Summary" early
- [ ] Auto-resume works on session reload with unfinished phases
- [ ] `ralph_gate_check` tool returns structured results
- [ ] Skill injection only occurs when pipeline is active (`getState(ctx)` check)
