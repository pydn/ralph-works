---
name: red-green-tdd-implement
description: Use during the RalphWorks tdd_implement phase to implement prioritized tasks with red-green TDD, run configured Pi gates, and update implementation status.
---

# Red Green TDD Implement

Use this skill for the `tdd_implement` phase of the RalphWorks Pi extension.

## Purpose

Your job is to implement the prioritized to-do list item by item using red-green test-driven development. This phase is the main implementation pass in the Ralph loop. It begins after task creation and may also be re-entered from review when critical bugs are found.

The extension coordinates phase tracking, TUI display, gate coordination, model selection, and minimal artifact tracking. You perform implementation work, but stay within the task list and current implementation state. Required gates from `gate.config.json` must pass before progress continues.

## Inputs

- Prioritized to-do list from the create-tasks phase.
- Current implementation state.
- Gate behavior from `gate.config.json`.
- Review findings when this phase is re-entered after critical bugs.
- Any phase context provided by the Pi agent harness.

## Process

Select the most important unclaimed to-do item. Use the priority or ordering provided by the task list. Do not skip higher-priority unclaimed work without a clear reason. If this phase was reached from review because critical bugs were found, treat the critical bug tasks as implementation work that must be addressed before returning to review.

For the selected item, write or update a failing test that captures the expected behavior. The failing test is the red step. It should be specific to the item and should demonstrate the behavior required by the hardened spec or review finding. Do not mark the item complete before there is test coverage for the expected behavior.

Implement the minimal change needed to make the test pass. The green step should satisfy the selected task without pulling in unrelated refactors or speculative features. Keep changes aligned with the repository guidance from the requirements: small files, clear names, explicit module boundaries, thin orchestration, and no broad catch-all modules that mix phase state, TUI rendering, gate execution, model routing, task handling, and Pi harness integration.

After the relevant test passes, run configured gates from `gate.config.json`. The gate configuration is user-defined and minimal. It should support at least tests and linting when configured. Gates run after each completed TDD implementation item. Required gates must pass before the item is considered complete. Gate failure blocks transition to the next implementation item or review phase until resolved. Gate results should be visible in the TUI.

If a required gate fails, repair the implementation or tests until the gate passes. Do not mark the item complete while required tests or lint gates are failing. Optional or non-required behavior should still be reported clearly, but required gates control completion.

Mark the item complete only when the relevant tests and required gates pass. Update implementation status so later implementation work and review can understand what has been claimed and completed. The suggested runtime artifact for this status is `implementation-status.json`, but keep artifact tracking minimal and workflow-oriented.

Repeat this process until all to-do items are complete or a blocking gate failure requires repair. When all items are complete and gates are passing, the workflow can move to review.

## Boundaries

Do not rewrite the hardened spec unless the workflow has explicitly returned to a spec phase. Do not invent new tasks outside the task list except when critical review findings require implementation tasks. Do not skip red-green TDD. Do not bypass configured gates. Do not broaden the extension into a full project management system or implementation framework.

## Output

Produce completed implementation items with relevant tests and required gates passing. Maintain implementation status in a minimal way so the same phase can continue item by item and the review phase can inspect completed work.
