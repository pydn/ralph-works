import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  findDisallowedJavaScriptFiles,
  findLocalJavaScriptImportSpecifiers,
  findRepositoryInvariantViolations,
} from "./repository-invariant-checks.ts";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");

test("JavaScript file invariant flags first-party files and ignores generated or external files", () => {
  assert.deepEqual(
    findDisallowedJavaScriptFiles([
      "src/old-runtime.js",
      "src/tooling/runner.mjs",
      "tests/fixtures/old-provider.cjs",
      "scripts/local-maintenance.js",
      "node_modules/package/index.js",
      "dist/generated-wrapper.js",
      "coverage/report.js",
      "docs/typescript-migration-generated-artifact.js",
      ".git/hooks/pre-commit.js",
      "src/current-source.ts",
    ]),
    [
      "scripts/local-maintenance.js",
      "src/old-runtime.js",
      "src/tooling/runner.mjs",
      "tests/fixtures/old-provider.cjs",
    ],
  );
});

test("local .js import invariant only flags actual TypeScript import specifiers", () => {
  const jsExtension = ".js";
  const violations = findLocalJavaScriptImportSpecifiers([
    {
      relativePath: "src/example.ts",
      text: [
        `import runtime from "./old-runtime${jsExtension}";`,
        `import type { Types } from "../types${jsExtension}";`,
        `import ok from "./current-source.ts";`,
        `export { runtime } from "./exported-runtime${jsExtension}";`,
        `export * from "../shared${jsExtension}";`,
        `const dynamicModule = import("./dynamic${jsExtension}");`,
        `type LazyTypes = import("./lazy-types${jsExtension}").LazyTypes;`,
        `const stringLiteral = "./not-an-import${jsExtension}";`,
        `const externalPackage = import("package/subpath${jsExtension}");`,
        "void dynamicModule;",
        "void externalPackage;",
        "void ok;",
      ].join("\n"),
    },
  ]);

  assert.deepEqual(
    violations.map(({ relativePath, specifier }) => {
      return `${relativePath}:${specifier}`;
    }),
    [
      "src/example.ts:./old-runtime.js",
      "src/example.ts:../types.js",
      "src/example.ts:./exported-runtime.js",
      "src/example.ts:../shared.js",
      "src/example.ts:./dynamic.js",
      "src/example.ts:./lazy-types.js",
    ],
  );
  assert.equal(
    violations.every(({ line, column }) => line > 0 && column > 0),
    true,
  );
});

test("repository has no first-party JavaScript source, test, fixture, or script files", () => {
  const violations = findRepositoryInvariantViolations(REPOSITORY_ROOT);

  assert.deepEqual(violations.disallowedJavaScriptFiles, []);
});

test("TypeScript files do not use local relative .js import specifiers", () => {
  const violations = findRepositoryInvariantViolations(REPOSITORY_ROOT);

  assert.deepEqual(violations.localJavaScriptImportSpecifiers, []);
});
