import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

function readText(filePath: string) {
  return readFileSync(filePath, "utf8");
}

test("README describes fresh-session handoff instead of compaction", () => {
  const readme = readText("README.md");

  assert.match(readme, /fresh Pi session handoff/i);
  assert.match(readme, /ctx\.newSession\(\{ withSession \}\)/);
  assert.doesNotMatch(readme, /\bcompaction\b/i);
  assert.doesNotMatch(readme, /task-level compaction/i);
});

test("repository docs describe the TypeScript source-run workflow", () => {
  const readme = readText("README.md");
  const agents = readText("AGENTS.md");

  assert.match(readme, /TypeScript source/i);
  assert.match(readme, /Node >=22\.22\.2/i);
  assert.match(readme, /npm run typecheck/);
  assert.match(
    readme,
    /node --test tests\/\*\.test\.ts tests\/\*\.e2e\.test\.ts/,
  );

  assert.match(
    agents,
    /node --test tests\/package-validation-contract\.test\.ts/,
  );
  assert.match(agents, /fresh Pi session handoff/i);
  assert.doesNotMatch(agents, /\.test\.js\b/);
  assert.doesNotMatch(agents, /src\/extension-entry\.js/);
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
