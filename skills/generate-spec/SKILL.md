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

Start by reading the prompt carefully and identifying ambiguity. Ask clarifying questions when unknowns would materially affect implementation. Do not ask broad or decorative questions. Ask only what is needed to produce a working feature specification that can support review and implementation planning.

Resolve unknowns that change behavior, boundaries, expected outputs, gate expectations, artifacts, user-visible workflow, or implementation scope. If the prompt is already clear enough, proceed without unnecessary interview loops. If the prompt is incomplete, interview the user with targeted questions before drafting.

Translate the resolved user intent into concrete requirements. The spec should explain what must be built, what the extension or feature should do, and what output later phases should expect. It should be detailed enough that a red-team pass can evaluate scalability concerns, tampering risks, security-sensitive failure modes, missing requirements, unclear boundaries, brittle assumptions, and other common red-team concerns.

Write for the Ralph loop. The next phase will read this specification as its primary input. Avoid vague language that forces the red-team or implementation phases to guess. Use direct statements for expected behavior, phase boundaries, artifacts, and acceptance criteria. When something is intentionally out of scope, say so plainly.

Respect the RalphWorks responsibility boundary. The extension should remain a small coordination layer for the Pi agent harness. Do not design a heavyweight project management system. Do not move all implementation logic into the extension. The extension's responsibilities are phase tracking, TUI display, gate coordination, model selection, minimal artifact tracking, and clear repository organization.

## Required Content

The specification should describe the requested feature in a way that can be used for task planning. Include the purpose, expected behavior, important inputs and outputs, constraints, phase or workflow effects, and acceptance criteria. If the feature affects gates, mention how `gate.config.json` should be considered. If it affects per-phase models, mention how `model.config.json` should be considered. If it affects terminal display, describe what the TUI should make visible.

When relevant, describe runtime artifacts in minimal, workflow-oriented terms. Suggested RalphWorks artifacts include `generated-spec.md`, `red-team-findings.md`, `hardened-spec.md`, `hardened-spec.html`, `task-list.md`, `implementation-status.json`, and `review-findings.md`. Do not invent artifact tracking beyond what is useful for phase transitions, TUI display, and the next phase of work.

## Boundaries

Do not implement code in this phase unless explicitly asked outside the Ralph loop. Do not create the task list yet. Do not harden the spec against findings that have not been produced. Do not perform the final review. This phase ends when there is a full working feature specification ready for red-team review.

## Output

Produce a complete working feature specification. The suggested runtime artifact for this phase is `generated-spec.md`. The output should be clear enough that the red-team phase can evaluate it without needing to re-interview the user about basic intent.
