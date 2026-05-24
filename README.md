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

The extension tracks the active phase, renders a small dark-terminal TUI widget, exposes the local RalphWorks skills to Pi, routes phase models from `model.config.json`, runs configured gates from `gate.config.json`, and triggers compaction after phase and TDD task boundaries.

## Install

Use the package as a local Pi extension:

```sh
pi -e .
```

For auto-discovery, place or link this directory under a Pi extension location such as `.pi/extensions/ralph-works/`.

## Commands

Use `/ralph-works` as the command prefix:

```text
/ralph-works status
/ralph-works next
/ralph-works next --render-html
/ralph-works gates
/ralph-works tdd-complete T001
/ralph-works artifact generatedSpec generated-spec.md
/ralph-works loopback critical review findings
/ralph-works approve
/ralph-works reset
```

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

Required gates must pass before `/ralph-works tdd-complete <task-id>` records the task and triggers task-level compaction.

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

```sh
npm test
```
