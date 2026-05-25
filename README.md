# ralph-works

`ralph-works` is a lightweight Pi extension for coordinating the Ralph loop:

1. Generate Spec
2. Red Team Pass
3. Harden Spec
4. Optional HTML Render
5. Task Creation
6. Red-Green TDD Implement
7. Review
8. Complete

The extension starts only when `/ralph-works start` is called. It tracks the active phase, renders a small dark-terminal TUI widget after the pipeline starts, injects the phase skill and artifact context into each phase prompt, routes phase models from `model.config.json`, runs configured gates from `gate.config.json`, and uses fresh Pi session handoff via `ctx.newSession({ withSession })` after phase and TDD task boundaries.

RalphWorks is shipped as TypeScript source. `package.json` exposes `./index.ts` through `pi.extensions`, and Pi loads the extension from source without a build step or committed JavaScript output. Local development requires Node >=22.22.2 so Node can type-strip and run the TypeScript test files directly.

## Install

Use the package as a local Pi extension:

```sh
pi -e .
```

For auto-discovery, place or link this directory under a Pi extension location such as `.pi/extensions/ralph-works/`.

## Commands

Use `/ralph-works` as the command prefix:

```text
/ralph-works start feature-name Build the requested feature
/ralph-works status
/ralph-works next
/ralph-works next --render-html
/ralph-works gates
/ralph-works tdd-complete T001
/ralph-works artifact generatedSpec docs/feature-name-generated-spec.md
/ralph-works loopback critical review findings
/ralph-works approve
/ralph-works approve --render-html
/ralph-works reset
/ralph-works help
```

If Pi was already running when the extension changed or was linked, restart Pi or run `/reload`
before using the command. Extension commands require the leading slash; `ralph-works status`
is treated as ordinary chat input.

The normal workflow is marker-driven after `/ralph-works start`: each non-review phase prompt includes the relevant `SKILL.md`, expected artifacts, prior artifact paths, and the required `RALPH_PHASE_COMPLETE` final-line marker. When the agent emits that marker, the extension validates the boundary, updates state, creates a fresh Pi session handoff, injects durable workflow state plus bounded artifact context into the replacement session, and launches the next phase prompt there automatically.

Artifacts are written under `docs/` with a filesystem-safe feature prefix. For example, `/ralph-works start hello-world "Write a hello world script."` produces artifact paths such as `docs/hello-world-generated-spec.md`, `docs/hello-world-red-team-findings.md`, and `docs/hello-world-task-list.md`.

After `harden_spec`, the pipeline hands off to a fresh approval-waiting session with a `WAITING` TUI status. Review the hardened spec and run `/ralph-works approve` to continue into task creation and TDD, or `/ralph-works approve --render-html` to render the hardened spec as HTML first. During `tdd_implement`, each completed task can end with `RALPH_TDD_TASK_COMPLETE <task-id>` on its own line. RalphWorks then runs required gates, records the completed task, creates a fresh Pi session handoff with current state and generated artifact context, and continues TDD in the replacement session. The agent chooses the next task by inspecting the task list and implementation status artifacts; the extension does not parse task-list Markdown. When the task list is complete, the `tdd_implement` phase advances to `review` after its phase completion marker and passing required gates. Review automatically loops back to `tdd_implement` through a fresh session when critical findings are reported, and completes the pipeline in the current session when review is LGTM.

The TUI widget uses the compact RalphWorks look from the main extension: a colored `ralph-works` wordmark, a short status label, a phase count with a symbol rail, review loopbacks, gate results, and the active phase model when configured. The ANSI palette is tuned for dark terminal themes with teal, seafoam, sage, slate, amber, rose, and mist tones.

## Gates

`gate.config.json` controls validation commands after each completed TDD item:

```json
{
  "gates": [
    {
      "name": "unit_tests",
      "command": "npm test",
      "required": true
    },
    {
      "name": "lint",
      "command": "npm run lint",
      "required": true
    }
  ],
  "run_after_phase": ["tdd_implement"],
  "fail_behavior": "block_transition"
}
```

Required gates must pass before `RALPH_TDD_TASK_COMPLETE <task-id>` records the task and queues a task-boundary fresh Pi session handoff. `/ralph-works tdd-complete <task-id>` remains available as a manual fallback and uses the same completion path.

## Models

`model.config.json` controls phase routing:

```json
{
  "default_model": "anthropic/claude-default",
  "phase_models": {
    "generate_spec": "openai/spec-model",
    "red_team": "anthropic/red-team-model",
    "tdd_implement": "openai/implementation-model",
    "review": "anthropic/review-model"
  }
}
```

Use `provider/model-id` values when you want the extension to call `pi.setModel()` automatically. Bare model ids are displayed in the TUI but cannot be resolved automatically without a provider.

## Tests

`npm test` runs `npm run typecheck` first, then executes the TypeScript test suite with explicit Node test globs:

```sh
npm test
npm run typecheck
node --test tests/*.test.ts tests/*.e2e.test.ts
```

Run the opt-in real Pi e2e test with:

```sh
npm run test:e2e:pi
```

## Development Checks

Biome is the repo formatter and linter. `npm run check` runs TypeScript type checking and Biome checks:

```sh
npm run check
npm run check:write
npm run lint
npm run format
npm run format:check
```
