import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const skill = readFileSync(
  path.join(process.cwd(), "skills", "generate-spec", "SKILL.md"),
  "utf8",
);

test("generate-spec skill requires an interview before research or drafting", () => {
  assert.match(skill, /required interview and research process/);
  assert.match(skill, /Round 1 must ask interview questions only/);
  assert.match(
    skill,
    /Do not produce the spec on the first generate-spec turn/,
  );
});

test("generate-spec skill requires codebase and documentation research after round 1", () => {
  assert.match(skill, /After the user answers Round 1, conduct research/);
  assert.match(skill, /Review the existing codebase first/);
  assert.match(skill, /perform relevant web searches/);
  assert.match(skill, /official or primary documentation/);
});

test("generate-spec skill requires evidence-backed specifications without assumptions", () => {
  assert.match(skill, /Make no assumptions about current code behavior/);
  assert.match(skill, /Do not treat unverified assumptions as fact/);
  assert.match(skill, /Evidence And Research Notes/);
  assert.match(skill, /cite the supporting evidence/);
});

test("generate-spec skill asks follow-up questions only after research when ambiguity remains", () => {
  assert.match(
    skill,
    /If material ambiguities remain after research, ask targeted follow-up questions/,
  );
  assert.match(skill, /Do not ask follow-up questions before researching/);
  assert.match(skill, /If research resolves the ambiguity/);
});

test("generate-spec skill gates drafting on a readiness checklist", () => {
  assert.match(
    skill,
    /Before drafting the specification, verify the readiness checklist/,
  );
  assert.match(skill, /Goal and user value are clear/);
  assert.match(skill, /Relevant codebase behavior has been checked/);
  assert.match(skill, /Relevant external documentation has been checked/);
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
    "## 3. Evidence And Research Notes",
    "## 4. Scope",
    "## 5. User Workflows",
    "## 6. Functional Requirements",
    "## 7. Inputs, Outputs, And Interfaces",
    "## 8. Data, State, And Artifacts",
    "## 9. Non-Functional Requirements",
    "## 10. Security, Privacy, And Abuse Considerations",
    "## 11. Edge Cases And Failure Modes",
    "## 12. RalphWorks Workflow Impact",
    "## 13. Acceptance Criteria",
    "## 14. Assumptions And Open Questions",
  ];

  for (const header of requiredHeaders) {
    assert.match(skill, new RegExp(escapeRegExp(header)));
  }
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
