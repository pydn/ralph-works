---
name: harden-spec
description: Use during the RalphWorks harden_spec phase to apply red-team findings directly to the generated feature specification and produce an implementation-ready hardened spec.
---

# Harden Spec

Use this skill for the `harden_spec` phase of the RalphWorks Pi extension.

## Purpose

Your job is to take the generated feature specification and the red-team findings, then harden the original spec in place. The result should be an implementation-ready specification that has addressed critical issues before task creation begins.

This phase is not a commentary phase. The goal is not to produce a second document that talks about how the original spec could improve. The goal is to produce the hardened version of the spec itself. The task-creation phase should be able to read the hardened spec directly without also needing to interpret a separate explanation document.

## Inputs

- Generated feature specification.
- Red-team findings, risks, and recommended changes.
- Any phase context provided by the Pi agent harness.

## Process

Read the original spec and the red-team findings together. Identify each finding that requires a change to requirements, assumptions, boundaries, edge cases, acceptance criteria, workflow behavior, artifacts, gates, model routing, or TUI expectations. Apply those findings directly to the spec.

Preserve the original implementation intent unless a red-team finding shows that the intent would create a critical failure mode. Hardening should make the feature safer, clearer, and more implementable. It should not replace the user's requested feature with a different project.

Strengthen requirements where risks were identified. If the red-team pass found a scalability concern, add requirements or constraints that make expected scalability behavior clear. If it found tampering, abuse, manipulation, or security-sensitive failure modes, add requirements that prevent or expose those risks. If it found missing requirements, add them in the right place. If it found unclear boundaries, state the boundary directly.

Clarify assumptions and edge cases. Later phases should not have to guess what happens when review finds critical bugs, when a required gate fails, when an optional HTML render is not requested, when a model is not defined for a phase, or when repository structure begins drifting toward catch-all modules. Keep the hardened spec aligned with the core RalphWorks design principle: lightweight, explicit, and easy to understand.

Ensure the hardened spec respects the extension responsibility boundary. The extension should coordinate phase tracking, TUI display, gate coordination, model selection, minimal artifact tracking, and clear repository organization. Heavy work such as interviewing, spec writing, red teaming, implementation, and review should be performed by the agent workflow coordinated through the Pi agent harness. If the original spec assigned too much work to the extension, correct that.

## Required Coverage

The hardened spec should still support the same Ralph loop: generate spec, red-team pass, harden spec, optional HTML render, task creation, red-green TDD implementation, review, and completion. It should preserve loopback behavior from review to `tdd_implement` when critical bugs are found. It should preserve gate behavior from `gate.config.json`, including required gates blocking transition when they fail. It should preserve model behavior from `model.config.json`, including default fallback when no phase-specific model is defined.

## Boundaries

Do not create the implementation to-do list yet. Do not implement code. Do not perform final review. Do not use hardening as an excuse to add unrelated features. Do not leave red-team findings unresolved unless they are explicitly out of scope and the spec says why.

## Output

Produce the hardened version of the specification at the current output path supplied in the phase context, typically `docs/<feature>-hardened-spec.md`. The output should be ready for optional HTML rendering and task creation.
