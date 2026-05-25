import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function readUtf8(relativePath: string) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("package manifest exposes the TypeScript extension entrypoint", () => {
  const packageJson = JSON.parse(readUtf8("package.json"));

  assert.deepEqual(packageJson.pi?.extensions, ["./index.ts"]);
});

test("entrypoint files resolve to TypeScript source without a JavaScript wrapper", () => {
  const indexSource = readUtf8("index.ts");
  const extensionEntrySource = readUtf8("src/extension-entry.ts");

  assert.match(indexSource, /from\s+["']\.\/src\/extension-entry\.ts["']/);
  assert.match(
    extensionEntrySource,
    /from\s+["']\.\/harness\/[A-Za-z0-9-]+\.ts["']/,
  );
  assert.doesNotMatch(
    extensionEntrySource,
    /from\s+["']\.\/harness\/[A-Za-z0-9-]+\.js["']/,
  );
  assert.equal(
    fs.existsSync(path.join(repoRoot, "src/extension-entry.js")),
    false,
  );
});

test("jiti can load the TypeScript extension entrypoint without a build step", async () => {
  const jiti = createJiti(import.meta.url, { moduleCache: false });
  const loaded = await jiti.import(
    pathToFileURL(path.join(repoRoot, "index.ts")).href,
  );
  const loadedModule = loaded as { default?: unknown };
  const extension =
    typeof loaded === "function" ? loaded : loadedModule.default;

  assert.equal(typeof extension, "function");
});
