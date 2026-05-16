# Pi Ralph Extension

Full dev-cycle pipeline for [Pi](https://github.com/earendil-works/pi-coding-agent). Runs all phases as a single continuous agent workflow with no subprocess spawning or TTY issues.

## Phases

1. **Generate Spec** — HTML engineering specification with problem statement, architecture diagram, implementation plan
2. **Red Team Audit** — STRIDE analysis, attack surface mapping, exploitation paths
3. **Harden Spec** — Address critical findings, add security mitigations to spec
4. **TDD Implementation** — Red-Green-Refactor with pre/post quality gates
5. **Ralph Review Loop** — Multi-pass PR review (Logic + Security + Style) with remediation

## Installation

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

## Commands

| Command | Description |
|---------|-------------|
| `/ralph start <feature>` | Start full pipeline |
| `/ralph start <feature> spec,implement` | Run selected phases only |
| `/ralph start <feature> "reduce nesting depth"` | With inline prompt |
| `/ralph start <feature> .ralph/task.md` | Prompt from file |
| `/ralph start <feature> "..." spec,implement` | Prompt + specific phases |
| `/ralph status` | Show current pipeline state |
| `/ralph clear-context` | Manually clear context and reorient the agent |
| `/ralph clear-context --auto` | Enable auto-clear at every phase boundary |
| `/ralph cancel` | Abort pipeline |

## Quality Gates

After every implementation step during TDD and review phases, the extension auto-runs language-aware quality gates:

### Auto-Detection
Gates are selected based on project type (scanned via filesystem markers):

| Detected Stack | Default Gates |
|----------------|---------------|
| TypeScript (`tsconfig.json` + `package.json`) | `tsc --noEmit`, `eslint .`, `vitest run` |
| JavaScript (`package.json` only) | `eslint .`, `jest` |
| Python (`pyproject.toml` or `requirements.txt`) | `ruff check .`, `ruff format --check .`, `pytest tests/` |
| Unknown (no markers) | `tsc --noEmit`, `vitest run` (default fallback) |

### Config Override
Create `.ralph/gate-config.json` to override defaults:
```json
{
  "version": "1.0",
  "name": "my-custom-stack",
  "language": "typescript",
  "gates": [
    { "name": "Type Check", "command": "tsc --noEmit", "timeoutMs": 60000 },
    { "name": "Test", "command": "vitest run --coverage", "timeoutMs": 300000 }
  ]
}
```
Commands are validated against a whitelist of allowed tools. Non-whitelisted commands fall back to auto-detected defaults.

### Standalone Gate Check
```bash
/ralph gate                          # Run gates for current project
/ralph gate src/foo.ts               # Run lint on specific file(s)
```

### Auto-Gate Trigger
During `implement` and `review` phases, gates auto-run after every 3 consecutive code changes. A concurrency lock prevents duplicate execution.

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
- **Anti-shortcut detection** — Detects if the agent writes a summary before finishing all phases and steers it back
- **Auto-resume on reload** — If pipeline has unfinished phases, sends steering message immediately on session start

## Credits

Based on Geoffrey Huntley's Ralph Wiggum approach for long-running agent tasks.
