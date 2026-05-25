# typescript-migration Red Team Findings

## Overall Assessment

The generated spec is strong on desired outcomes, but several requirements are still too ambiguous for safe task creation. The largest risks are around direct TypeScript execution, import extension semantics, fresh-install dependency behavior, and preventing a behavior-changing refactor from being hidden inside a language migration.

## Critical Findings

### 1. Direct TypeScript execution strategy is not decided precisely enough

**Risk:** The spec says Pi loads TypeScript through `jiti`, while tests may rely on Node's native TypeScript execution. Those are different runtime paths. A migration could pass `tsc --noEmit` but fail under Pi, or pass a simple `node --test` probe but fail once source/tests use TypeScript features that need runtime transformation. This is a blocker because every import, script, fixture spawn, and allowed TypeScript syntax depends on this decision.

**Impact:** Implementation tasks may produce `.ts` files that are type-correct but not executable by the selected runtime. Failures would surface late in Pi loading, e2e tests, child-process fixtures, or skipped real-Pi paths.

**Recommended spec change:** Harden the spec to choose and document one explicit source-run strategy for tests and scripts before task creation:

- If using Node native TypeScript execution, declare the minimum supported Node version, require explicit `node --test` paths/globs for `.test.ts`, update child-process fixture invocations, and forbid non-erasable TypeScript syntax such as `enum`, `namespace`, parameter properties, decorators, and other constructs that need transpilation.
- If using a loader such as `tsx` or `jiti` for tests, name it explicitly, add it as a development dependency only, update scripts consistently, and explain why this still satisfies the no-build requirement.
- Require a smoke test that verifies `./index.ts` loads through the same mechanism Pi will use, not only through `tsc`.

### 2. Local import specifier and `tsconfig` rules are underspecified

**Risk:** The spec requires local imports to resolve to migrated TypeScript source, but it does not state the exact import-extension policy or TypeScript compiler options needed for source-run ESM. In a no-emit TypeScript package, `.js` specifiers point at deleted files, while `.ts` specifiers require compatible compiler settings such as `allowImportingTsExtensions`.

**Impact:** The repository could end up in a state where Pi or Node can run the code but `tsc --noEmit` fails, or type checking passes but runtime resolution fails. This would directly violate the core acceptance criteria.

**Recommended spec change:** Add a concrete module-resolution requirement:

- All local first-party imports must use explicit `.ts` extensions after migration.
- `tsconfig.json` must be configured for no-emit ESM/source execution and must permit `.ts` import specifiers.
- `tsconfig.json` must include `index.ts`, `src/**/*.ts`, `tests/**/*.ts`, and test fixtures, while excluding `node_modules`, `dist`, `coverage`, and generated artifacts.
- Add an automated check that fails on local first-party `.js` import specifiers after migration.

### 3. Fresh-install dependency model is not hardened

**Risk:** The spec says to add TypeScript/type dependencies as needed and to follow Pi peer-dependency guidance, but it does not define the package manifest outcome. A clean `npm install` may not install `typescript`, Node ambient types, or Pi package types needed for local type checking. Conversely, adding Pi core as a runtime dependency could conflict with Pi packaging guidance.

**Impact:** Validation may pass only on the current machine because globally installed Pi packages or cached modules are present. Downstream maintainers could fail `npm run check` on a fresh checkout, or the extension could accidentally bundle Pi internals.

**Recommended spec change:** State the expected dependency classes explicitly:

- Add `typescript` and `@types/node` as development dependencies.
- If RalphWorks imports types from `@earendil-works/pi-coding-agent`, list the Pi package as a peer dependency with `"*"` per Pi docs and also provide a development-time resolution path that works after a clean `npm install`.
- If a TypeScript runtime loader is selected for tests, add it only as a development dependency.
- Require `package-lock.json` to be updated and validated from a clean install path.

### 4. The no-JavaScript requirement is not broad enough to prevent leftovers

**Risk:** Some acceptance criteria focus on `src/` and `tests/`, while the user asked to migrate all first-party code currently written in `.js`. Root scripts, fixtures, helper files, or future first-party JavaScript files outside those directories could remain undetected.

**Impact:** The migration could satisfy the letter of several criteria while still leaving first-party JavaScript code in the repository, undermining the TypeScript-only goal and creating confusing maintenance paths.

**Recommended spec change:** Define the first-party JavaScript exclusion check repo-wide:

- Fail if any tracked first-party `.js` file remains outside ignored/generated/external directories such as `node_modules`, `dist`, and `coverage`.
- Explicitly include root entrypoints, tests, fixtures, local scripts, and package-script targets in this check.
- Exclude documentation artifacts only if the check is file-extension based rather than text-reference based; documentation text may still mention historical `.js` paths only where clearly marked as historical or external.

## Warnings

### 5. Behavior-preserving refactor boundaries are too loose

**Risk:** The spec permits cleanup, splitting, renaming, and simplification during the migration. Without tighter sequencing, an implementation could alter workflow semantics while presenting the change as type cleanup.

**Impact:** Serialized state shapes, TUI labels, command/tool schemas, marker parsing, gate blocking, model routing, or artifact naming could drift. Tests might be updated to match the new behavior rather than preserving the old behavior.

**Recommended spec change:** Require task planning to separate mechanical migration from behavioral cleanup:

- First migrate files, imports, scripts, and type checking with behavior-preserving changes only.
- Preserve existing behavioral assertions; only update tests for TypeScript syntax, imports, file extensions, and necessary harness execution changes.
- Any intentional behavior cleanup must have its own explicit red/green test and must not change public workflow contracts unless separately approved.

### 6. Test preservation criteria need a stronger one-to-one conversion guard

**Risk:** The spec says coverage must be preserved, but it does not require a one-to-one accounting of existing tests and fixtures. During a large rename, skipped e2e tests or brittle harness tests could be accidentally dropped, weakened, or left unexecutable.

**Impact:** The migration may appear green while losing regression coverage for phase transitions, handoff, gates, TUI rendering, or real-Pi scaffolding.

**Recommended spec change:** Require the task list or implementation status to account for each existing `tests/*.js` and `tests/fixtures/*.js` file and identify its migrated `.ts` counterpart. Skipped real-Pi e2e tests should still be typechecked and parseable, and `npm run test:e2e:pi` must exercise the migrated path when opted in.

### 7. Type-safety expectations are too easy to satisfy with weak annotations

**Risk:** The spec says to avoid broad `any`, but without compiler strictness or reviewable limits the migration could become JavaScript with `.ts` extensions and widespread implicit `any` or unchecked casts.

**Impact:** The user gets less type-safety value than expected, and future workflow changes remain fragile despite adding `tsc`.

**Recommended spec change:** Require `strict` TypeScript checking unless a specific option is deliberately deferred with justification. Require `unknown` plus narrowing for untrusted JSON/tool/config inputs and localized type assertions for Pi harness boundaries where upstream types are incomplete.

### 8. Documentation update scope should include repository guidance and scripts explicitly

**Risk:** The generated spec mentions README and guidance, but current repository instructions and examples include direct JavaScript test paths and entrypoint-alignment guidance. If not updated, future agents may follow obsolete instructions after the migration.

**Impact:** Maintainers and future RalphWorks phases could run deleted `.js` paths or reintroduce JavaScript wrappers.

**Recommended spec change:** Add an explicit documentation acceptance item covering `README.md`, `AGENTS.md`, package scripts, skill references, and tests that assert documentation wording. Documentation should distinguish first-party paths from external Pi `dist/*.js` paths that may remain valid.
