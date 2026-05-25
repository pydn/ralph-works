# typescript-migration Task List

Feature prompt: "Migrate all code in this extension from .js to typescript. All functionality should remain the same."

This list is ordered by implementation priority. The TDD implementation phase should claim the first unchecked, unblocked task, preserve current behavior, and complete it only after focused tests plus relevant validation pass.

## Task Status Legend

- `[ ]` Unclaimed / not complete.
- `[~]` Claimed / in progress.
- `[x]` Complete.

## Global Completion Rules

- Use red-green TDD for each task: add or update a failing test first, then make the smallest behavior-preserving change that passes.
- Preserve public RalphWorks contracts: commands, tools, markers, phase transitions, gate behavior, model routing, TUI text, artifact names, session handoff data, and persisted state shapes.
- Use explicit `.ts` extensions for all first-party relative imports in migrated files.
- Do not add a build step, committed `dist/`, JavaScript compatibility wrapper, `tsx`, `ts-node`, Babel, or generated runtime JavaScript.
- Keep TypeScript syntax erasable/direct-source-compatible: no `enum`, `namespace`, parameter properties, decorators, or other syntax requiring transformation.
- Avoid broad `any`; use explicit interfaces, unions, `unknown` plus narrowing for config/tool inputs, and localized assertions at Pi/Node boundaries.
- Existing behavioral tests may be translated to TypeScript and path updates, but must not be weakened to accept changed behavior.

## Prioritized Tasks

### T001 — Establish TypeScript toolchain and source-run contract

- Status: `[x]`
- Priority: P0
- Scope:
  - Add `typescript`, `@types/node`, and `jiti` as development dependencies and update `package-lock.json`.
  - Add `engines.node` or equivalent documented minimum, defaulting to `>=22.22.2` unless a lower version is proven.
  - Add `tsconfig.json` for strict no-emit Node ESM/source execution: `module`/`moduleResolution` compatible with NodeNext, `allowImportingTsExtensions`, `strict`, `verbatimModuleSyntax`, `isolatedModules`, and `erasableSyntaxOnly` or stricter equivalent.
  - Add a `typecheck` script and prepare package scripts so final `check` and `test` include type checking.
  - Keep `pi.extensions` pointed at `./index.ts`; do not introduce a build output.
- Red test / evidence to create first:
  - A package/script or Node test expectation showing `npm run typecheck` exists and fails before the configuration/dependencies are added, or a focused validation command that fails on the missing TypeScript setup.
- Done when:
  - `npm run typecheck` can run from local dependencies.
  - The TypeScript configuration is strict and source-run oriented.
  - Package metadata and lockfile are consistent.

### T002 — Convert root and extension entrypoints to TypeScript-only loading

- Status: `[x]`
- Priority: P0
- Depends on: T001
- Scope:
  - Update `index.ts` to import/export TypeScript source with an explicit `.ts` extension.
  - Remove the obsolete duplicate JavaScript entrypoint wrapper (`src/extension-entry.js`).
  - Keep a single TypeScript extension entrypoint (`src/extension-entry.ts`) and update its local imports to `.ts`.
  - If Pi types are not imported from `@earendil-works/pi-coding-agent`, define narrow local interfaces for only the Pi APIs RalphWorks uses.
  - If Pi package types are imported, add the required peer/development dependency metadata without bundling Pi core as a normal runtime dependency.
- Red test / evidence to create first:
  - Add or update a `jiti` smoke test that loads `./index.ts` without a build step and asserts the default export is callable as the extension entrypoint.
- Done when:
  - The smoke test passes through `jiti`.
  - No first-party `.js` entrypoint compatibility wrapper remains.
  - Pi manifest behavior remains `pi.extensions: ["./index.ts"]`.

### T003 — Migrate phase, state, and task-status workflow modules

- Status: `[x]`
- Priority: P0
- Depends on: T001
- Scope:
  - Rename and convert `src/phases/*.js`, `src/state/*.js`, and `src/tasks/*.js` to `.ts`.
  - Add explicit types for phase IDs, phase definitions, workflow state, transition records, completion markers, handoff status, and implementation status.
  - Preserve marker constants and harden approval status values exactly.
  - Update local imports in these modules and their dependent tests to explicit `.ts` specifiers.
- Red test / evidence to create first:
  - Convert or update focused tests for phase completion, phase transitions, session handoff state, task status, and generate-spec skill path handling so they fail against stale `.js` imports or missing TypeScript modules.
- Done when:
  - Behavior covered by `phase-completion`, `phase-transitions`, `session-handoff-state`, `task-status-updater`, and related phase tests remains unchanged.
  - Type checking covers these modules without broad `any`.

### T004 — Migrate artifact tracking and prompt construction modules

- Status: `[x]`
- Priority: P0
- Depends on: T003
- Scope:
  - Rename and convert `src/artifacts/*.js` and `src/prompts/*.js` to `.ts`.
  - Type artifact keys, artifact references, safe artifact inventory records, prompt input context, and session handoff summary data.
  - Preserve docs artifact naming, feature sanitization, artifact excerpt limits, untrusted excerpt labeling, and path/binary/symlink safeguards.
  - Update local imports and tests to explicit `.ts` specifiers.
- Red test / evidence to create first:
  - Convert or update artifact path, phase prompt builder, and session handoff summary tests before implementation changes.
- Done when:
  - Artifact and prompt tests pass with the same assertions after TypeScript migration.
  - Generated artifact paths remain under `docs/<feature>-...` with unchanged names.

### T005 — Migrate gate and model configuration subsystems

- Status: `[x]`
- Priority: P0
- Depends on: T001
- Scope:
  - Rename and convert `src/gates/*.js` and `src/models/*.js` to `.ts`.
  - Add explicit types for gate config, gate definitions, gate results, model config, model references, and phase model resolution.
  - Use `unknown` plus narrowing for JSON/config inputs while preserving existing permissive behavior and validation messages.
  - Update all local imports and tests to explicit `.ts` specifiers.
- Red test / evidence to create first:
  - Convert or update gate config loader, gate runner, model config loader, and phase model resolver tests.
- Done when:
  - Gate and model tests pass without schema drift.
  - Required/optional gate semantics and model fallback behavior remain unchanged.

### T006 — Migrate TUI rendering modules

- Status: `[x]`
- Priority: P0
- Depends on: T003, T005
- Scope:
  - Rename and convert `src/tui/*.js` to `.ts`.
  - Type workflow progress view inputs, gate status view inputs, palette values, active model display, handoff display, and sanitization helpers.
  - Preserve all existing visible labels, ordering, control-character sanitization, harden approval instructions, loopback display, and gate status text.
  - Update dependent imports and tests to explicit `.ts` specifiers.
- Red test / evidence to create first:
  - Convert or update `workflow-progress-view` tests so visible output changes fail.
- Done when:
  - TUI tests pass with unchanged expected content except intentional `.ts` path/documentation updates.
  - TypeScript types make TUI inputs explicit without altering rendering behavior.

### T007 — Migrate Pi harness integration modules

- Status: `[x]`
- Priority: P0
- Depends on: T002, T003, T004, T005, T006
- Scope:
  - Rename and convert `src/harness/*.js` to `.ts`.
  - Type the RalphWorks command handler, tool handlers, state persistence adapter, session handoff orchestration, model routing, gate runner bridge, TUI updater, argument parser, and tool result helpers.
  - Keep narrow local Pi API interfaces if the implementation avoids Pi package type imports.
  - Preserve command names and behavior for `start`, `status`, `next`, `gates`, `tdd-complete`, `artifact`, `loopback`, `approve`, `reset`, and `help`.
  - Preserve tool names, schemas, return semantics, marker handling, required gate blocking, harden approval pause, optional HTML approval, review loopback, model routing, TUI updates, notifications, and compaction/session handoff behavior.
  - Update local imports and harness-focused tests to explicit `.ts` specifiers.
- Red test / evidence to create first:
  - Convert or update harness adapter, state persistence, session handoff, and no-compaction orchestration tests before changing harness source.
- Done when:
  - Harness tests pass with existing behavioral assertions.
  - Public command/tool/state/session semantics remain unchanged.

### T008 — Migrate the test suite and fixture files one-to-one

- Status: `[x]`
- Priority: P0
- Depends on: T003, T004, T005, T006, T007
- Scope:
  - Rename all first-party tests under `tests/` from `.js` to `.ts`.
  - Rename `tests/fixtures/scripted-pi-provider.js` to `tests/fixtures/scripted-pi-provider.ts`.
  - Update all test imports, fixture spawns, `fileURLToPath` path logic, and e2e references to migrated `.ts` files.
  - Keep `node:test` style and existing skip behavior for real-Pi e2e unless `RALPH_WORKS_PI_E2E=1` is set.
  - Ensure skipped e2e tests are still typechecked, parseable, and runnable when opted in.
- Required one-to-one conversion checklist:

| Old file | New file |
| --- | --- |
| `tests/artifact-paths.test.js` | `tests/artifact-paths.test.ts` |
| `tests/documentation-wording.test.js` | `tests/documentation-wording.test.ts` |
| `tests/fixtures/scripted-pi-provider.js` | `tests/fixtures/scripted-pi-provider.ts` |
| `tests/gate-config-loader.test.js` | `tests/gate-config-loader.test.ts` |
| `tests/gate-runner.test.js` | `tests/gate-runner.test.ts` |
| `tests/generate-spec-skill.test.js` | `tests/generate-spec-skill.test.ts` |
| `tests/model-config-loader.test.js` | `tests/model-config-loader.test.ts` |
| `tests/no-compaction-orchestration.test.js` | `tests/no-compaction-orchestration.test.ts` |
| `tests/phase-completion.test.js` | `tests/phase-completion.test.ts` |
| `tests/phase-model-resolver.test.js` | `tests/phase-model-resolver.test.ts` |
| `tests/phase-prompt-builder.test.js` | `tests/phase-prompt-builder.test.ts` |
| `tests/phase-transitions.test.js` | `tests/phase-transitions.test.ts` |
| `tests/pi-harness-adapter.test.js` | `tests/pi-harness-adapter.test.ts` |
| `tests/pi-real-session-handoff.e2e.test.js` | `tests/pi-real-session-handoff.e2e.test.ts` |
| `tests/pi-session-handoff.test.js` | `tests/pi-session-handoff.test.ts` |
| `tests/pi-state-persistence.test.js` | `tests/pi-state-persistence.test.ts` |
| `tests/session-handoff-state.test.js` | `tests/session-handoff-state.test.ts` |
| `tests/session-handoff-summary.test.js` | `tests/session-handoff-summary.test.ts` |
| `tests/task-status-updater.test.js` | `tests/task-status-updater.test.ts` |
| `tests/workflow-progress-view.test.js` | `tests/workflow-progress-view.test.ts` |

- Red test / evidence to create first:
  - Update package test command locally or in a failing check to show `.js` tests are no longer discovered/allowed.
- Done when:
  - All listed TypeScript counterparts exist.
  - No migrated test depends on first-party `.js` imports or fixture paths.
  - The real-Pi e2e opt-in script targets `tests/pi-real-session-handoff.e2e.test.ts`.

### T009 — Add repository migration invariant tests

- Status: `[x]`
- Priority: P0
- Depends on: T008
- Scope:
  - Add a TypeScript invariant test or script included in `npm test` that fails if any tracked first-party `.js`, `.mjs`, or `.cjs` source/test/script file remains outside ignored/generated/external directories (`node_modules/`, `dist/`, `coverage/`, etc.).
  - Add an invariant that fails if a first-party TypeScript source, test, fixture, or script uses a local relative import specifier ending in `.js`.
  - Ensure the check distinguishes first-party source from external installed Pi internals and does not scan generated documentation artifacts as source.
  - Keep or extend the `jiti` entrypoint smoke test from T002 as part of the normal test suite.
- Red test / evidence to create first:
  - Write the invariant tests before deleting/updating the final offending `.js` files/imports so they fail for the current repository state.
- Done when:
  - `npm test` fails on reintroduced first-party JavaScript files or local `.js` import specifiers.
  - External/third-party `.js` paths are not falsely flagged.

### T010 — Finalize package scripts and full-project type coverage

- Status: `[x]`
- Priority: P0
- Depends on: T008, T009
- Scope:
  - Make `npm test` run `npm run typecheck` first, then explicit TypeScript test paths/globs such as `node --test tests/*.test.ts tests/*.e2e.test.ts`.
  - Make `npm run check` run Biome checks and TypeScript type checking, failing on either.
  - Keep `check:write`, `format`, `format:check`, and `lint` meaningful for the migrated TypeScript repository.
  - Ensure `test:e2e:pi` uses `RALPH_WORKS_PI_E2E=1 node --test tests/pi-real-session-handoff.e2e.test.ts` or equivalent.
  - Expand `tsconfig.json` includes to cover `index.ts`, root TypeScript support files, `src/**/*.ts`, `tests/**/*.ts`, and fixtures; exclude `node_modules`, `dist`, `coverage`, and generated docs.
  - Remove any temporary incremental allowances that contradict the final source-run TypeScript contract.
- Red test / evidence to create first:
  - A failing script/documentation wording test or direct command showing old package scripts still point at `.js` tests or omit type checking.
- Done when:
  - `npm test`, `npm run check`, `npm run lint`, `npm run format:check`, and `npm run test:e2e:pi` target TypeScript paths correctly.
  - Full-project `tsc --noEmit` passes with strict settings.

### T011 — Update documentation and repository guidance

- Status: `[x]`
- Priority: P1
- Depends on: T010
- Scope:
  - Update `README.md` developer commands, source-run TypeScript expectations, package/test examples, and any first-party file path examples.
  - Update `AGENTS.md` focused test examples from `.js` to `.ts` and remove the instruction to keep JavaScript/TypeScript entrypoint wrappers aligned.
  - Update skill documentation only where it references obsolete first-party `.js` paths or validation commands.
  - Update documentation wording tests while preserving their intent.
  - Leave `.js` references only when they clearly point to external installed packages, historical context, or intentionally obsolete examples.
- Red test / evidence to create first:
  - Convert/update `documentation-wording` tests so stale `.js` guidance fails.
- Done when:
  - Docs no longer tell maintainers or agents to run deleted first-party `.js` paths or preserve JavaScript wrappers.
  - Documentation tests pass.

### T012 — Final migration audit and behavior-preservation verification

- Status: `[x]`
- Priority: P1
- Depends on: T001-T011
- Scope:
  - Run final repository scans for tracked first-party `.js`, `.mjs`, and `.cjs` files, local `.js` import specifiers, committed `dist/`/generated JavaScript output, and obsolete package-script targets.
  - Run the full validation commands: `npm test` and `npm run check`.
  - Run focused high-risk tests if useful: harness adapter, session handoff, gate/model config, TUI rendering, phase transitions, and e2e command in skipped mode.
  - Confirm clean-install readiness by ensuring package metadata and lockfile are synchronized.
  - Fix any behavior drift found by the migrated tests without weakening assertions.
- Red test / evidence to create first:
  - Use the invariant tests and existing behavior tests as the audit safety net; any failure becomes the red step for this final task.
- Done when:
  - `npm test` passes with real-Pi e2e still skipped unless opted in.
  - `npm run check` passes.
  - No tracked first-party JavaScript source/test/script files or local first-party `.js` imports remain.
  - The extension remains source-run TypeScript with no required build step.

### T013 — Fix real Pi nested session handoff after TypeScript migration

- Status: `[x]`
- Priority: P0
- Depends on: T007, T008, T010
- Scope:
  - Repair the real Pi handoff path so a phase running inside a replacement session can create the next replacement session.
  - Preserve the existing source-run TypeScript contract and all public command/tool/session semantics.
  - Keep the fix focused on session-control context retention or handoff execution; do not weaken the real-Pi E2E assertions.
- Red test / evidence to create first:
  - `RALPH_WORKS_PI_E2E=1 node --test --test-name-pattern "real Pi creates a replacement session after a TDD task marker" tests/pi-real-session-handoff.e2e.test.ts` currently fails because the transition from `red_team` to `harden_spec` ends in `HANDOFF FAILED` with `RalphWorks session handoff requires an active Pi command context.`
- Done when:
  - `npm run test:e2e:pi` passes in this environment.
  - `npm test` passes.
  - `npm run check` passes.

## Acceptance Mapping

- TypeScript-only source/tests/scripts: T002-T010, T012.
- Strict type checking and source-run execution: T001, T002, T010.
- Pi `jiti` load compatibility: T002, T009, T012.
- Runtime behavior preservation: T003-T007, T012.
- Test one-to-one migration: T008.
- Repository invariant coverage: T009.
- Documentation and guidance updates: T011.
- Final `npm test` / `npm run check` validation: T010, T012.
