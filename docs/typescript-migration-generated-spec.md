# typescript-migration Generated Spec

## 1. Purpose And User Value

Migrate RalphWorks from first-party JavaScript files to TypeScript source while preserving the extension's existing user-visible behavior. The successful outcome is a TypeScript-only RalphWorks codebase that Pi can load directly from source, developers can test and type-check without a build step, and later RalphWorks phases can safely refactor implementation details without changing workflow semantics.

## 2. Intended Users And Context

The intended users are RalphWorks maintainers and downstream RalphWorks agent phases that will plan, implement, and review the migration. Operators still use the extension through Pi commands such as `/ralph-works start`, `/ralph-works approve`, `/ralph-works tdd-complete`, and `/ralph-works status`.

Repository context:

- The package is an ESM Node project (`"type": "module"`) with a Pi manifest that currently loads `./index.ts`.
- Most first-party runtime and test code is currently `.js`; a small TypeScript entrypoint exists at `src/extension-entry.ts` but it imports the JavaScript harness.
- There is no `tsconfig*.json` in the repository today.
- The current validation commands are `npm run check` for Biome and `npm test` for Node's built-in test runner.
- The feature is not released yet, and the user explicitly said JavaScript path compatibility does not need to be preserved.

## 3. Evidence And Research Notes

User-provided evidence and decisions:

- The migration must include every runtime, test, and configuration script currently written in `.js`, not only files under `src/`.
- The package must publish and run TypeScript source directly, without compiling TypeScript to JavaScript before execution.
- Backward-compatible JavaScript entrypoint paths are not required because the extension has not been released.
- All tests should migrate to TypeScript.
- Type checking should become part of the project validation scripts.
- Behavior cleanup and refactors are expected, while functionality must remain the same.

Local codebase research performed:

- `package.json` shows ESM mode, Pi extension entry `./index.ts`, scripts `check`, `check:write`, `format`, `format:check`, `lint`, `test`, and `test:e2e:pi`, and only `@biomejs/biome` as a current dev dependency.
- `index.ts` currently re-exports `./src/extension-entry.js`, so even the TypeScript package entrypoint still targets JavaScript source.
- `src/extension-entry.js` and `src/extension-entry.ts` are duplicated entrypoint wrappers; the TypeScript wrapper imports `./harness/pi-harness-adapter.js`.
- `find src tests ...` found first-party JavaScript runtime, test, and fixture files across `src/` and `tests/`, including `tests/fixtures/scripted-pi-provider.js`.
- `src/phases/*.js`, `src/state/*.js`, `src/harness/*.js`, `src/artifacts/*.js`, `src/gates/*.js`, `src/models/*.js`, `src/prompts/*.js`, `src/tasks/*.js`, and `src/tui/*.js` define the current workflow behavior that must be preserved.
- `src/harness/pi-harness-adapter.js` registers the command, tools, session events, model routing, gate execution, harden approval pause, TDD completion handling, and review loopback behavior.
- `src/state/phase-completion.js`, `src/state/phase-state.js`, and `src/state/phase-transitions.js` define the phase markers, harden approval status, initial state, legal transitions, and review loopback behavior.
- `src/artifacts/artifact-paths.js`, `src/artifacts/artifact-tracker.js`, and `src/artifacts/session-handoff-summary.js` define docs artifact naming, recorded artifacts, and durable handoff summaries.
- `src/gates/*` and `gate.config.json` show that gates remain configurable and currently default to no required gates in this checkout.
- `src/models/*` and `model.config.json` show that model routing remains configurable and currently has no phase models in this checkout.
- `src/tui/*` renders the current RalphWorks widget, including phase status, harden approval waiting state, handoff state, loopbacks, gate results, and active model display.
- `README.md` documents the current command surface, marker-driven phase flow, artifact naming under `docs/`, gate behavior, model behavior, and development commands.
- `skills/*.md`, especially `skills/red-green-tdd-implement/SKILL.md` and `skills/review/SKILL.md`, document the division of responsibility between the extension coordinator and the agent phases.
- `tests/*.js` cover artifact paths, gate loading/running, model resolution, phase prompts, phase transitions, harness behavior, session handoff, task status, TUI rendering, documentation wording, and the real Pi e2e flow.
- `tests/pi-real-session-handoff.e2e.test.js` contains JavaScript fixture references that must be updated for first-party files, while external Pi package `dist/*.js` references may remain if they point to installed Pi internals rather than RalphWorks source.
- `.gitignore` ignores `node_modules/`, `coverage/`, and `dist/`, which supports the requirement not to commit generated JavaScript output.
- `npm test` passed locally with 112 passing tests and 2 skipped real-Pi e2e tests.
- `npm run check` passed locally with Biome checking 62 files.
- `node --version` reported `v22.22.2`; an empirical temporary `node --test` run against a `.test.ts` file with a simple type annotation passed in this environment.

Pi documentation and examples inspected:

- Pi extension docs at `/home/peyton/.nvm/versions/node/v22.22.2/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` state that extensions are TypeScript modules, can be loaded from `*.ts` or directory `index.ts`, and are loaded through `jiti` so TypeScript works without compilation.
- The same docs describe extension APIs used by RalphWorks, including `pi.on`, `pi.registerCommand`, `pi.registerTool`, `pi.sendUserMessage`, `pi.appendEntry`, `ctx.newSession`, `ctx.ui.setStatus`, `ctx.ui.setWidget`, and `pi.setModel`.
- Pi package docs at `/home/peyton/.nvm/versions/node/v22.22.2/lib/node_modules/@earendil-works/pi-coding-agent/docs/packages.md` state that package manifests can declare `pi.extensions`, that conventional `extensions/` directories can load `.ts` and `.js`, and that Pi core packages imported by extensions should be listed as peer dependencies with `"*"` rather than bundled.
- Pi example docs at `/home/peyton/.nvm/versions/node/v22.22.2/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/README.md` and the `examples/extensions/with-deps` example show TypeScript extension entrypoints and a package manifest with `pi.extensions: ["./index.ts"]`.
- The installed Pi package manifest declares `types: ./dist/index.d.ts`, confirming that Pi's package exposes TypeScript declarations for extension type imports.

External web research:

- No web-search or browser tool is available in this agent environment, so official TypeScript or Node web documentation was not fetched. Requirements that depend on TypeScript or Node behavior are therefore grounded in local package evidence, Pi's installed primary documentation, and local command verification. Implementation must validate the final behavior with repository commands rather than relying on unverified external claims.

## 4. Scope

In scope:

- Rename and migrate all first-party RalphWorks runtime, test, and fixture JavaScript files to TypeScript.
- Update local import specifiers, package scripts, test scripts, documentation, and repository guidance that still point at first-party `.js` files.
- Configure TypeScript type checking for the migrated codebase without adding a JavaScript build output requirement.
- Keep Pi loading the extension from TypeScript source through the existing package-level `pi.extensions` entry.
- Migrate tests to TypeScript and keep the current Node `node:test` style unless a narrowly justified change is required for TypeScript execution.
- Preserve all current RalphWorks workflow behavior: phase state, prompts, artifacts, gates, model routing, TUI rendering, harden approval pause, session handoff, TDD task completion, and review loopbacks.
- Perform behavior-preserving cleanup and refactors where useful for type safety and maintainability.
- Update package metadata and lockfile entries needed for type checking and TypeScript-aware development.

Out of scope:

- Adding a compiled `dist/` runtime or requiring users to build before running the extension.
- Preserving `.js` entrypoint compatibility for unreleased consumers.
- Redesigning the RalphWorks workflow, adding new phases, changing phase semantics, or broadening the extension into a project management framework.
- Changing Pi's extension loader or replacing Pi APIs.
- Replacing Biome with a separate formatter/linter stack.
- Changing gate semantics, model routing semantics, or TUI design except for migration-related type-safety refactors.
- Migrating external dependency internals, generated files, `node_modules/`, `dist/`, or `coverage/`.

## 5. User Workflows

Main developer workflow:

1. A maintainer installs dependencies with `npm install`.
2. The maintainer runs `npm test` and gets TypeScript tests plus type checking as part of the validation path.
3. The maintainer runs `npm run check` and gets Biome checks plus TypeScript type checking.
4. The maintainer runs `pi -e .` or uses the configured Pi package entry and Pi loads `index.ts` directly.
5. The maintainer starts a workflow with `/ralph-works start <feature> [prompt]` and observes the same behavior as before migration.

TDD implementation workflow:

1. The implementation phase selects one task from the task list.
2. It writes or updates a TypeScript test that fails for the selected task.
3. It migrates or refactors the corresponding TypeScript source to pass the test while preserving behavior.
4. It runs the relevant focused TypeScript test, then `npm test` and `npm run check` as appropriate.
5. It marks the task complete only after tests, type checking, and any configured gates pass.

Pi operator workflow after migration:

1. The operator starts Pi with the extension enabled.
2. Pi loads the TypeScript package entry without a build step.
3. Existing RalphWorks commands, tools, prompt injection, state persistence, session handoff, and TUI updates work as documented.

## 6. Functional Requirements

1. All first-party runtime modules currently under `src/` with `.js` extensions must be migrated to TypeScript files.
2. All first-party tests and test fixtures currently under `tests/` with `.js` extensions must be migrated to TypeScript files.
3. Root first-party entrypoints must be TypeScript-only. `index.ts` must point to TypeScript source, and obsolete JavaScript entrypoint wrappers must be removed unless a later hardened spec explicitly preserves one.
4. Local ESM import specifiers must resolve to the migrated TypeScript source at runtime. No local import may point to a deleted first-party `.js` file.
5. The package must not require a compile-to-JavaScript step before Pi can load the extension or before tests can run.
6. The package must include a TypeScript configuration suitable for `noEmit` type checking of the first-party source and tests.
7. Type checking must be included in `npm run check`.
8. Type checking must also be included in `npm test`, either directly or through a script composed by `npm test`, so test validation fails on type errors.
9. Existing Biome formatting and linting must continue to apply to TypeScript files using the repository's `biome.json` conventions.
10. `npm run check:write`, `npm run format`, `npm run format:check`, and `npm run lint` must remain available and meaningful after the migration.
11. `npm run test:e2e:pi` must point to the migrated TypeScript e2e test file and preserve the existing `RALPH_WORKS_PI_E2E=1` opt-in behavior.
12. Type imports from Pi packages must be resolved for local type checking without bundling Pi core packages into the extension runtime. Pi package peer-dependency guidance must be followed when importing from `@earendil-works/pi-coding-agent`.
13. Runtime behavior must remain compatible with Pi's TypeScript extension loading model described in the Pi extension docs.
14. Type annotations must improve correctness without changing serialized workflow state shapes, artifact names, command names, tool names, marker strings, or public workflow behavior.
15. TypeScript syntax used in source and tests must be compatible with the selected direct-source runtime path. If relying on Node's native TypeScript execution for tests, avoid syntax that requires non-erasable transformation unless the implementation deliberately adds and documents a runtime loader.
16. Behavior-preserving refactors may split, rename, or simplify modules when doing so improves type safety, removes JS/TS duplication, or clarifies existing responsibilities.
17. The migration must preserve all existing tests' behavioral coverage, translated to TypeScript rather than deleted or weakened.
18. The migration must add or update tests for migration-specific behavior, including TypeScript entrypoint loading and absence of first-party JavaScript source where appropriate.
19. Documentation that instructs developers to run JavaScript test paths or preserve a JavaScript entrypoint must be updated to the TypeScript-only reality.
20. Generated JavaScript files, build directories, or compatibility shims must not be committed as part of normal runtime output.

## 7. Inputs, Outputs, And Interfaces

Inputs:

- Existing first-party source files under `src/`.
- Existing first-party test and fixture files under `tests/`.
- `package.json`, `package-lock.json`, `biome.json`, `gate.config.json`, `model.config.json`, `README.md`, and repository guidance files.
- Pi extension APIs and types exposed by `@earendil-works/pi-coding-agent`.

Outputs:

- TypeScript runtime source files under `src/`.
- TypeScript tests and fixtures under `tests/`.
- Updated `index.ts` and package scripts that reference TypeScript source and tests.
- A `tsconfig.json` or equivalent TypeScript configuration for no-emit checking.
- Updated package metadata and lockfile entries for TypeScript/type dependencies required by local validation.
- Updated documentation where first-party `.js` paths are obsolete.

Interfaces that must remain stable:

- Pi package manifest interface: `package.json` must continue to expose the extension through `pi.extensions`.
- Command interface: `/ralph-works start`, `status`, `next`, `gates`, `tdd-complete`, `artifact`, `loopback`, `approve`, `reset`, and `help` must keep their current user-facing behavior.
- Tool interface: `ralph_works_status`, `ralph_works_transition`, and `ralph_works_record_artifact` must keep their names, schemas, and result semantics.
- Workflow marker interface: `RALPH_PHASE_COMPLETE`, `RALPH_TDD_TASK_COMPLETE <task-id>`, `LGTM`, and review critical loopback markers must keep their current semantics.
- Artifact interface: generated artifacts must continue to use `docs/<feature>-...` names built from sanitized feature names.
- Configuration interfaces: `gate.config.json` and `model.config.json` must retain their current schema and behavior unless a later phase explicitly changes them.

Compatibility expectations:

- No compatibility with old first-party `.js` file paths is required.
- Compatibility with documented RalphWorks commands, tools, state, artifacts, and Pi extension behavior is required.
- External `.js` paths that refer to installed third-party/Pi internals may remain if they are still correct and are not first-party RalphWorks source.

## 8. Data, State, And Artifacts

The current generated spec artifact for this phase is `docs/typescript-migration-generated-spec.md`.

The migration must preserve existing RalphWorks runtime state structures, including:

- `extensionName`, `feature`, `promptText`, `pipelineStatus`, `phaseStatus`, `currentPhase`, `completedPhases`, `transitionHistory`, `phases`, `loopbackCount`, `gateResults`, `artifacts`, `tddCompletedTasks`, `implementationStatus`, `pendingHandoff`, and `sessionHandoffEvents`.
- Completion marker constants and harden approval status values.
- Gate result shape, implementation status shape, and session handoff descriptor/event shape.
- Persisted session custom entry types `ralph-works-state` and `ralph-works-handoff`.

The migration must preserve artifact naming rules:

- Runtime artifacts remain under `docs/` with the sanitized feature prefix.
- Existing artifact examples remain valid: `docs/<feature>-generated-spec.md`, `docs/<feature>-red-team-findings.md`, `docs/<feature>-hardened-spec.md`, `docs/<feature>-hardened-spec.html`, `docs/<feature>-task-list.md`, `docs/<feature>-implementation-status.json`, and `docs/<feature>-review-findings.md`.
- The TypeScript migration must not introduce new RalphWorks runtime artifact tracking beyond what is already useful for phase transitions, TUI display, and downstream phases.

Generated JavaScript output:

- No generated JavaScript runtime output should be committed.
- `dist/` remains ignored unless a later feature explicitly changes the packaging strategy.

## 9. Non-Functional Requirements

- Maintainability: TypeScript types should make workflow state, phase identifiers, gate results, model references, tool parameters, and Pi context usage easier to understand and safer to modify.
- Reliability: The migrated code must pass the existing behavioral test suite after tests are converted to TypeScript.
- Type safety: Avoid broad `any` usage. Use explicit interfaces, discriminated unions, `unknown` plus narrowing, or localized type assertions where appropriate.
- Runtime simplicity: The package must remain source-run and must not add a build pipeline as a prerequisite for Pi usage.
- Performance: The migration must not add meaningful runtime overhead to command handling, prompt construction, gate execution, model routing, artifact inventory, session handoff, or TUI rendering.
- Usability: Developer commands must remain simple and documented; `npm test` and `npm run check` should be enough to validate the migrated codebase.
- Compatibility: The implementation must remain ESM-compatible and runnable on the repository's current Node environment, verified locally on Node `v22.22.2` or a declared compatible engine.
- Repository clarity: Refactors should preserve the existing subsystem boundaries (`src/harness`, `src/state`, `src/artifacts`, `src/gates`, `src/models`, `src/prompts`, `src/tasks`, `src/tui`) unless a narrower structure is demonstrably clearer.

## 10. Security, Privacy, And Abuse Considerations

- The migration must not introduce new network calls, credential handling, telemetry, or external service dependencies.
- New dependencies must be limited to TypeScript/type-checking/runtime-loading needs and must be placed in the correct dependency class so Pi runtime package behavior remains safe and predictable.
- Pi extension docs state that extensions run with full system permissions; this migration must preserve existing trust boundaries and must not broaden command execution beyond current gate execution behavior.
- TypeScript source should not use dynamic `eval`, generated code execution, or runtime transpilation hooks beyond the direct-source loading mechanism needed for Pi/tests.
- Artifact inventory protections must remain intact: paths outside the workspace, symlink escapes, binary/non-UTF-8 files, and large artifacts must continue to be skipped or bounded as before.
- TUI sanitization of control characters must be preserved when migrated to TypeScript.
- Prompt-injection posture remains unchanged: artifact excerpts are still marked untrusted in handoff summaries, and agent phase skills remain responsible for substantive generated content.

## 11. Edge Cases And Failure Modes

- A first-party `.js` file remains under `src/`, `tests/`, or another code location after migration.
- A migrated TypeScript file imports a deleted `.js` file, causing Pi or Node test execution to fail at runtime.
- Type checking passes but direct runtime execution fails because the code uses TypeScript syntax unsupported by the selected source-run path.
- Direct runtime execution passes but `tsc --noEmit` fails because import extensions, module resolution, or ambient types are misconfigured.
- `@earendil-works/pi-coding-agent` types are referenced but unavailable to local type checking.
- Tests are renamed to `.ts` but `node --test` or scripts fail to discover them.
- The e2e test script still points at a deleted `.js` file.
- A fixture spawned in tests is migrated but child process calls still reference its old JavaScript path.
- Documentation, AGENTS guidance, or README examples still tell maintainers to keep JavaScript and TypeScript entrypoints aligned after JavaScript entrypoints have been removed.
- Package lock and package manifest drift after adding TypeScript/type dependencies.
- Type-driven refactors accidentally change serialized workflow state, command output, notifications, TUI labels, phase transitions, or artifact paths.
- Gate and model config validation narrows valid input beyond the current documented behavior.
- Existing skipped real-Pi e2e tests become permanently broken because they were not migrated along with unit tests.

## 12. RalphWorks Workflow Impact

The migration is mostly an implementation-language change and must not alter RalphWorks phase sequencing or controller boundaries.

Phase transitions:

- `/ralph-works start` remains the normal workflow entrypoint.
- Non-review phases still advance only from the final-line `RALPH_PHASE_COMPLETE` marker or explicit supported commands.
- `harden_spec` still pauses with `phaseStatus: "awaiting_harden_approval"` until `/ralph-works approve` or `/ralph-works approve --render-html`.
- `tdd_implement` task completion still uses `RALPH_TDD_TASK_COMPLETE <task-id>` and required gates still block completion when failing.
- Review still completes only on `LGTM` and loops back to `tdd_implement` on critical findings or `RALPH_REVIEW_CHANGES_REQUESTED`.

Gates:

- `gate.config.json` must continue to control gate behavior. The current checkout has an empty gate list, but migrated validation scripts must be suitable for use in gates if a maintainer configures `npm test` or `npm run check` as required gates.
- Type checking being part of `npm test` and `npm run check` means configured gates that call those scripts will automatically include TypeScript validation.

Models:

- `model.config.json` behavior must not change. Phase model resolution and TUI display must remain the same after type migration.

TUI:

- TUI output should look and behave the same, including status labels, phase progress, active model text, harden approval waiting instructions, handoff details, loopback visibility, and gate status.
- TypeScript types may make TUI state and gate result inputs more explicit, but must not change visible content except where tests and docs intentionally update file extensions.

Controller boundary:

- The extension remains a lightweight coordinator for phase state, TUI display, model routing, gate coordination, artifact references, and session handoff.
- Agent skills remain responsible for interviewing, spec writing, red-team review, hardening, task creation, implementation, and review decisions.

## 13. Acceptance Criteria

1. No first-party runtime source file under `src/` remains with a `.js` extension.
2. No first-party test or fixture file under `tests/` remains with a `.js` extension.
3. `index.ts` and all local imports resolve to TypeScript source rather than first-party `.js` files.
4. Obsolete duplicate JavaScript entrypoint files are removed, and no backwards-compatible `.js` wrapper is required.
5. A TypeScript no-emit configuration exists and covers runtime source, tests, fixtures, and root entrypoints.
6. `npm run check` runs Biome checks and TypeScript type checking, and fails on either lint/format issues or type errors.
7. `npm test` runs TypeScript type checking and the migrated TypeScript test suite.
8. `npm run test:e2e:pi` references the migrated TypeScript e2e test and preserves the `RALPH_WORKS_PI_E2E=1` opt-in behavior.
9. `npm run lint`, `npm run format`, `npm run format:check`, and `npm run check:write` still work on the migrated repository.
10. The migrated test suite preserves existing coverage for artifacts, gates, models, phase prompts, phase transitions, harness adapter behavior, session handoff, task status, TUI rendering, documentation wording, and e2e scaffolding.
11. A test or scripted check verifies that first-party JavaScript source/test files are not left behind, excluding ignored/generated/external directories such as `node_modules/`, `dist/`, and `coverage/`.
12. Pi can load the extension from `./index.ts` without a compile step.
13. `/ralph-works start <feature> [prompt]` still launches generate spec with skill and artifact context.
14. Marker-driven advancement, harden approval pause, optional HTML approval, TDD task completion, required gate blocking, review LGTM completion, review loopback, model routing, TUI updates, and session handoff behavior remain covered by passing tests.
15. Package metadata and lockfile include the dependencies or peer dependencies needed for TypeScript validation without bundling Pi core packages contrary to Pi package guidance.
16. README and repository guidance no longer instruct maintainers to use deleted first-party `.js` paths or preserve JavaScript entrypoint compatibility.
17. No generated JavaScript build output is committed.
18. `npm test` passes after migration, with real Pi e2e tests still skipped unless `RALPH_WORKS_PI_E2E=1` is set.
19. `npm run check` passes after migration.
20. The extension remains source-run TypeScript and does not require `npm run build` or a `dist/` package to operate.

## 14. Assumptions And Open Questions

Accepted assumptions:

- "All code" means first-party RalphWorks runtime, tests, fixtures, and repository scripts/configuration references, excluding `node_modules/`, ignored generated output, third-party installed Pi internals, and non-code artifact files.
- Because the user said no backwards compatibility is needed, JavaScript entrypoint files and `.js` local import paths may be removed instead of preserved as wrappers.
- Because the user said behavior cleanup and refactors are expected, implementation may improve module boundaries and types as long as externally visible RalphWorks behavior remains the same.
- Current local Node `v22.22.2` can execute simple `.ts` tests directly with `node --test`; implementation must still validate the final migrated test suite in the repository rather than relying only on that probe.
- TypeScript validation may add development dependencies and peer dependency metadata as needed, provided Pi core packages are not bundled contrary to Pi package guidance.

Open questions:

- None that block task creation. External official TypeScript and Node web documentation was not fetched because this environment has no web-search/browser tool; any runtime-specific choice must be verified by implementation commands and, if necessary, hardened during the red-team phase.
