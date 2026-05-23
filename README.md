# ralph-works

**Persistence with receipts for Pi coding agents.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Pi Extension](https://img.shields.io/badge/Pi-v2%2B-orange)](https://github.com/earendil-works/pi-coding-agent)

AI agents write fast. Sometimes too fast: no spec, no threat model, tests after the fact, and a review that arrives when the assumptions are already baked in.

ralph-works is the boring engineering answer: a Pi extension that gives long agent runs a visible route through planning, pressure testing, implementation, and review. The agent keeps autonomy inside each phase. The developer gets artifacts to inspect, gates to configure, checkpoints to approve, and a review loop that can send work back instead of waving it through.

- **Spec first:** define scope, architecture, and tradeoffs before code exists.
- **Security early:** run a STRIDE-flavored red-team pass while the fix is still cheap.
- **Harden the plan:** patch the spec, not just the implementation.
- **Task-scoped TDD by default:** generate a durable task ledger, select one task at a time, write failing tests, implement, and run the repository's configured gates.
- **Human checkpoints:** pause before implementation unless `--yolo` is explicit.
- **Review with backtracking:** `CRITICAL` sends the run back to implementation; `LGTM` completes it.

## Visual Story

The hosted walkthrough is the brand-forward overview:

- GitHub Pages: <https://pydn.github.io/ralph-works/>
- Source: [`docs/ralph-works/index.html`](docs/ralph-works/index.html)

## The Loop

```text
/ralph-works start
        |
        v
Generate Spec -> Red Team Audit -> Harden Spec -> Generate Tasks -> Render HTML* -> Task-scoped TDD -> Review Loop
                                                                                                          |
                                                                                              CRITICAL reopens tasks

* HTML rendering is opt-in with --render-html, html, or an explicit render phase.
```

| Phase       | What the agent does         | What the developer gets                              |
| ----------- | --------------------------- | ---------------------------------------------------- |
| `spec`      | Writes the engineering spec | Scope, architecture, plan, and tradeoffs             |
| `redteam`   | Attacks the plan            | Threats, failure modes, and severity-tagged findings |
| `harden`    | Repairs the plan            | Mitigations and a hardened implementation route      |
| `tasks`     | Creates the task ledger     | Ordered Markdown implementation tasks                |
| `render`    | Converts Markdown to HTML   | Optional reviewable spec page                        |
| `implement` | Runs scoped TDD task loops  | Code, tests, and configured gate results per task    |
| `review`    | Performs multi-pass review  | `CRITICAL` remediation loops or final `LGTM`         |

## Why Pi

Pi is the right home for this workflow because it is lightweight, customizable, open source, and model agnostic. ralph-works stays close to the repository instead of hiding orchestration in a service, and it lets teams shape commands, gates, skills, checkpoints, and artifacts around the codebase they actually maintain.

Model routing can be explicit too. Planning, implementation, and review can each use the model that fits the phase without rewriting the workflow.

## Installation

Symlink or copy this directory into Pi's extension directory:

```bash
ln -s "$(pwd)" ~/.pi/agent/extensions/ralph-loop
```

Or install only the runtime files:

```bash
mkdir -p ~/.pi/agent/extensions/ralph-loop
cp -R index.ts src package.json package-lock.json README.md ~/.pi/agent/extensions/ralph-loop/
```

Reload Pi after installing or updating the extension:

```text
/reload
```

## Phase Skills

`/ralph-works start` validates the phase skill files before launching the selected pipeline. By default, skills are read from Pi's global skill directory at `~/.pi/agent/skills`; set `PI_SKILL_BASE` to use another directory.

| Skill file                                                 | Required for                                       |
| ---------------------------------------------------------- | -------------------------------------------------- |
| `generate-spec/SKILL.md`                                   | Generate Spec                                      |
| `red-team-audit/SKILL.md`                                  | Red Team Audit                                     |
| `harden-spec/SKILL.md`                                     | Harden Spec                                        |
| `tasks/SKILL.md`                                           | Generate Tasks                                     |
| `tdd-implement/SKILL.md`                                   | TDD Implementation                                 |
| `pr-reviewer/SKILL.md` or `pi-skills/pr-reviewer/SKILL.md` | Review Loop                                        |
| `markdown-to-html/SKILL.md`                                | Render phase, only when HTML rendering is selected |

## Commands

### Start a Run

| Command                                                                         | Result                                                                      |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `/ralph-works start <feature>`                                                  | Start the default pipeline: spec, redteam, harden, tasks, implement, review |
| `/ralph-works start <feature> --render-html`                                    | Include the optional render phase                                           |
| `/ralph-works start <feature> html`                                             | Alias for HTML rendering                                                    |
| `/ralph-works start <feature> --yolo`                                           | Skip the pre-implementation human checkpoint                                |
| `/ralph-works start <feature> spec,harden,tasks,implement`                      | Run only selected phases                                                    |
| `/ralph-works start <feature> "reduce nesting depth"`                           | Add an inline prompt                                                        |
| `/ralph-works start <feature> .ralph/task.md`                                   | Load the prompt from a file                                                 |
| `/ralph-works start <feature> "..." spec,redteam,harden,tasks,render,implement` | Combine prompt text with an explicit phase list                             |

Valid phase names are `spec`, `redteam`, `harden`, `tasks`, `render`, `implement`, and `review`.

### Control a Run

| Command                               | Result                                                       |
| ------------------------------------- | ------------------------------------------------------------ |
| `/ralph-works status`                 | Show current phase, pipeline state, and context metrics      |
| `/ralph-works pause`                  | Pause the active pipeline                                    |
| `/ralph-works resume`                 | Resume at the current phase                                  |
| `/ralph-works resume <phase>`         | Resume at a specific phase                                   |
| `/ralph-works continue`               | Re-launch the current or queued phase without advancing it   |
| `/ralph-works continue --render-html` | Enable HTML rendering before the task loop, then continue    |
| `/ralph-works continue html`          | Alias for enabling HTML rendering before the task loop       |
| `/ralph-works continue --yolo`        | Continue with straight-through mode enabled for later phases |
| `/ralph-works cancel`                 | Abort the pipeline                                           |

### Gates and Context

| Command                             | Result                                                |
| ----------------------------------- | ----------------------------------------------------- |
| `/ralph-works gate [paths...]`      | Run standalone quality gates without a pipeline       |
| `/ralph-works clear-context`        | Compact context once and reorient the agent           |
| `/ralph-works clear-context --auto` | Enable automatic context clearing at phase boundaries |

## Phase Completion

Assistant turn completion does not advance the pipeline by itself. Non-review phases advance only when the assistant ends its final message with this exact final non-empty line:

```text
RALPH_PHASE_COMPLETE
```

The controller then runs phase validation and queues the next phase as a follow-up message. `implement` is a task loop: Ralph launches a selector prompt, trusts one `RALPH_SELECTED_TASK TASK-0001`, persists that selected task, runs `tdd-implement` only for that task, and accepts `RALPH_TASK_COMPLETE` only after configured gates pass. `RALPH_TASK_BLOCKED` marks the task blocked and relaunches the selector. The `review` phase ends through the `ralph_review_decision` tool instead of the marker; `CRITICAL` findings are converted into new task-ledger entries and routed back through the same task loop.

By default, a run that includes planning phases pauses before `implement` so the developer can inspect the hardened spec and task ledger. Use `/ralph-works continue` to approve the handoff, or start with `--yolo` when straight-through mode is intentional.

## Quality Gates

ralph-works gates are opt-in. Add `.ralph/gate-config.json` to let the extension run configured gates before each implementation task is marked complete, during `review`, and through manual checks with `/ralph-works gate [paths...]`.

```json
{
  "version": "1.0",
  "name": "my-custom-stack",
  "language": "typescript",
  "gates": [
    { "name": "Type Check", "command": "npx tsc --noEmit", "timeoutMs": 60000 },
    { "name": "Test Suite", "command": "npx vitest run --coverage", "timeoutMs": 300000 }
  ]
}
```

Commands are validated against an allowlist and rejected if they contain shell metacharacters. Invalid configs fail gate resolution and do not fall back to inferred defaults.

During `implement` and `review`, configured gates auto-run after every 3 consecutive code write/edit tool results. Any other tool result resets the counter. A concurrency lock prevents duplicate execution.

Target paths from `/ralph-works gate [paths...]` are appended only to direct gate commands that commonly accept file arguments: `tsc`, `eslint`, `ruff`, `flake8`, and `pylint`. Commands that start with wrappers such as `npx`, `npm`, `uv`, or `node` run exactly as configured.

## Context Clearing

Long agent runs accumulate stale conversation history. ralph-works can compact the session and send a reorientation steer message so the current phase, artifacts, and next action survive context pressure.

Automatic context clearing is enabled by default at phase boundaries. Manual clearing is available with `/ralph-works clear-context`, and `/ralph-works status` reports the current clear count and auto-clear setting.

## Development

Before taking tracked implementation work, check `/workspace/prompts/ralph-extension-priority-action-plan.md` for backlog order, ownership, and completion state. Mark tracked items `[in progress]` before editing and clear the marker when the item is complete.

Do implementation work in a dedicated Git worktree, not the primary checkout:

```bash
git worktree add /tmp/ralph-works-<task> -b <branch-name> HEAD
```

Use the repository scripts for local verification:

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run check
```

Use `npm run lint:fix` and `npm run format` for automated cleanup before committing.

## Credits

ralph-works is inspired by [Geoffrey Huntley](https://github.com/grumpycodersysadmin01)'s Ralph Wiggum methodology for long-running agent tasks and implemented as a Pi extension. The repository is MIT licensed, inspectable, and intended to be adapted to real team workflows.
