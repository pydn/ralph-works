# typescript-migration Hardened Spec

## 1. Purpose And User Value

Migrate RalphWorks from first-party JavaScript files to TypeScript source while preserving the extension's existing user-visible behavior. The successful outcome is a TypeScript-only RalphWorks codebase that Pi can load directly from source, developers can test and type-check from a clean install without a build step, and later RalphWorks phases can safely refactor implementation details without changing workflow semantics.

This migration is a language and validation migration, not a workflow redesign. Existing RalphWorks commands, tools, markers, artifact names, phase transitions, TUI labels, gate behavior, model routing, session handoff behavior, and persisted state shapes must remain stable unless a later feature explicitly changes them.

## 2. Intended Users And Context

The intended users are RalphWorks maintainers and downstream RalphWorks agent phases that will plan, implement, and review the migration. Operators still use the extension through Pi commands such as `/ralph-works start`, `/ralph-works approve`, `/ralph-works tdd-complete`, and `/ralph-works status`.

Repository context:

- The package is an ESM Node project (`"type": "module"`) with a Pi manifest that currently loads `./index.ts`.
- Most first-party runtime and test code is currently `.js`; a small TypeScript entrypoint exists at `src/extension-entry.ts` but it imports the JavaScript harness.
- There is no `tsconfig*.json` in the repository today.
- The current validation commands are `npm run check` for Biome and `npm test` for Node's built-in test runner.
- The feature is not released yet, and the user explicitly said JavaScript path compatibility does not need to be preserved.

## 3. Hardened Technical Decisions

### 3.1 Direct TypeScript execution strategy

The migration must use source-run TypeScript without compiling committed JavaScript output.

Runtime strategy:

- Pi remains the production loader for the extension.
- `package.json` must continue to expose `./index.ts` through `pi.extensions`.
- Pi documentation states that TypeScript extensions are loaded through `jiti`; RalphWorks must remain compatible with that Pi TypeScript loading path.
- No `dist/` runtime, build command, generated JavaScript wrapper, or compile-before-run step is allowed for normal Pi usage.

Test and local script strategy:

- Local tests must run `.ts` files directly with Node's built-in test runner on the repository's supported Node line.
- The migration must declare the supported Node version in package metadata or documentation. Because this environment verified Node `v22.22.2`, the default supported minimum is Node `>=22.22.2` unless implementation proves and documents a lower compatible Node version.
- Test scripts must pass explicit `.ts` test paths or globs to `node --test`; they must not rely on Node's default JavaScript test discovery.
- `npm test` must include type checking before executing tests so type errors fail validation.
- The normal test suite must include a source-load smoke test for `./index.ts` through `jiti`, because Pi uses `jiti` to load TypeScript extensions. This smoke test should assert that the default extension export can be loaded without a build step. Full real-Pi execution remains covered by the existing opt-in e2e path.

Allowed TypeScript syntax:

- Runtime source, tests, fixtures, and repository scripts must use TypeScript syntax that is compatible with direct source execution.
- Because tests run through Node native TypeScript execution, use erasable TypeScript syntax only: type annotations, interfaces, type aliases, `import type`, `export type`, generics, `satisfies`, and localized type assertions are allowed.
- Do not use TypeScript constructs that require transformation before execution, including `enum`, `const enum`, `namespace`, parameter properties, legacy decorators, TypeScript-only JSX transforms, or other non-erasable syntax.
- `tsconfig.json` must enable `erasableSyntaxOnly` or an equivalent automated guard so unsupported syntax is caught during validation.

### 3.2 Module resolution and import specifiers

The repository must use explicit source-file imports that work for both direct runtime execution and TypeScript type checking.

- All local first-party relative imports must use explicit `.ts` extensions after migration.
- No first-party local import may use a `.js` extension, point at a deleted JavaScript file, or rely on extensionless relative resolution.
- Do not introduce TypeScript `paths` or `baseUrl` aliases unless the same resolution is proven to work under Node direct test execution and Pi `jiti` loading. Prefer explicit relative `.ts` imports.
- External package imports keep their package names. External or installed Pi internals may still contain `.js` paths if those paths are not first-party RalphWorks source.
- An automated check must fail when a migrated first-party TypeScript file contains a local relative import specifier ending in `.js`.

Required `tsconfig.json` capabilities:

- `noEmit: true`.
- ESM/source-run module settings compatible with Node and explicit `.ts` imports, such as `module: "NodeNext"` and `moduleResolution: "NodeNext"`.
- `allowImportingTsExtensions: true`.
- `strict: true`.
- `verbatimModuleSyntax: true` or an equivalent setting that keeps import/export behavior explicit.
- `isolatedModules: true` and `erasableSyntaxOnly: true`, or stricter equivalent safeguards, so direct-source execution constraints are enforced.
- Node ambient types available for tests and filesystem/process code.
- Include `index.ts`, root TypeScript support files if any, `src/**/*.ts`, `tests/**/*.ts`, and migrated fixtures.
- Exclude `node_modules`, `dist`, `coverage`, generated runtime output, and generated documentation artifacts such as `docs/`.

### 3.3 Fresh-install dependency model

The package must validate correctly after a clean dependency install, not only on the current machine.

Required package metadata changes:

- Add `typescript` as a development dependency.
- Add `@types/node` as a development dependency.
- Add `jiti` as a development dependency for the entrypoint load smoke test that mirrors Pi's TypeScript extension loading mechanism.
- Update `package-lock.json` consistently with `package.json`.
- Declare the supported Node version through `engines.node` or clearly documented development requirements.

Pi package dependency rule:

- Do not add `@earendil-works/pi-coding-agent` as a bundled runtime dependency merely for type checking.
- If implementation imports runtime or type symbols from `@earendil-works/pi-coding-agent`, then `package.json` must list it as a peer dependency with `"*"` per Pi package guidance and must also provide a development-time resolution that works after `npm install` or `npm ci`.
- If implementation avoids importing Pi package types, it must define narrow local TypeScript interfaces for the Pi APIs RalphWorks actually uses and keep those interfaces covered by harness tests.

Runtime loader dependencies:

- Do not add `tsx`, `ts-node`, Babel, or a compile pipeline unless the implementation deliberately changes this hardened strategy and updates the spec through a later approved RalphWorks loop.
- The `jiti` development dependency is for smoke testing the Pi-style source load path only; it must not become a required build step or committed runtime output.

### 3.4 Behavior-preserving migration boundary

The migration must be sequenced and reviewed as behavior preserving.

- First migrate files, imports, scripts, type configuration, and tests with behavior-preserving changes only.
- Preserve existing behavioral assertions. Tests may change for TypeScript syntax, `.ts` paths, explicit import extensions, and necessary harness execution changes, but must not be weakened to accept altered behavior.
- Any intentional behavior cleanup must have its own explicit red/green test and must not change public workflow contracts unless separately approved.
- Type-driven refactors may improve module boundaries and remove JavaScript/TypeScript duplication, but serialized state shapes, TUI labels, command output, tool schemas, marker parsing, gate blocking, model routing, artifact names, and handoff summaries must remain stable.

## 4. Evidence And Research Notes

User-provided evidence and decisions:

- The migration must include every runtime, test, fixture, and configuration script currently written in `.js`, not only files under `src/`.
- The package must publish and run TypeScript source directly, without compiling TypeScript to JavaScript before execution.
- Backward-compatible JavaScript entrypoint paths are not required because the extension has not been released.
- All tests should migrate to TypeScript.
- Type checking should become part of project validation scripts.
- Behavior cleanup and refactors are expected only within the behavior-preserving boundary in this spec.

Local codebase research performed:

- `package.json` shows ESM mode, Pi extension entry `./index.ts`, scripts `check`, `check:write`, `format`, `format:check`, `lint`, `test`, and `test:e2e:pi`, and only `@biomejs/biome` as a current dev dependency.
- `index.ts` currently re-exports `./src/extension-entry.js`, so even the TypeScript package entrypoint still targets JavaScript source.
- `src/extension-entry.js` and `src/extension-entry.ts` are duplicated entrypoint wrappers; the TypeScript wrapper imports `./harness/pi-harness-adapter.js`.
- First-party JavaScript runtime files currently exist under `src/artifacts`, `src/gates`, `src/harness`, `src/models`, `src/phases`, `src/prompts`, `src/state`, `src/tasks`, and `src/tui`.
- First-party JavaScript tests and fixtures currently exist under `tests/`, including `tests/fixtures/scripted-pi-provider.js`.
- `src/harness/pi-harness-adapter.js` registers the command, tools, session events, model routing, gate execution, harden approval pause, TDD completion handling, and review loopback behavior.
- `src/state/phase-completion.js`, `src/state/phase-state.js`, and `src/state/phase-transitions.js` define the phase markers, harden approval status, initial state, legal transitions, and review loopback behavior.
- `src/artifacts/artifact-paths.js`, `src/artifacts/artifact-tracker.js`, and `src/artifacts/session-handoff-summary.js` define docs artifact naming, recorded artifacts, and durable handoff summaries.
- `src/gates/*` and `gate.config.json` show that gates remain configurable and currently default to no required gates in this checkout.
- `src/models/*` and `model.config.json` show that model routing remains configurable and currently has no phase models in this checkout.
- `src/tui/*` renders the current RalphWorks widget, including phase status, harden approval waiting state, handoff state, loopbacks, gate results, and active model display.
- `README.md` documents the current command surface, marker-driven phase flow, artifact naming under `docs/`, gate behavior, model behavior, and development commands.
- `AGENTS.md` still includes focused JavaScript test path examples and an instruction to keep JavaScript and TypeScript entrypoint wrappers aligned; those instructions must be updated after migration.
- `skills/*.md`, especially `skills/red-green-tdd-implement/SKILL.md` and `skills/review/SKILL.md`, document the division of responsibility between the extension coordinator and the agent phases.
- `tests/*.js` cover artifact paths, gate loading/running, model resolution, phase prompts, phase transitions, harness behavior, session handoff, task status, TUI rendering, documentation wording, and the real Pi e2e flow.
- `tests/pi-real-session-handoff.e2e.test.js` contains JavaScript fixture references that must be updated for first-party files, while external Pi package `dist/*.js` references may remain if they point to installed Pi internals rather than RalphWorks source.
- `.gitignore` ignores `node_modules/`, `coverage/`, and `dist/`, which supports the requirement not to commit generated JavaScript output.
- `npm test` passed locally with 112 passing tests and 2 skipped real-Pi e2e tests before migration.
- `npm run check` passed locally with Biome checking 62 files before migration.
- `node --version` reported `v22.22.2`; an empirical temporary `node --test` run against a `.test.ts` file with a simple type annotation passed in this environment.

Pi documentation and examples inspected:

- Pi extension docs state that extensions are TypeScript modules, can be loaded from `*.ts` or directory `index.ts`, and are loaded through `jiti` so TypeScript works without compilation.
- The same docs describe extension APIs used by RalphWorks, including `pi.on`, `pi.registerCommand`, `pi.registerTool`, `pi.sendUserMessage`, `pi.appendEntry`, `ctx.newSession`, `ctx.ui.setStatus`, `ctx.ui.setWidget`, and `pi.setModel`.
- Pi package docs state that package manifests can declare `pi.extensions`, that conventional `extensions/` directories can load `.ts` and `.js`, and that Pi core packages imported by extensions should be listed as peer dependencies with `"*"` rather than bundled.
- Pi examples show TypeScript extension entrypoints and a package manifest with `pi.extensions: ["./index.ts"]`.
- The installed Pi package manifest declares TypeScript declarations, confirming that Pi package types may be available when the package is installed, but this migration must not rely on globally installed packages for clean local validation.

External web research:

- No web-search or browser tool is available in this agent environment, so official TypeScript or Node web documentation was not fetched. Runtime-specific behavior must be validated by repository commands, the Pi docs installed locally, the `jiti` entrypoint smoke test, and the real-Pi e2e command when opted in.

## 5. Scope

In scope:

- Rename and migrate all first-party RalphWorks runtime, test, fixture, and repository script JavaScript files to TypeScript.
- Update every local first-party import specifier to point at `.ts` source.
- Update package scripts, test scripts, documentation, repository guidance, and documentation wording tests that still point at first-party `.js` files.
- Configure strict TypeScript no-emit type checking for migrated runtime source, tests, fixtures, and root entrypoints.
- Keep Pi loading the extension from TypeScript source through the existing package-level `pi.extensions` entry.
- Run tests directly from TypeScript source through Node's built-in test runner using explicit `.ts` test paths.
- Add a `jiti`-based entrypoint load smoke test for `./index.ts`.
- Migrate tests to TypeScript and keep the current `node:test` style unless a narrowly justified change is required for direct TypeScript execution.
- Preserve all current RalphWorks workflow behavior: phase state, prompts, artifacts, gates, model routing, TUI rendering, harden approval pause, session handoff, TDD task completion, and review loopbacks.
- Add or update tests for migration-specific invariants, including TypeScript entrypoint loading, absence of first-party JavaScript source, and absence of local first-party `.js` import specifiers.
- Update package metadata and lockfile entries needed for type checking, direct TypeScript test execution, and Pi-style load smoke testing.

Out of scope:

- Adding a compiled `dist/` runtime or requiring users to build before running the extension.
- Preserving `.js` entrypoint compatibility for unreleased consumers.
- Redesigning the RalphWorks workflow, adding new phases, changing phase semantics, or broadening the extension into a project management framework.
- Changing Pi's extension loader or replacing Pi APIs.
- Replacing Biome with a separate formatter/linter stack.
- Changing gate semantics, model routing semantics, TUI design, serialized state shapes, or artifact naming except where tests and docs intentionally update file extensions.
- Migrating external dependency internals, generated files, `node_modules/`, `dist/`, `coverage/`, or historical/generated documentation artifacts.
- Introducing `tsx`, `ts-node`, Babel, or a JavaScript build pipeline.

## 6. User Workflows

Main developer workflow:

1. A maintainer installs dependencies with `npm install` or `npm ci`.
2. The maintainer runs `npm test` and gets TypeScript no-emit checking, repository migration invariant tests, entrypoint source-load smoke testing, and the migrated TypeScript test suite.
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

## 7. Functional Requirements

1. All first-party runtime modules currently under `src/` with `.js` extensions must be migrated to TypeScript files.
2. All first-party tests and test fixtures currently under `tests/` with `.js` extensions must be migrated to TypeScript files.
3. Any first-party JavaScript repository scripts outside `src/` and `tests/` must be migrated to TypeScript or removed if obsolete.
4. Root first-party entrypoints must be TypeScript-only. `index.ts` must point to TypeScript source, and obsolete JavaScript entrypoint wrappers must be removed.
5. Local ESM import specifiers must use explicit `.ts` extensions for first-party relative imports.
6. No local first-party import may point to a deleted `.js` file.
7. The package must not require a compile-to-JavaScript step before Pi can load the extension or before tests can run.
8. The package must include a strict TypeScript `noEmit` configuration suitable for type checking first-party source, tests, fixtures, and root TypeScript entrypoints.
9. `tsconfig.json` must support explicit `.ts` import specifiers and direct-source ESM execution.
10. Type checking must be included in `npm run check`.
11. Type checking must also be included in `npm test`, before test execution.
12. Existing Biome formatting and linting must continue to apply to TypeScript files using the repository's `biome.json` conventions.
13. `npm run check:write`, `npm run format`, `npm run format:check`, and `npm run lint` must remain available and meaningful after the migration.
14. `npm run test:e2e:pi` must point to the migrated TypeScript e2e test file and preserve the existing `RALPH_WORKS_PI_E2E=1` opt-in behavior.
15. The normal test suite must include a `jiti`-based load smoke test for `./index.ts`.
16. Package metadata must include development dependencies needed for TypeScript validation from a clean install: at minimum `typescript`, `@types/node`, and `jiti`.
17. Pi package imports, if introduced, must follow Pi peer-dependency guidance and must not bundle Pi core as an ordinary runtime dependency.
18. Runtime behavior must remain compatible with Pi's TypeScript extension loading model described in the Pi extension docs.
19. Type annotations must improve correctness without changing serialized workflow state shapes, artifact names, command names, tool names, marker strings, or public workflow behavior.
20. TypeScript syntax used in source, tests, fixtures, and scripts must be compatible with direct source execution and guarded by typecheck or tests.
21. Behavior-preserving refactors may split, rename, or simplify modules when doing so improves type safety, removes JavaScript/TypeScript duplication, or clarifies existing responsibilities.
22. Existing tests' behavioral coverage must be preserved one-to-one, translated to TypeScript rather than deleted or weakened.
23. The migration must add or update tests for migration-specific behavior, including TypeScript entrypoint loading, repo-wide absence of first-party JavaScript source files, and absence of local first-party `.js` import specifiers.
24. Documentation that instructs developers or agents to run JavaScript test paths, preserve JavaScript entrypoints, or import first-party `.js` files must be updated to the TypeScript-only reality.
25. Generated JavaScript files, build directories, or compatibility shims must not be committed as part of normal runtime output.

## 8. Script And Configuration Requirements

The exact script names may include additional helper scripts, but the migrated package must provide these capabilities:

- `typecheck`: run `tsc --noEmit`.
- `check`: run Biome checks and TypeScript type checking, failing if either fails.
- `check:write`: keep Biome safe write behavior and leave the repository type-checkable after fixes.
- `test`: run TypeScript type checking and then execute the migrated `.ts` test suite with explicit test paths or globs.
- `test:e2e:pi`: run the migrated `tests/pi-real-session-handoff.e2e.test.ts` with `RALPH_WORKS_PI_E2E=1`.
- `lint`, `format`, and `format:check`: continue to run Biome on the migrated repository.

A compliant script shape is:

```json
{
  "typecheck": "tsc --noEmit",
  "check": "biome check . && npm run typecheck",
  "test": "npm run typecheck && node --test tests/*.test.ts tests/*.e2e.test.ts",
  "test:e2e:pi": "RALPH_WORKS_PI_E2E=1 node --test tests/pi-real-session-handoff.e2e.test.ts"
}
```

Implementation may add helper scripts such as `test:unit`, `test:repo-invariants`, or `test:entrypoint` if `npm test` and `npm run check` retain the required behavior.

## 9. Test Preservation Inventory

The migration must account for each existing first-party test and fixture file. Each current JavaScript file below must have the indicated TypeScript counterpart or an explicitly documented equivalent that preserves the same behavioral assertions.

| Current file | Required migrated counterpart |
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

Additional required test coverage:

- A repository invariant test or script must fail if any tracked first-party `.js`, `.mjs`, or `.cjs` source/test/script file remains outside ignored/generated/external directories such as `node_modules/`, `dist/`, and `coverage/`.
- The same or another invariant test must fail if a first-party TypeScript source, test, fixture, or script uses a local relative import ending in `.js`.
- A load smoke test must import or require `./index.ts` through `jiti` and assert that the default export is callable as a Pi extension entrypoint.
- Skipped real-Pi e2e tests must still be TypeScript, typechecked, parseable, and runnable when `RALPH_WORKS_PI_E2E=1` is set.

## 10. Inputs, Outputs, And Interfaces

Inputs:

- Existing first-party source files under `src/`.
- Existing first-party test and fixture files under `tests/`.
- Root entrypoint `index.ts` and any other first-party repository scripts.
- `package.json`, `package-lock.json`, `biome.json`, `gate.config.json`, `model.config.json`, `README.md`, `AGENTS.md`, skill documentation, and documentation wording tests.
- Pi extension APIs and, if imported, types exposed by `@earendil-works/pi-coding-agent`.

Outputs:

- TypeScript runtime source files under `src/`.
- TypeScript tests and fixtures under `tests/`.
- Updated `index.ts` and package scripts that reference TypeScript source and tests.
- A strict `tsconfig.json` for no-emit checking.
- Updated package metadata and lockfile entries for TypeScript, Node types, `jiti`, and any Pi peer/dev dependency metadata required by implementation choices.
- Updated documentation where first-party `.js` paths or JavaScript entrypoint guidance are obsolete.

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
- Documentation may mention `.js` only for clearly external paths, historical context, or examples of obsolete paths that tests intentionally guard against reintroducing.

## 11. Data, State, And Artifacts

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

## 12. Non-Functional Requirements

- Maintainability: TypeScript types should make workflow state, phase identifiers, gate results, model references, tool parameters, artifact references, and Pi context usage easier to understand and safer to modify.
- Reliability: The migrated code must pass the existing behavioral test suite after tests are converted to TypeScript.
- Type safety: `strict` TypeScript checking is required. Avoid broad `any`. Use explicit interfaces, discriminated unions, `unknown` plus narrowing for untrusted JSON/tool/config inputs, and localized type assertions where upstream Pi or Node boundaries require them.
- Runtime simplicity: The package must remain source-run and must not add a build pipeline as a prerequisite for Pi usage.
- Performance: The migration must not add meaningful runtime overhead to command handling, prompt construction, gate execution, model routing, artifact inventory, session handoff, or TUI rendering.
- Usability: Developer commands must remain simple and documented; `npm test` and `npm run check` should be enough to validate the migrated codebase.
- Compatibility: The implementation must remain ESM-compatible and runnable on the declared Node environment.
- Repository clarity: Refactors should preserve the existing subsystem boundaries (`src/harness`, `src/state`, `src/artifacts`, `src/gates`, `src/models`, `src/prompts`, `src/tasks`, `src/tui`) unless a narrower structure is demonstrably clearer and covered by tests.

If any strict compiler option must be deferred, the implementation must document the exact option, why it is deferred, and what test coverage compensates for the deferral. `strict: true`, `noEmit: true`, and explicit `.ts` import support may not be deferred.

## 13. Security, Privacy, And Abuse Considerations

- The migration must not introduce new network calls, credential handling, telemetry, or external service dependencies.
- New dependencies must be limited to TypeScript, Node types, `jiti` load smoke testing, and optional Pi type/development resolution. They must be placed in the correct dependency class so Pi runtime package behavior remains safe and predictable.
- Pi extension docs state that extensions run with full system permissions; this migration must preserve existing trust boundaries and must not broaden command execution beyond current gate execution behavior.
- TypeScript source should not use dynamic `eval`, generated code execution, or runtime transpilation hooks beyond Pi's existing `jiti` loader and the development-only entrypoint load smoke test.
- Artifact inventory protections must remain intact: paths outside the workspace, symlink escapes, binary/non-UTF-8 files, and large artifacts must continue to be skipped or bounded as before.
- TUI sanitization of control characters must be preserved when migrated to TypeScript.
- Prompt-injection posture remains unchanged: artifact excerpts are still marked untrusted in handoff summaries, and agent phase skills remain responsible for substantive generated content.

## 14. Edge Cases And Failure Modes

- A first-party `.js`, `.mjs`, or `.cjs` file remains under `src/`, `tests/`, root scripts, fixtures, or another tracked code location after migration.
- A migrated TypeScript file imports a deleted `.js` file, causing Pi or Node test execution to fail at runtime.
- Type checking passes but direct runtime execution fails because the code uses TypeScript syntax unsupported by Node native TypeScript execution.
- Node tests pass but Pi-style source loading fails because `./index.ts` is not compatible with `jiti`.
- Direct runtime execution passes but `tsc --noEmit` fails because import extensions, module resolution, or ambient types are misconfigured.
- `@earendil-works/pi-coding-agent` types are referenced but unavailable to local type checking after a clean install.
- Tests are renamed to `.ts` but `node --test` scripts fail to discover them because scripts still rely on JavaScript default discovery.
- The e2e test script still points at a deleted `.js` file.
- A fixture spawned in tests is migrated but child process calls still reference its old JavaScript path.
- Documentation, AGENTS guidance, skills, or README examples still tell maintainers to keep JavaScript and TypeScript entrypoints aligned or run deleted `.js` test paths.
- Package lock and package manifest drift after adding TypeScript/type dependencies.
- Type-driven refactors accidentally change serialized workflow state, command output, notifications, TUI labels, phase transitions, or artifact paths.
- Gate and model config validation narrows valid input beyond the current documented behavior.
- Existing skipped real-Pi e2e tests become permanently broken because they were not migrated along with unit tests.
- A repository invariant check incorrectly flags external installed Pi `dist/*.js` paths; checks must distinguish first-party source from external references.

## 15. RalphWorks Workflow Impact

The migration is an implementation-language change and must not alter RalphWorks phase sequencing or controller boundaries.

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

## 16. Documentation Requirements

The migration must update documentation and repository guidance that refer to first-party JavaScript paths or JavaScript entrypoint compatibility.

Required documentation targets:

- `README.md`: developer commands, test command examples, any first-party file path examples, and TypeScript source-run expectations.
- `AGENTS.md`: focused test examples must use `.ts` paths, and the instruction to keep `src/extension-entry.js` and `src/extension-entry.ts` aligned must be removed or replaced with TypeScript-only entrypoint guidance.
- `package.json` scripts: no script may target a deleted first-party `.js` file.
- Skill documentation under `skills/`: update only if it references first-party JavaScript paths or obsolete validation commands.
- Documentation wording tests: preserve their intent while updating expected strings for TypeScript paths and TypeScript validation.

Documentation may still mention external Pi internals with `.js` paths only when those paths point outside first-party RalphWorks source and remain valid.

## 17. Acceptance Criteria

1. No tracked first-party runtime source file under `src/` remains with a `.js`, `.mjs`, or `.cjs` extension.
2. No tracked first-party test or fixture file under `tests/` remains with a `.js`, `.mjs`, or `.cjs` extension.
3. No tracked first-party repository script remains as JavaScript outside ignored/generated/external directories.
4. `index.ts` and all local first-party imports resolve to TypeScript source rather than first-party `.js` files.
5. Obsolete duplicate JavaScript entrypoint files are removed, and no backwards-compatible `.js` wrapper is required.
6. A strict TypeScript no-emit configuration exists and covers runtime source, tests, fixtures, and root TypeScript entrypoints.
7. `tsconfig.json` permits explicit `.ts` import specifiers and enforces direct-source-compatible TypeScript syntax.
8. `npm run check` runs Biome checks and TypeScript type checking, and fails on either lint/format issues or type errors.
9. `npm test` runs TypeScript type checking and the migrated TypeScript test suite with explicit `.ts` test paths.
10. `npm test` includes repository invariant coverage for absence of first-party JavaScript files and local first-party `.js` import specifiers.
11. `npm test` includes a `jiti` source-load smoke test for `./index.ts`.
12. `npm run test:e2e:pi` references the migrated TypeScript e2e test and preserves the `RALPH_WORKS_PI_E2E=1` opt-in behavior.
13. `npm run lint`, `npm run format`, `npm run format:check`, and `npm run check:write` still work on the migrated repository.
14. The migrated test suite preserves existing coverage for artifacts, gates, models, phase prompts, phase transitions, harness adapter behavior, session handoff, task status, TUI rendering, documentation wording, and e2e scaffolding.
15. Each existing `tests/*.js` and `tests/fixtures/*.js` file has a migrated `.ts` counterpart or explicitly documented equivalent preserving the same assertions.
16. Pi can load the extension from `./index.ts` without a compile step, verified by the `jiti` smoke test and by the opt-in real-Pi e2e path when available.
17. `/ralph-works start <feature> [prompt]` still launches generate spec with skill and artifact context.
18. Marker-driven advancement, harden approval pause, optional HTML approval, TDD task completion, required gate blocking, review LGTM completion, review loopback, model routing, TUI updates, and session handoff behavior remain covered by passing tests.
19. Package metadata and lockfile include the dependencies or peer dependencies needed for TypeScript validation without bundling Pi core packages contrary to Pi package guidance.
20. A clean install path such as `npm ci` or `npm install` provides all dependencies needed for `npm test` and `npm run check`.
21. README, AGENTS guidance, package scripts, relevant skill references, and documentation wording tests no longer instruct maintainers to use deleted first-party `.js` paths or preserve JavaScript entrypoint compatibility.
22. No generated JavaScript build output is committed.
23. `npm test` passes after migration, with real Pi e2e tests still skipped unless `RALPH_WORKS_PI_E2E=1` is set.
24. `npm run check` passes after migration.
25. The extension remains source-run TypeScript and does not require `npm run build` or a `dist/` package to operate.

## 18. Assumptions And Open Questions

Accepted assumptions:

- "All code" means first-party RalphWorks runtime, tests, fixtures, root entrypoints, and repository scripts/configuration references, excluding `node_modules/`, ignored generated output, third-party installed Pi internals, and non-code artifact files.
- Because the user said no backwards compatibility is needed, JavaScript entrypoint files and `.js` local import paths may be removed instead of preserved as wrappers.
- Because the user said behavior cleanup and refactors are expected, implementation may improve module boundaries and types as long as externally visible RalphWorks behavior remains the same and any intentional cleanup has explicit tests.
- Current local Node `v22.22.2` can execute simple `.ts` tests directly with `node --test`; implementation must validate the final migrated test suite rather than relying only on that probe.
- TypeScript validation may add development dependencies and peer dependency metadata as needed, provided Pi core packages are not bundled contrary to Pi package guidance.

Open questions:

- None that block task creation. External official TypeScript and Node web documentation was not fetched because this environment has no web-search/browser tool; runtime-specific behavior must be verified by implementation commands and the required entrypoint smoke/e2e tests.
