---
name: create-tasks
description: Use during the RalphWorks create_tasks phase to turn a hardened feature specification into a prioritized, testable implementation task list for the Pi agent workflow.
---

# Create Tasks

Use this skill for the `create_tasks` phase of the RalphWorks Pi extension.

## Purpose

Your job is to convert the hardened feature specification into a prioritized implementation to-do list. This list becomes the input for the Ralph loop implementation pass. The TDD implementation phase will repeatedly select the most important unclaimed item from your output, implement it with red-green TDD, run configured gates, and continue until all tasks are complete.

The extension coordinates the phase, model selection, TUI display, and artifact tracking. You perform the planning work. Keep the task list clear, lightweight, and directly tied to the hardened spec.

## Inputs

- Hardened feature specification.
- Any phase context provided by the Pi agent harness.

## Process

Read the hardened spec completely before creating tasks. Extract the concrete implementation work needed to satisfy the spec. Preserve the spec's scope and do not introduce unrelated features. If the hardened spec identifies phase states, gate behavior, model routing, TUI behavior, artifact tracking, repository structure, or acceptance criteria, convert those requirements into implementation tasks.

Prioritize or rank tasks so the implementation phase can select the most important unclaimed item. The requirements document leaves the exact priority scheme open: priority may be numeric, ordered by list position, or calculated by the agent. Choose a simple scheme that makes selection obvious. The first implementation item should be important enough to move the feature toward correctness, not a cosmetic task.

Mark tasks in a way that supports claiming, completion, and review. The requirements do not require a complex schema, but the list should make task state possible. Each item should have enough identity and detail that an implementation agent can claim it, test it, complete it, and later show review status. Avoid vague items like "finish integration" or "clean up code" unless they are broken down into specific, verifiable work.

Keep the to-do list implementation-oriented. It should be more specific than the spec but not so broad that a single item hides multiple unrelated responsibilities. A task can reference a clear module or responsibility when the spec does. The requirements favor small files with clear names and explicit module boundaries, so task breakdown should support that repository style. Avoid plans that push phase state, TUI rendering, gate execution, model routing, task handling, and harness integration into one catch-all module.

Include tasks that support gates when the spec requires them. Gate behavior comes from `gate.config.json`; gates run after each completed TDD implementation item; required gates must pass before an item is considered complete; gate failure blocks transition to the next implementation item or review phase until resolved; gate results should be visible in the TUI. If the hardened spec includes this behavior, your task list should make it implementable and testable.

Include tasks that support model routing when the spec requires it. `model.config.json` may define phase-specific models and a default fallback. If this is in scope, create tasks for loading, validating, resolving, and displaying active phase model information as appropriate.

## Task Quality

Each task should describe expected behavior and completion evidence. It should be possible for the TDD implementation phase to write or update a failing test for the task. If no testable behavior is visible, refine the task until it has a clear outcome.

Use the hardened spec as the authority. Do not create tasks for speculative improvements, extra dashboards, complex project management features, or broad frameworks not present in the spec.

## Output

Produce a prioritized to-do list at the current output path supplied in the phase context, typically `docs/<feature>-task-list.md`. The list should be ready for the `tdd_implement` phase to select the most important unclaimed item and begin red-green TDD.
