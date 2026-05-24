import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const skill = readFileSync(
  path.join(process.cwd(), "skills", "generate-spec", "SKILL.md"),
  "utf8",
);

test("generate-spec skill requires a multi-round interview before drafting", () => {
  assert.match(skill, /required multi-round process/);
  assert.match(skill, /Round 1 must ask interview questions only/);
  assert.match(skill, /Round 2 is also required before drafting/);
  assert.match(skill, /Do not draft the specification yet/);
});

test("generate-spec skill gates drafting on a readiness checklist", () => {
  assert.match(
    skill,
    /Before drafting the specification, verify the readiness checklist/,
  );
  assert.match(skill, /Goal and user value are clear/);
  assert.match(skill, /Acceptance criteria are testable/);
  assert.match(skill, /Remaining assumptions are explicitly named/);
});

test("generate-spec skill allows bounded follow-up rounds for unresolved material unknowns", () => {
  assert.match(
    skill,
    /Additional rounds are required when material unknowns remain/,
  );
  assert.match(skill, /Normal interviews should stop after four rounds/);
  assert.match(skill, /explicitly accepted the assumptions/);
});

test("generate-spec skill defines the generated specification headers", () => {
  const requiredHeaders = [
    "# <Feature Name> Generated Spec",
    "## 1. Purpose And User Value",
    "## 2. Intended Users And Context",
    "## 3. Scope",
    "## 4. User Workflows",
    "## 5. Functional Requirements",
    "## 6. Inputs, Outputs, And Interfaces",
    "## 7. Data, State, And Artifacts",
    "## 8. Non-Functional Requirements",
    "## 9. Security, Privacy, And Abuse Considerations",
    "## 10. Edge Cases And Failure Modes",
    "## 11. RalphWorks Workflow Impact",
    "## 12. Acceptance Criteria",
    "## 13. Assumptions And Open Questions",
  ];

  for (const header of requiredHeaders) {
    assert.match(skill, new RegExp(escapeRegExp(header)));
  }
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
