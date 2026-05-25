import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonObject(filePath: string): JsonObject {
  const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));

  if (!isJsonObject(parsed)) {
    throw new TypeError(`${filePath} must contain a JSON object`);
  }

  return parsed;
}

function getObject(parent: JsonObject, key: string): JsonObject {
  const value = parent[key];

  if (!isJsonObject(value)) {
    throw new TypeError(`${key} must be a JSON object`);
  }

  return value;
}

function getString(parent: JsonObject, key: string): string {
  const value = parent[key];

  if (typeof value !== "string") {
    throw new TypeError(`${key} must be a string`);
  }

  return value;
}

function getStringArray(parent: JsonObject, key: string): string[] {
  const value = parent[key];

  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new TypeError(`${key} must be a string array`);
  }

  return value;
}

function assertScriptUsesTypeScriptTestPaths(
  scriptName: string,
  command: string,
): void {
  assert.match(command, /node --test/);
  assert.doesNotMatch(command, /\.test\.js\b/);
  assert.doesNotMatch(command, /\.e2e\.test\.js\b/);
  assert.doesNotMatch(command, /scripted-pi-provider\.js\b/);
  assert.ok(
    command.includes(".test.ts") || command.includes("*.test.ts"),
    `${scriptName} must target TypeScript test files`,
  );
}

test("package scripts enforce the final TypeScript validation contract", () => {
  const packageJson = readJsonObject("package.json");
  const scripts = getObject(packageJson, "scripts");

  assert.equal(getString(scripts, "typecheck"), "tsc --noEmit");
  assert.equal(
    getString(scripts, "test"),
    "npm run typecheck && node --test tests/*.test.ts tests/*.e2e.test.ts",
  );
  assert.equal(
    getString(scripts, "check"),
    "npm run typecheck && biome check .",
  );
  assert.equal(
    getString(scripts, "test:e2e:pi"),
    "RALPH_WORKS_PI_E2E=1 node --test tests/pi-real-session-handoff.e2e.test.ts",
  );

  assertScriptUsesTypeScriptTestPaths("test", getString(scripts, "test"));
  assertScriptUsesTypeScriptTestPaths(
    "test:e2e:pi",
    getString(scripts, "test:e2e:pi"),
  );

  assert.match(getString(scripts, "check:write"), /^biome check --write \.$/);
  assert.match(getString(scripts, "format"), /^biome format --write \.$/);
  assert.match(getString(scripts, "format:check"), /^biome format \.$/);
  assert.match(getString(scripts, "lint"), /^biome lint \.$/);
});

test("tsconfig covers source-run TypeScript without temporary migration allowances", () => {
  const tsconfig = readJsonObject("tsconfig.json");
  const compilerOptions = getObject(tsconfig, "compilerOptions");
  const include = getStringArray(tsconfig, "include");
  const exclude = getStringArray(tsconfig, "exclude");

  assert.equal(compilerOptions.noEmit, true);
  assert.equal(compilerOptions.strict, true);
  assert.equal(compilerOptions.module, "NodeNext");
  assert.equal(compilerOptions.moduleResolution, "NodeNext");
  assert.equal(compilerOptions.allowImportingTsExtensions, true);
  assert.equal(compilerOptions.isolatedModules, true);
  assert.equal(compilerOptions.erasableSyntaxOnly, true);
  assert.equal(compilerOptions.verbatimModuleSyntax, true);
  assert.deepEqual(compilerOptions.types, ["node"]);

  assert.ok(
    include.includes("index.ts"),
    "tsconfig must include the extension entrypoint",
  );
  assert.ok(
    include.includes("*.ts"),
    "tsconfig must include root TypeScript support files",
  );
  assert.ok(
    include.includes("src/**/*.ts"),
    "tsconfig must include runtime source",
  );
  assert.ok(
    include.includes("tests/**/*.ts"),
    "tsconfig must include tests and fixtures",
  );

  for (const ignoredDirectory of ["node_modules", "dist", "coverage", "docs"]) {
    assert.ok(
      exclude.includes(ignoredDirectory),
      `tsconfig must exclude ${ignoredDirectory}`,
    );
  }
});
