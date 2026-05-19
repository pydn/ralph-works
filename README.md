# Pi Ralph Extension

Full dev-cycle pipeline for [Pi](https://github.com/earendil-works/pi-coding-agent). Phase orchestration runs as a single continuous agent workflow, so Pi does not spawn a subprocess or TTY per phase. Configured quality gates still run shell commands from the extension process.

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

Or install the runtime files directly:

```bash
mkdir -p ~/.pi/agent/extensions/ralph-loop
cp -R index.ts src package.json package-lock.json README.md ~/.pi/agent/extensions/ralph-loop/
```

### Phase Skill Prerequisites

`/ralph start` validates the required phase skill files before launching the selected pipeline. By default, the extension reads skills from `~/.pi/agent/skills/_global`; set `PI_SKILL_BASE` to override that location.

Install these skills before running a full pipeline:

- `generate-spec/SKILL.md`
- `red-team-audit/SKILL.md`
- `harden-spec/SKILL.md`
- `tdd-implement/SKILL.md`
- `pi-skills/pr-reviewer/SKILL.md` or `pr-reviewer/SKILL.md`
- `markdown-to-html/SKILL.md` when the `render` phase is selected

Reload Pi (`/reload`) after installing or updating the extension and skills.

## Commands

| Command                                                             | Description                                                      |
| ------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `/ralph start <feature>`                                            | Start the default five-phase pipeline without HTML rendering     |
| `/ralph start <feature> --render-html`                              | Start with Markdown-to-HTML rendering enabled                    |
| `/ralph start <feature> html`                                       | Start with Markdown-to-HTML rendering enabled                    |
| `/ralph start <feature> --yolo`                                     | Start without the pre-implementation human review checkpoint     |
| `/ralph start <feature> spec,implement`                             | Run selected phases only                                         |
| `/ralph start <feature> "reduce nesting depth"`                     | With inline prompt                                               |
| `/ralph start <feature> .ralph/task.md`                             | Prompt from file                                                 |
| `/ralph start <feature> "..." spec,redteam,harden,render,implement` | Prompt + specific phases                                         |
| `/ralph status`                                                     | Show current pipeline state                                      |
| `/ralph pause`                                                      | Pause the active pipeline                                        |
| `/ralph continue`                                                   | Re-launch the current or queued phase without advancing it       |
| `/ralph continue --render-html`                                     | Enable HTML rendering before TDD, then continue                  |
| `/ralph continue html`                                              | Alias for enabling HTML rendering before TDD                     |
| `/ralph continue --yolo`                                            | Continue and keep straight-through mode enabled for later phases |
| `/ralph resume`                                                     | Resume the active pipeline at its current phase                  |
| `/ralph resume <phase>`                                             | Resume at a specific phase                                       |
| `/ralph gate [paths...]`                                            | Run standalone quality gates                                     |
| `/ralph clear-context`                                              | Manually clear context and reorient the agent                    |
| `/ralph clear-context --auto`                                       | Enable auto-clear at every phase boundary                        |
| `/ralph cancel`                                                     | Abort pipeline                                                   |

Valid phase names are `spec`, `redteam`, `harden`, `render`, `implement`, and `review`. The `render` phase is opt-in; default runs skip it unless `--render-html`, `html`, `render-html`, `with-html`, or an explicit phase list includes `render`.

## Phase Completion

Normal assistant turn completion does not advance the pipeline. For non-review phases, the assistant should finish its final message with this exact final non-empty line:

```text
RALPH_PHASE_COMPLETE
```

The controller then runs the phase post-hook and queues the next phase as a follow-up message. `implement` also advances at turn end after a passing configured `ralph_gate_check`, so a completed TDD pass can hand off to review even if the marker was omitted. By default, if earlier planning phases ran before `implement`, the controller pauses at a human review checkpoint before TDD starts; run `/ralph continue` to approve or start with `--yolo` to skip that checkpoint. The `review` phase ends through the `ralph_review_decision` tool instead of the completion marker.

## Quality Gates

Ralph gates are opt-in. During TDD and review phases, the extension auto-runs configured quality gates after 3 consecutive code write/edit tool results only when `.ralph/gate-config.json` exists. Manual gate checks are also available through `/ralph gate [paths...]`.

When configured implementation gates pass, the controller can hand off from `implement` to `review` at turn end even if the assistant omitted the final completion marker. If no gates are configured, Ralph reports that state and expects the agent to run the repository's documented test commands manually before using the normal phase completion marker. A `CRITICAL` review decision backtracks to `implement`; `LGTM` completes the pipeline.

### Gate Configuration

Create `.ralph/gate-config.json` to enable Ralph-managed gates:

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

Commands are validated against a whitelist of allowed tools and rejected if they contain shell metacharacters. Invalid configs fail gate resolution and do not fall back to inferred defaults.

### Standalone Gate Check

```bash
/ralph gate                          # Run gates for current project
/ralph gate src/foo.ts               # Run gates and pass supported target path(s)
```

Target paths are appended only to direct gate commands that commonly accept file arguments: `tsc`, `eslint`, `ruff`, `flake8`, and `pylint`. Commands that start with wrappers such as `npx`, `npm`, `uv`, or `node` run exactly as configured.

### Auto-Gate Trigger

During `implement` and `review` phases, configured gates auto-run after every 3 consecutive `write` or `edit` tool results. Any other tool result resets the counter. If no `.ralph/gate-config.json` exists, the auto-gate counter resets without running inferred commands. A concurrency lock prevents duplicate execution.

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
- Includes every phase boundary, including implement → review
- Manual `/ralph clear-context` still enforces a cooldown to prevent rapid-fire operator-triggered compaction
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
- **Conservative implementation checkpoint** — Default runs pause for human review before TDD after planning phases, with `--yolo` for straight-through execution
- **Default TDD/review loop** — Passing implementation gates launch review, and critical reviews return to TDD until LGTM
- **Auto-resume on reload** — Running pipelines resume the current executing phase or launch a queued `pre_hook` phase; paused pipelines stay paused

## Development Workflow

Before taking tracked implementation work, check `/workspace/prompts/ralph-extension-priority-action-plan.md` for backlog order, ownership, and completion state. Mark tracked items `[in progress]` before editing and clear the marker when the item is complete.

Do implementation work in a dedicated `git worktree`, not the primary checkout:

```bash
git worktree add /tmp/ralph-works-<task> -b <branch-name> HEAD
```

Use the package scripts from the repository root for local verification:

```bash
npm run typecheck      # TypeScript compile check
npm run lint           # ESLint
npm run format:check   # Prettier check
npm test               # Vitest
npm run check          # Typecheck, lint, format check, and tests
```

Use `npm run lint:fix` and `npm run format` for automated cleanup before committing.

## Credits

Based on Geoffrey Huntley's Ralph Wiggum approach for long-running agent tasks.
