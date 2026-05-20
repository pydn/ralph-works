# AGENTS.md — Pi ralph-works Extension

This is a **TypeScript extension for [Pi](https://github.com/earendil-works/pi-coding-agent)** implementing a full dev-cycle pipeline (ralph-works loop). All phases run as a single continuous agent workflow with no subprocess spawning.

## Priority Tracker

Always reference `/workspace/prompts/ralph-extension-priority-action-plan.md` before starting work. Treat that file as the source of truth for backlog order, active ownership, and completion state.

If you are taking a tracked item from that file:

- Mark it `[in progress]` in the same turn before making code changes so other agents know it is claimed.
- When the work is complete, mark the task complete in the action plan in the same turn and remove the `[in progress]` marker.
- If you stop before finishing, leave `[in progress]` in place and add a short note describing the handoff state or blocker.

Do not start a tracked item without checking whether another agent has already claimed it.

## Quick Start

```bash
/ralph-works start <feature>                    # Full pipeline
/ralph-works start <feature> spec,harden        # Selected phases only
/ralph-works status                             # Show current state
/ralph-works cancel                             # Abort pipeline
/ralph-works gate [paths...]                    # Standalone gate check (no pipeline)
```

## Architecture Overview

Phases: **Generate Spec** → **Red Team Audit** → **Harden Spec** → **TDD Implementation** → **ralph-works Review Loop**.

For detailed architecture (data flow, hook table, component reference): read `docs/agent-reference.md` before modifying extension internals.

## Critical Development Rules

## Tool Usage Protocol

### Prefer Built-in Tools Over Bash for File Operations
- Use `read` tool instead of `bash cat` or `bash head`
- Use `write` or `edit` tool instead of `bash echo`, `bash tee`, `bash sed`
- Use `ls` tool instead of `bash ls`
- Use `grep` tool instead of `bash grep` when searching file contents
- Reserve `bash` for: compilation (`npx tsc`), test runs (`npm test`), git operations, and commands with no equivalent built-in tool

### Red-Green TDD Is Required

Always implement behavior changes using red-green TDD: add or update the regression test first, run the targeted test to confirm it fails for the expected reason, implement the smallest production change, then rerun the targeted test and relevant gates.

**⚠️ Critical**: `session_start` fires AFTER the extension function runs. Put startup logic in `session_start`, not module scope. See `docs/agent-reference.md` for full hook table and component reference.

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

**For detailed API patterns** (persisting state, steering LLM, registering tools/commands), **deployment instructions**, and **testing checklist**: read `docs/agent-reference.md` before implementing new features or deploying.

Skills: loaded from `~/.pi/agent/skills/_global/`. Key skills: `generate-spec`, `red-team-audit`, `harden-spec`, `tdd-implement`, `pr-reviewer`, `markdown-to-html`.
