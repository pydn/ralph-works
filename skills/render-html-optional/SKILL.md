---
name: render-html-optional
description: Use during the optional RalphWorks render_html_optional phase to render the hardened specification as faithful, human-readable HTML without changing requirements.
---

# Render HTML Optional

Use this skill for the `render_html_optional` phase of the RalphWorks Pi extension.

## Purpose

Your job is to render the hardened specification into a human-readable HTML format when this optional phase is requested or useful. The output is for humans to read, review, or share more easily. This phase should not change what will be implemented.

The RalphWorks workflow treats this phase as optional. It should not block task creation unless explicitly configured to do so. The extension coordinates whether this phase is active, displays it in the TUI, and tracks the artifact. You perform the rendering work.

## Inputs

- Hardened feature specification.
- Any phase context provided by the Pi agent harness.

## Process

Read the hardened specification carefully before rendering. Preserve its substance, requirements, constraints, phase boundaries, artifacts, and acceptance criteria. The HTML output should communicate the same implementation requirements as the hardened spec. Do not add new requirements, remove requirements, reinterpret scope, or make unresolved product decisions during rendering.

Create a clear HTML version that a human can scan and understand. The requirements document does not demand a full dashboard or complex presentation. Apply the same RalphWorks design principle here: keep the output lightweight, explicit, and easy to understand. The goal is readable delivery, not a heavy documentation system.

Make the workflow state clear if the spec discusses it. The Ralph loop includes generate spec, red-team pass, harden spec, optional HTML render, task creation, red-green TDD implementation, review, and complete. Review can loop back to TDD implementation when critical bugs are found. If the hardened spec includes workflow details, render them in a way that preserves this ordered flow and loopback behavior.

Preserve details that later phases need. Task creation depends on the hardened spec, not on decorative interpretation. If the hardened spec defines gate behavior, render it accurately: gates run after each completed TDD implementation item, required gates must pass before the item is complete, and gate failure blocks transition until resolved. If it defines model behavior, render it accurately: each phase may specify a model, default model is used when no phase-specific model exists, and the active phase model should be visible in the TUI when available.

Preserve repository guidance if present. The extension should favor small, purpose-specific files with clear names. It should avoid vague catch-all modules and keep orchestration thin. If these requirements are present in the hardened spec, they should remain visible and understandable in the HTML.

## Rendering Rules

The HTML should make the spec easier to read without changing its meaning. Use headings, sections, lists, and tables when they clarify the document. Keep language faithful to the hardened source. If the hardened spec contains ambiguity, do not silently fix it during rendering; preserve it or surface it as a rendering note only if needed.

Do not let visual formatting hide important requirements. Acceptance criteria, gate behavior, model configuration, phase states, loopback behavior, and artifact expectations should remain easy to locate.

## Boundaries

Do not perform hardening in this phase. Do not create the implementation task list. Do not implement code. Do not perform review. Do not add UI complexity beyond what is useful for reading the spec. This phase is a rendering step, not a requirements-changing step.

## Output

Produce a human-readable HTML version of the hardened specification. The suggested runtime artifact for this phase is `hardened-spec.html`. The output should preserve the substance of `hardened-spec.md` and support human review without blocking task creation unless configured to do so.
