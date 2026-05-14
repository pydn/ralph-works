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
| `/ralph cancel` | Abort pipeline |

## Quality Gates

After every implementation step during TDD and review phases, the extension auto-runs:

1. `uv run ruff check . --select E,F,W,I` — lint errors (blocker)
2. `uv run ruff format --check .` — formatting (auto-fixed on failure)
3. `uv run python -m unittest discover tests -v` — test suite (blocker)

## Features

- **Live TUI widget** — Shows current phase, updates in real-time during streaming
- **Compaction-safe state** — Phase index persists across context compaction via session JSONL
- **Anti-shortcut detection** — Detects if the agent writes a summary before finishing all phases and steers it back
- **Auto-resume on reload** — If pipeline has unfinished phases, sends steering message immediately on session start

## Credits

Based on Geoffrey Huntley's Ralph Wiggum approach for long-running agent tasks.
