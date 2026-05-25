---
name: generate-spec
description: Use during the RalphWorks generate_spec phase to convert the user's initial prompt and clarifications into a complete working feature specification for the Pi agent workflow.
---

# Generate Spec

Use this skill for the `generate_spec` phase of the RalphWorks Pi extension.

## Purpose

Your job is to turn the user's upfront prompt into a complete working feature specification. This is the first phase in the Ralph loop, so the quality of this output affects every later phase: red-team review, hardening, task creation, red-green TDD implementation, and final review. The extension coordinates the phase, displays it in the TUI, routes the configured model, and tracks the artifact. You perform the phase work.

Keep the work lightweight, explicit, and easy to understand. The goal is not to create a project management system or an implementation framework. The goal is to resolve the user's intent into a spec that later phases can inspect and act on.

## Inputs

- Initial user prompt.
- Clarification answers from the user.
- Any existing context the Pi agent harness gives you for this phase.

## Process

Start by reading the prompt carefully and identifying ambiguity. You must interview the user before researching or drafting the specification, even when the prompt appears clear. Do not produce the spec on the first generate-spec turn. Ask targeted clarifying questions that confirm the user's intent, constraints, acceptance criteria, workflow expectations, and any risky assumptions.

The interview and research flow is a required interview and research process:

1. Round 1 must ask interview questions only. Ask four to seven targeted questions that establish the user's goal, intended users or audience, in-scope and out-of-scope behavior, expected outputs, important constraints, risk areas, and acceptance criteria. Do not include a partial spec, task list, implementation plan, or acceptance criteria draft in this first round.
2. After the user answers Round 1, conduct research before asking follow-up questions or drafting the spec. Review the existing codebase first: inspect relevant source files, tests, docs, configuration, prompts, skills, scripts, and artifact patterns before deciding what the spec should require. When the feature depends on a library, framework, platform, API, standard, or current external behavior, perform relevant web searches for official or primary documentation. Prefer primary sources over tutorials, snippets, or summaries.
3. If material ambiguities remain after research, ask targeted follow-up questions based on the user's answers, the original prompt, and the discovered evidence. Do not ask follow-up questions before researching. If research resolves the ambiguity and the readiness checklist is satisfied, proceed to the spec without forcing another question round.
4. Additional rounds are required when material unknowns remain after the first post-research follow-up. Continue with short follow-up rounds of one to four questions until the readiness checklist below is satisfied, the user explicitly accepts named assumptions, or a real blocker prevents a useful spec. Normal interviews should stop after four rounds unless the user explicitly wants to continue.

Keep every interview round concise and relevant. Do not ask broad, decorative, or curiosity-driven questions. If a topic is already strongly implied, ask for confirmation rather than leaving it unstated. Prefer questions that force a decision, expose a tradeoff, or confirm a risky assumption. Do not repeat questions already answered unless the answer conflicts with another requirement.

## Research And Evidence

Make no assumptions about current code behavior, repository conventions, external documentation, API semantics, available commands, or dependency behavior. Do not treat unverified assumptions as fact. If a claim matters to the spec, verify it through the user's answers, local codebase evidence, official or primary documentation, or explicitly label it as an assumption that needs user acceptance.

Back the spec with evidence. Record which local files, tests, docs, configs, prompts, or scripts were inspected when they are relevant. Record which official or primary documentation sources were checked when web research is relevant. If web research is not relevant, unavailable, or blocked, say so plainly and do not invent external facts. If codebase research is limited by missing files or tool access, state that limitation and avoid claiming certainty.

Use evidence to narrow the spec, not to broaden it into unrelated improvements. When a requirement depends on current implementation behavior, cite the supporting evidence in the generated spec. When a requirement depends on external documentation, cite the supporting evidence from the relevant documentation. Distinguish direct evidence from inference and accepted assumptions.

Before drafting the specification, verify the readiness checklist:

- Goal and user value are clear.
- Intended users, operators, or downstream readers are clear.
- In-scope behavior and out-of-scope boundaries are clear.
- Important inputs, outputs, artifacts, and workflow effects are clear.
- Constraints, dependencies, gate expectations, model expectations, and TUI expectations are clear when relevant.
- Relevant codebase behavior has been checked, with important files, tests, docs, configs, prompts, scripts, and artifact patterns cited when they affect the spec.
- Relevant external documentation has been checked when the feature depends on a library, platform, API, standard, or current external behavior; otherwise the spec explains why web research was not relevant or available.
- Edge cases, failure modes, abuse risks, security-sensitive behavior, and scalability concerns are clear enough for red-team review.
- Acceptance criteria are testable.
- Every material requirement is supported by user input, codebase evidence, documentation evidence, or an explicitly accepted assumption.
- Remaining assumptions are explicitly named and are either low-risk or accepted by the user.

Resolve unknowns that change behavior, boundaries, expected outputs, gate expectations, artifacts, user-visible workflow, or implementation scope. Do not draft the spec while material unknowns remain unless the user has explicitly accepted the assumptions you will use.

Translate the resolved user intent into concrete requirements. The spec should explain what must be built, what the extension or feature should do, and what output later phases should expect. It should be detailed enough that a red-team pass can evaluate scalability concerns, tampering risks, security-sensitive failure modes, missing requirements, unclear boundaries, brittle assumptions, and other common red-team concerns.

Write for the Ralph loop. The next phase will read this specification as its primary input. Avoid vague language that forces the red-team or implementation phases to guess. Use direct statements for expected behavior, phase boundaries, artifacts, and acceptance criteria. When something is intentionally out of scope, say so plainly. Cite the supporting evidence for requirements that rely on current repository behavior or external documentation.

Respect the RalphWorks responsibility boundary. The extension should remain a small coordination layer for the Pi agent harness. Do not design a heavyweight project management system. Do not move all implementation logic into the extension. The extension's responsibilities are phase tracking, TUI display, gate coordination, model selection, minimal artifact tracking, and clear repository organization.

## Required Content

The specification should describe the requested feature in a way that can be used for red-team review, hardening, task planning, TDD implementation, and final review. Use these exact Markdown headers, in this order. If a section is not relevant, keep the header and write `Not applicable` with one sentence explaining why.

# <Feature Name> Generated Spec

Use the user's feature name or the feature value supplied in phase context.

## 1. Purpose And User Value

State the problem, the intended value, and the success outcome in user-visible terms. Keep this focused on what the feature accomplishes, not how it will be implemented.

## 2. Intended Users And Context

Identify the users, operators, maintainers, or downstream agent phases that depend on the feature. Include important environmental or repository context discovered during the interview and research.

## 3. Evidence And Research Notes

Summarize the research performed and cite the supporting evidence used by the spec. Include relevant user answers, local files, tests, docs, configs, prompts, scripts, artifact patterns, and official or primary documentation sources. Distinguish direct evidence from inference and accepted assumptions. If web research was not relevant or could not be performed, say why. Do not cite files or documentation that were not inspected.

## 4. Scope

List in-scope behavior and explicit out-of-scope boundaries. Include any constraints that prevent later phases from broadening the work.

## 5. User Workflows

Describe the main workflow and any important alternate workflows. Use concise ordered steps when sequence matters.

## 6. Functional Requirements

List concrete system behaviors the feature must provide. Requirements should be specific, unambiguous, feasible, and testable. Use requirement bullets or numbered items, and avoid design or implementation details unless the user explicitly made them requirements.

## 7. Inputs, Outputs, And Interfaces

Describe user inputs, command inputs, file inputs, generated outputs, external interfaces, API boundaries, CLI behavior, and any compatibility expectations that affect implementation.

## 8. Data, State, And Artifacts

Describe required data, persisted state, generated files, artifact paths, naming rules, and retention expectations. When relevant, describe runtime artifacts in minimal, workflow-oriented terms. RalphWorks artifacts are written under `docs/` with the sanitized feature name as a filename prefix, such as `docs/<feature>-generated-spec.md`, `docs/<feature>-red-team-findings.md`, `docs/<feature>-hardened-spec.md`, `docs/<feature>-hardened-spec.html`, `docs/<feature>-task-list.md`, `docs/<feature>-implementation-status.json`, and `docs/<feature>-review-findings.md`. Use the exact current output path supplied in the phase context. Do not invent artifact tracking beyond what is useful for phase transitions, TUI display, and the next phase of work.

## 9. Non-Functional Requirements

State quality requirements such as performance, reliability, usability, accessibility, maintainability, observability, compatibility, and scalability when they affect the feature. Make each requirement measurable or reviewable when possible.

## 10. Security, Privacy, And Abuse Considerations

State security-sensitive behavior, privacy expectations, trust boundaries, misuse or prompt-injection risks, unsafe failure modes, and data-handling constraints. If there is no special concern, explain why the default project security posture is sufficient.

## 11. Edge Cases And Failure Modes

Describe important empty states, invalid inputs, missing files, conflicting state, interrupted runs, dependency failures, malformed outputs, and recovery expectations.

## 12. RalphWorks Workflow Impact

Describe effects on RalphWorks phases, phase transitions, gates, model routing, TUI display, and controller boundaries. If the feature affects gates, mention how `gate.config.json` should be considered. If it affects per-phase models, mention how `model.config.json` should be considered. If it affects terminal display, describe what the TUI should make visible. Preserve the boundary that the extension coordinates workflow while the agent phases perform interviewing, spec writing, red-team review, hardening, implementation, and review work.

## 13. Acceptance Criteria

List testable acceptance criteria that define when the feature is complete. Include user-visible behavior, required artifacts, workflow behavior, relevant gate behavior, and any negative cases that must be verified.

## 14. Assumptions And Open Questions

List assumptions accepted during the interview and research and any open questions that remain. Do not leave open questions that block task creation unless the user explicitly accepted proceeding with named assumptions. Do not hide unverified speculation in this section; material assumptions must be named plainly.

## Boundaries

Do not implement code in this phase unless explicitly asked outside the Ralph loop. Do not create the task list yet. Do not harden the spec against findings that have not been produced. Do not perform the final review. This phase ends when there is a full working feature specification ready for red-team review.

## Output

First output: Round 1 interview questions only. Do not include a partial spec, proposed task list, implementation plan, or acceptance criteria draft in the interview turn.

After the user answers Round 1: conduct codebase research first and web research when relevant before producing the next visible output. Do not draft the specification yet unless the research is complete enough to satisfy the readiness checklist and no material ambiguity remains.

Post-research follow-up output, when needed: ask only the remaining targeted follow-up questions required to satisfy the readiness checklist or name the assumptions that need explicit user acceptance. Do not include a partial spec, proposed task list, implementation plan, or acceptance criteria draft in follow-up turns.

After research and any needed follow-up answers, produce a complete working feature specification at the current output path supplied in the phase context, typically `docs/<feature>-generated-spec.md`. The output should be evidence-backed and clear enough that the red-team phase can evaluate it without needing to re-interview the user about basic intent.
