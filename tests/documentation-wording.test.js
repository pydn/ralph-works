import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

function readText(filePath) {
  return readFileSync(filePath, "utf8");
}

test("README describes fresh-session handoff instead of compaction", () => {
  const readme = readText("README.md");

  assert.match(readme, /fresh Pi session handoff/i);
  assert.match(readme, /ctx\.newSession\(\{ withSession \}\)/);
  assert.doesNotMatch(readme, /\bcompaction\b/i);
  assert.doesNotMatch(readme, /task-level compaction/i);
});

test("phase skills do not promise compaction at task or phase boundaries", () => {
  const skillFiles = readdirSync("skills", { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join("skills", entry.name, "SKILL.md"));

  for (const skillFile of skillFiles) {
    const skill = readText(skillFile);
    assert.doesNotMatch(skill, /\bcompaction\b/i, skillFile);
    assert.doesNotMatch(skill, /\bcompact\b/i, skillFile);
  }

  const tddSkill = readText("skills/red-green-tdd-implement/SKILL.md");
  assert.match(tddSkill, /fresh Pi session handoff/i);
});
