# AGENTS.md

## Scope

These instructions apply to the whole repository.

## Project Overview

`ralph-works` is a lightweight Pi extension that coordinates the RalphWorks workflow: generate spec, red-team, harden spec, optional HTML render, task creation, red-green TDD implementation, review, and complete.

Keep the extension focused on orchestration. The extension owns phase state, TUI display, model routing, gate coordination, artifact references, and compaction handoff. The agent phases and skills own the substantive work of writing specs, hardening, task creation, implementation, and review.

## Commands

- Run the test suite with `npm test`.
- Run lint and formatter checks together with `npm run check`.
- Apply safe lint and formatting fixes with `npm run check:write`.
- Format files with `npm run format`; verify formatting only with `npm run format:check`.
- Run lint only with `npm run lint`.
- Use focused Node tests while iterating, for example `node tests/compaction-summary.test.js` or `node tests/pi-harness-adapter.test.js`.
- There is no separate build script in `package.json` today.

## Code Style

- This is an ESM Node project. Use `import` and `export`.
- Biome is the formatter and linter. Follow `biome.json` rather than introducing separate ESLint or Prettier config.
- Use two-space indentation, double quotes, semicolons, and trailing commas where Biome applies them.
- Keep modules small and responsibility-focused. Prefer adding logic near the existing subsystem:
  - `src/harness/` for Pi integration and command/tool handlers.
  - `src/state/` for phase state, completion markers, and transitions.
  - `src/artifacts/` for artifact paths, references, and compaction summaries.
  - `src/gates/` for gate config, execution, and results.
  - `src/models/` for model config and resolution.
  - `src/prompts/` for phase prompt construction.
  - `src/tasks/` for task parsing, selection, and implementation status.
  - `src/tui/` for terminal widget rendering.
- Prefer explicit, testable pure functions for state transitions and rendering helpers.
- Keep files ASCII unless the edited file already uses non-ASCII content for a clear reason.
- Avoid broad refactors when fixing a narrow workflow bug.
- If you touch the extension entrypoint, keep `src/extension-entry.js` and `src/extension-entry.ts` behavior aligned.

## Workflow Invariants

- `/ralph-works start` is the only normal way to begin a pipeline.
- Non-review phase completion is marker-driven with `RALPH_PHASE_COMPLETE` as the final non-empty assistant line.
- `tdd_implement` task completion uses `RALPH_TDD_TASK_COMPLETE <task-id>` as the final non-empty assistant line.
- After `harden_spec`, the workflow must pause with `phaseStatus: "awaiting_harden_approval"` until the user runs `/ralph-works approve` or `/ralph-works approve --render-html`.
- Required gates from `gate.config.json` must block TDD task completion and phase advancement when they fail.
- Review completes only on LGTM. Critical findings or `RALPH_REVIEW_CHANGES_REQUESTED` loop back to `tdd_implement`.
- Compaction summaries must include enough durable context for the workflow to resume after session compaction.
- Runtime artifacts should remain under `docs/` with the feature-prefixed filenames produced by `buildArtifactPath`.

## Testing Expectations

- Add or update tests for every behavior change. Prefer focused tests in the nearest existing test file.
- Use red-green TDD when changing workflow behavior: add the failing assertion first, then implement the smallest fix.
- For harness changes, cover both persisted state and user-visible effects such as TUI updates, notifications, compaction options, and follow-up prompts.
- For state or parsing changes, cover edge cases with pure unit tests before relying on adapter-level tests.
- Run `npm run check` and `npm test` before considering the change complete.

## Pull Request Notes

- Keep PRs scoped to one workflow behavior or cleanup.
- Include a concise summary and the exact tests run.
- Do not commit generated runtime artifacts under `docs/` unless the user explicitly requested them.
