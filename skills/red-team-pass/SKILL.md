---
name: red-team-pass
description: Use during the RalphWorks red_team phase to review a generated feature specification for critical risks, missing requirements, and actionable hardening recommendations.
---

# Red Team Pass

Use this skill for the `red_team` phase of the RalphWorks Pi extension.

## Purpose

Your job is to evaluate the generated feature specification for critical bugs and systemic weaknesses before implementation begins. This phase protects the rest of the Ralph loop from building on a fragile or unsafe spec. The output becomes the direct input to the harden-spec phase, so findings must be actionable enough for the original spec to be improved in place.

The extension coordinates the current phase, model selection, terminal display, and artifact tracking. You perform the adversarial analysis. Keep the work focused on the generated spec and the risks that matter before task planning and implementation.

## Inputs

- Generated feature specification from the generate-spec phase.
- Any phase context provided by the Pi agent harness.

## Process

Read the specification as if it is about to become the implementation plan. Look for issues that would create serious defects, unsafe behavior, brittle workflow assumptions, or unclear requirements. The requirements document specifically calls out scalability concerns, tampering or abuse risks, security-sensitive failure modes, missing requirements, unclear boundaries, brittle assumptions, and other common red-team concerns. Use those as the core review lens.

Focus on critical and material risks. This phase is not for minor polish, preferred wording, or broad style critique. It is for findings that would meaningfully change the hardening pass, task plan, implementation behavior, gate expectations, or final review outcome.

For each finding, explain the risk, why it matters, and what change should be made to the spec. A useful finding should be concrete enough that the harden-spec phase can apply it directly. Do not simply say that something is "unclear" or "risky"; describe the unclear boundary, missing requirement, failure mode, or assumption that needs to be strengthened.

Consider the RalphWorks workflow as part of the review. The extension should make the current phase obvious, support loopback from review to TDD implementation, run configured gates after each TDD implementation item, route models through minimal configuration, and keep the repository easy to navigate through small, clearly named files. If the generated spec violates those constraints, call it out.

Consider gate and model behavior only as specified. `gate.config.json` defines user validation commands such as tests and linting. Required gates block progress when they fail. `model.config.json` defines a default model and optional phase-specific models. If the spec implies different behavior, identify that mismatch as a finding.

## Finding Quality

Every finding should support the next phase. State the issue, the likely impact, and the recommended spec change. When several symptoms share one underlying cause, group them so the harden-spec phase can address the root problem. When the issue is a missing requirement, name the requirement that should be added. When the issue is a boundary problem, say what should belong to the extension and what should remain in the agent workflow coordinated through the Pi harness.

Use severity in a practical way. Critical issues are those that would block safe or correct implementation planning. Warnings are material issues that should be fixed before task creation but may not break the entire workflow. Informational notes should be rare and useful.

## Boundaries

Do not rewrite the spec in this phase. Do not create the task list. Do not implement fixes. Do not broaden the extension into a full project management system or general implementation engine. Your job is to produce findings and recommended changes for hardening.

## Output

Produce a clear list of critical findings, risks, and recommended changes at the current output path supplied in the phase context, typically `docs/<feature>-red-team-findings.md`. The output should be ready for the harden-spec phase to apply directly to the original specification.
