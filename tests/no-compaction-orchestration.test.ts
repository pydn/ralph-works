import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");
const RETIRED_COMPACTION_FILES = [
  "src/harness/pi-compaction-trigger.js",
  "src/artifacts/compaction-summary.js",
  "tests/compaction-summary.test.js",
];
const FORBIDDEN_SOURCE_PATTERNS = [
  /triggerRalphWorksCompaction/,
  /recordCompactionEvent/,
  /ctx\.compact\s*\(/,
  /from "\.\.\/artifacts\/compaction-summary\.js"/,
  /from "\.\/pi-compaction-trigger\.js"/,
];

function listJavaScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return listJavaScriptFiles(entryPath);
    }
    return /\.[cm]?[jt]s$/.test(entry.name) ? [entryPath] : [];
  });
}

test("RalphWorks source and tests no longer include compaction orchestration", () => {
  for (const retiredPath of RETIRED_COMPACTION_FILES) {
    assert.equal(
      existsSync(path.join(REPOSITORY_ROOT, retiredPath)),
      false,
      `${retiredPath} should be removed`,
    );
  }

  const scannedDirectories = ["src", "tests"];
  for (const directory of scannedDirectories) {
    for (const filePath of listJavaScriptFiles(
      path.join(REPOSITORY_ROOT, directory),
    )) {
      if (filePath === import.meta.filename || !statSync(filePath).isFile()) {
        continue;
      }
      const relativePath = path.relative(REPOSITORY_ROOT, filePath);
      const text = readFileSync(filePath, "utf8");
      for (const pattern of FORBIDDEN_SOURCE_PATTERNS) {
        assert.equal(
          pattern.test(text),
          false,
          `${relativePath} still matches ${pattern}`,
        );
      }
    }
  }
});
