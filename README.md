# Pi Ralph Extension

Full dev-cycle pipeline for [Pi](https://github.com/earendil-works/pi-coding-agent). Runs all phases as a single continuous agent workflow with no subprocess spawning or TTY issues.

## Phases

1. **Generate Spec** - Markdown engineering specification with problem statement, architecture diagram, and implementation plan
2. **Red Team Audit** - STRIDE analysis, attack surface mapping, exploitation paths, and severity-tagged findings
3. **Harden Spec** - Address critical findings, add security mitigations to the spec, and write a hardening changelog
4. **Render Markdown -> HTML** - Convert the hardened Markdown spec to polished HTML with Mermaid diagrams and responsive typography
5. **TDD Implementation** - Red-Green-Refactor with pre/post quality gates
6. **Ralph Review Loop** - Multi-pass PR review (Logic + Security + Style) with remediation

## Installation

Copy or symlink this directory to `~/.pi/agent/extensions/ralph-loop/`:

```bash
ln -s $(pwd) ~/.pi/agent/extensions/ralph-loop
```

Or install directly:

```bash
mkdir -p ~/.pi/agent/extensions/ralph-loop
cp -R index.ts src package.json package-lock.json README.md ~/.pi/agent/extensions/ralph-loop/
```

Reload Pi (`/reload`) to activate.

## Commands

| Command | Description |
|---------|-------------|
| `/ralph start <feature>` | Start the full six-phase pipeline |
| `/ralph <feature>` | Shorthand for starting the full pipeline |
| `/ralph start <feature> spec,implement` | Run selected phases only |
| `/ralph start <feature> "reduce nesting depth"` | With inline prompt |
| `/ralph start <feature> .ralph/task.md` | Prompt from file |
| `/ralph start <feature> "..." spec,redteam,harden,render,implement` | Prompt + specific phases |
| `/ralph status` | Show current pipeline state |
| `/ralph pause` | Pause the active pipeline |
| `/ralph continue` | Re-launch the current or queued phase without advancing it |
| `/ralph resume` | Resume the active pipeline at its current phase |
| `/ralph resume <phase>` | Resume at a specific phase |
| `/ralph gate [paths...]` | Run standalone quality gates |
| `/ralph clear-context` | Manually clear context and reorient the agent |
| `/ralph clear-context --auto` | Enable auto-clear at every phase boundary |
| `/ralph cancel` | Abort pipeline |

Valid phase names are `spec`, `redteam`, `harden`, `render`, `implement`, and `review`.

## Phase Completion

Normal assistant turn completion does not advance the pipeline. For non-review phases, the assistant must finish its final message with this exact final non-empty line:

```text
RALPH_PHASE_COMPLETE
```

The controller then runs the phase post-hook and queues the next phase as a follow-up message. The `review` phase ends through the `ralph_review_decision` tool instead of the completion marker.

## Quality Gates

During TDD and review phases, the extension auto-runs language-aware quality gates after 3 consecutive code write/edit tool results. Manual gate checks are also available through `/ralph gate [paths...]`.

### Auto-Detection
Gates are selected based on project type (scanned via filesystem markers):

| Detected Stack | Default Gates |
|----------------|---------------|
| TypeScript (`tsconfig.json` + `package.json`) | `npx tsc --noEmit`, `npx eslint . --ext .ts,.tsx`, `npx vitest run` |
| JavaScript (`package.json` only) | `npx eslint . --ext .js,.jsx`, `npx jest` |
| Python (`pyproject.toml` or `requirements.txt`) | `ruff check .`, `ruff format --check .`, `pytest tests/` |
| Unknown or fresh directory | Non-failing setup gate that reports no supported project markers |

### Config Override
Create `.ralph/gate-config.json` to override defaults:
```json
{
  "version": "1.0",
  "name": "my-custom-stack",
  "language": "typescript",
  "gates": [
    { "name": "Type Check", "command": "npx tsc --noEmit", "timeoutMs": 60000 },
    { "name": "Test", "command": "npx vitest run --coverage", "timeoutMs": 300000 }
  ]
}
```
Commands are validated against a whitelist of allowed tools and rejected if they contain shell metacharacters. Invalid configs fall back to auto-detected defaults.

### Standalone Gate Check
```bash
/ralph gate                          # Run gates for current project
/ralph gate src/foo.ts               # Run gates against specific target path(s)
```

### Auto-Gate Trigger
During `implement` and `review` phases, gates auto-run after every 3 consecutive `write` or `edit` tool results. Any other tool result resets the counter. A concurrency lock prevents duplicate execution.

## Context Clearing

During long pipelines the agent's context window can fill with stale conversation history, reducing attention on the current task. The clear-context feature compacts the session and sends a reorientation steer message so the agent knows where it left off.

### Usage

```
/ralph clear-context              # Clear once now
/ralph clear-context --auto       # Enable auto-clear at every phase boundary
```

### Auto-Clear Behavior

When `autoClearContext` is **enabled** (default), the extension auto-clears at each phase transition:

- Compacts conversation via `ctx.compact()` with instructions to preserve pipeline state
- On completion, sends a steer message listing current phase, artifact paths, and reorientation context
- Skips the implement → review transition (so review retains implementation context)
- Enforces a cooldown between clears to prevent rapid-fire compaction
- Best-effort — failures are silently ignored so they never block the pipeline

### Status Check

`/ralph status` shows clear-context metrics:

```
Context clears: 3
Auto clear: ON
```

## Features

- **Live TUI widget** — Shows current phase, updates in real-time during streaming
- **Compaction-safe state** — Phase index persists across context compaction via session JSONL
- **Auto-clear context** — Compacts conversation at phase boundaries to keep the agent focused (enabled by default)
- **Explicit phase completion** — Non-review phases advance only after the `RALPH_PHASE_COMPLETE` marker passes post-hook validation
- **Deterministic phase launch** — Successful phases queue the next phase as a follow-up message
- **Auto-resume on reload** — Running pipelines resume the current executing phase or launch a queued `pre_hook` phase; paused pipelines stay paused

## Development Workflow

Before taking tracked implementation work, check `/workspace/prompts/ralph-extension-priority-action-plan.md` for backlog order, ownership, and completion state. Mark tracked items `[in progress]` before editing and clear the marker when the item is complete.

Do implementation work in a dedicated `git worktree`, not the primary checkout:

```bash
git worktree add /tmp/ralph-works-<task> -b <branch-name> HEAD
```

## Credits

Based on Geoffrey Huntley's Ralph Wiggum approach for long-running agent tasks.
