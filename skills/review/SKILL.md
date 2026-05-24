---
name: review
description: Use during the RalphWorks review phase to inspect completed implementation work for critical bugs and decide whether the Pi workflow completes or loops back to TDD implementation.
---

# Review

Use this skill for the `review` phase of the RalphWorks Pi extension.

## Purpose

Your job is to review the completed implementation for critical bugs. This is the final quality phase in the Ralph loop, but it can send the workflow back to `tdd_implement` when critical bugs are found. The review result determines whether the workflow completes or loops back for another implementation pass.

The extension coordinates phase tracking, terminal display, model selection, and loopback behavior. You perform the review and produce the decision. The TUI should make the transition obvious when review returns to implementation, but your output must make the reason for that loopback clear.

## Inputs

- Completed implementation output.
- Implementation status.
- Task list and hardened spec when available in phase context.
- Gate results from TDD implementation when available.
- Any phase context provided by the Pi agent harness.

## Process

Review the completed work for critical bugs. A critical bug is an issue that affects correctness, safety, severe failure modes, required workflow behavior, phase transitions, gate behavior, model routing, artifact tracking, or the ability of the Ralph loop to complete reliably. Avoid blocking completion for minor polish issues unless they affect correctness or safety.

Compare the implementation to the hardened spec and task list. The implementation should support the Ralph loop from generate spec through red-team pass, harden spec, optional HTML render, task creation, red-green TDD implementation, review, and complete. Review should verify that the implementation can represent and display all phases, clearly show the current phase, clearly show loopbacks to TDD implementation, run configured gates after each TDD implementation step, block progress when required gates fail, and support per-phase model selection with default fallback.

Check the loopback behavior carefully. The review phase must be able to send the workflow back to `tdd_implement` when critical bugs are found. The user should be able to see that the workflow is no longer in review and has returned to implementation for another pass. If this behavior is missing, unclear, or unreliable, treat it as critical.

Check gate behavior. Gates should run after every TDD implementation step. Required gates must pass before an item is considered complete. Gate failure should block transition to the next implementation item or review phase until resolved. Gate results should be visible in the TUI. If required tests or linting can fail without blocking progress, that is critical.

Check model configuration behavior. `model.config.json` should allow each phase to specify a model, use a default model when a phase-specific model is not defined, display the active phase model in the TUI when available, and remain small and easy to edit. If implementation breaks these expectations in a way that changes workflow correctness, report it.

Check repository clarity when relevant. The requirements call for small, purpose-specific files with names that reveal responsibility before opening them. Broad catch-all modules should not own phase state, TUI rendering, gate execution, model routing, task handling, and Pi harness integration all at once. If the implementation structure undermines maintainability enough to threaten the extension's lightweight scope, report it as a serious issue.

## Decision Rules

If no critical bugs are found, conclude with exactly `LGTM`. Do not block completion for minor polish. Do not append any generic phase-completion marker to an approving review decision.

If critical bugs are found, create or update implementation tasks describing the bugs. The output should be specific enough for the TDD implementation phase to select and repair the work. The workflow should return to `tdd_implement` for another pass, and the loopback should be visible in the TUI.

## Output

Produce either `LGTM` or a set of critical bugs that re-enter TDD implementation. The suggested runtime artifact for critical findings is `review-findings.md`.
