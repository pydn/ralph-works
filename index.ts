/**
 * Ralph Loop Extension — Phase-state-machine pipeline inside pi.
 *
 * Each phase runs as a focused agent turn with its own skill injected via
 * before_agent_start, then advances deterministically on agent_end.
 * No mega-prompts, no string-matching phase detection, no shortcutting.
 *
 * Architecture:
 *   /ralph start → save state (phase 0)
 *     → pre-hook: inject current phase's skill into system prompt
 *     → sendUserMessage(focusedPhasePrompt(phase 0))
 *     → agent works on phase 0
 *     → agent_end: run gates if applicable, advance to phase 1
 *     → sendUserMessage(focusedPhasePrompt(phase 1))
 *     → ... repeat until all phases complete
 *
 * Features:
 *   - Pipeline command (/ralph start <feature>)
 *   - Per-phase skill injection (only current phase's skill loaded)
 *   - Pre/post lint gates (ruff check, format, tests)
 *   - Auto-gate after file writes during implementation phases
 *
 * Usage (interactive pi session):
 *   /ralph start <feature>                    — Full pipeline
 *   /ralph start <feature> spec,harden        — Selected phases only
 *   /ralph status                             — Show current state
 *   /ralph cancel                             — Abort pipeline
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as child from "node:child_process";

// ── Constants ───────────────────────────────────────────────
const CUSTOM_TYPE = "ralph-loop-state";
const SKILL_BASE = path.join(os.homedir(), ".pi", "agent", "skills", "_global");

// Implementation/remediation phases that trigger auto-gates
const GATE_PHASES = new Set(["implement", "review"]);

interface GateResult {
  name: string;
  pass: boolean;
  output: string;
}

/**
 * Tracks which files each phase produced, so the next phase knows what to read.
 */
interface PhaseArtifacts {
  specFile?: string;        // docs/specs/<feature>.html
  hardenedSpecFile?: string; // docs/specs/<feature>.html (updated in-place)
  redTeamReport?: string;    // docs/security/red-team-audit-<feature>.html
  hardenChangelog?: string;  // docs/specs/harden-changelog.md
}

interface PipelineState {
  feature: string;
  workDir: string;
  phases: string[];
  maxIterations: number;
  startedAt: number;
  currentPhaseIndex: number;  // 0-based index into phases[] (always explicit)
  promptText?: string;        // task description from prompt file or inline arg
  artifacts?: PhaseArtifacts; // output files from completed phases
}

// Phase metadata + skill path mapping
const PHASE_META: Record<
  string,
  { name: string; desc: string; skillPath: string }
> = {
  spec: {
    name: "Generate Spec",
    desc: "Create HTML engineering specification",
    skillPath: path.join(SKILL_BASE, "generate-spec", "SKILL.md"),
  },
  redteam: {
    name: "Red Team Audit",
    desc: "Adversarial security review of the spec",
    skillPath: path.join(SKILL_BASE, "red-team-audit", "SKILL.md"),
  },
  harden: {
    name: "Harden Spec",
    desc: "Address audit findings, update spec with mitigations",
    skillPath: path.join(SKILL_BASE, "generate-spec", "SKILL.md"), // reuse for editing
  },
  implement: {
    name: "TDD Implement",
    desc: "Implement via Red-Green-Refactor cycle",
    skillPath: path.join(SKILL_BASE, "tdd-implement", "SKILL.md"),
  },
  review: {
    name: "Ralph Review Loop",
    desc: "Multi-pass PR review → remediate until LGTM",
    skillPath: path.join(SKILL_BASE, "pi-skills", "pr-reviewer", "SKILL.md"),
  },
};

// ── Helpers ───────────────────────────────────────────────

function getState(ctx: ExtensionContext): PipelineState | null {
  let latest = null;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === CUSTOM_TYPE && entry.data) {
      latest = entry.data as PipelineState;
    }
  }
  // Return the last saved state (most recent saveState call)
  return latest;
}

function saveState(pi: ExtensionAPI, state: PipelineState) {
  pi.appendEntry(CUSTOM_TYPE, state);
}

function findLatestSpec(workDir: string): string | null {
  const dir = path.join(workDir, "docs", "specs");
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".html"));
    if (!files.length) return null;
    const sorted = files.map((f) => ({
      name: f,
      mtime: fs.statSync(path.join(dir, f)).mtimeMs,
    })).sort((a, b) => b.mtime - a.mtime);
    return `docs/specs/${sorted[0].name}`;
  } catch {
    return null;
  }
}

function runShell(cmd: string, cwd: string): { ok: boolean; output: string } {
  try {
    const out = child.execSync(cmd, {
      cwd,
      encoding: "utf-8",
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return { ok: true, output: out.trim() };
  } catch (err: any) {
    return {
      ok: err.signal ? false : err.status !== 0,
      output: (err.stdout ?? "") + (err.stderr ?? "") + (err.message ?? ""),
    };
  }
}

/**
 * Run all lint gates. Returns structured results.
 */
function runLintGates(workDir: string, targetPaths?: string[]): GateResult[] {
  const target = targetPaths && targetPaths.length > 0 ? targetPaths.join(" ") : ".";
  const results: GateResult[] = [];

  // Gate 1: Ruff lint check (E,F,W,I — errors, format warnings, imports)
  const ruffCheck = runShell(`uv run ruff check ${target} --select E,F,W,I`, workDir);
  results.push({
    name: "ruff check",
    pass: ruffCheck.ok,
    output: ruffCheck.output || "(clean)",
  });

  // Gate 2: Ruff format check (auto-fix on failure)
  const formatCheck = runShell(`uv run ruff format --check ${target}`, workDir);
  if (!formatCheck.ok) {
    // Auto-fix formatting differences
    const formatFix = runShell(`uv run ruff format ${target}`, workDir);
    results.push({
      name: "ruff format",
      pass: formatFix.ok,
      output: `(auto-fixed) ${formatFix.output}`,
    });
  } else {
    results.push({ name: "ruff format", pass: true, output: "(clean)" });
  }

  // Gate 3: Test suite
  const testResult = runShell("uv run python -m unittest discover tests -v", workDir);
  results.push({
    name: "test suite",
    pass: testResult.ok,
    output: testResult.output || "(all passed)",
  });

  return results;
}

/**
 * Build the gate results into a readable markdown table.
 */
function formatGateResults(results: GateResult[]): string {
  const rows = results.map(
    (r) => `| ${r.name} | ${r.pass ? "✅ PASS" : "❌ FAIL"} |`,
  );
  return `## Lint Gate Results

| Gate | Status |
|------|--------|
${rows.join("\n")}

${results.map((r) => (r.pass ? "" : `\`\`\`\n${r.name} output:\n${r.output}\n\`\`\``)).join("\n\n")}`;
}

/**
 * Resolve prompt input: file path → contents, or use raw text directly.
 */
function resolvePromptInput(arg: string, workDir: string): string | null {
  // If it looks like a file path (contains / or .), try to read it
  if (arg.includes("/") || arg.includes(".")) {
    const resolved = path.isAbsolute(arg) ? arg : path.join(workDir, arg);
    if (fs.existsSync(resolved)) {
      return fs.readFileSync(resolved, "utf-8").trim();
    }
  }
  // Otherwise treat as inline description text
  return arg;
}

/**
 * Build a focused prompt for a single phase. Only references artifacts from
 * previous phases — no mention of future phases.
 */
function buildPhasePrompt(
  state: PipelineState,
  phaseKey: string,
): string {
  const taskSection = state.promptText
    ? `## Feature Requirements\n\n${state.promptText}\n`
    : `## Feature Requirements\n\nFeature name: ${state.feature}\n(No detailed requirements provided — infer from codebase)\n`;

  const artifacts = state.artifacts || {};

  switch (phaseKey) {
    case "spec":
      return `${taskSection}
## Task: Generate Engineering Specification

Create an HTML engineering specification for this feature.

**Save to:** docs/specs/${state.feature}.html

**Include:**
- Problem statement and motivation
- Proposed solution with architecture overview
- Detailed implementation plan
- Risk assessment and assumptions
- API surface / public interface

Read the codebase first to understand context, then generate the spec.`;

    case "redteam": {
      const target = artifacts.specFile || `docs/specs/${state.feature}.html`;
      return `## Task: Red Team Security Audit

You will conduct an adversarial security review of the specification.

**Input file to audit:** ${target}

**Save report to:** docs/security/red-team-audit-${state.feature}.html

**Instructions:**
1. Read the specification thoroughly
2. Analyze for: logic gaps, security vulnerabilities, edge cases, scalability issues
3. Map attack surfaces and exploitation paths
4. Mark each finding as [CRITICAL] or [WARNING]
5. Include STRIDE analysis where applicable
6. Save the audit report in HTML format`;
    }

    case "harden": {
      const specFile = artifacts.specFile || `docs/specs/${state.feature}.html`;
      const auditFile = artifacts.redTeamReport || `docs/security/red-team-audit-${state.feature}.html`;
      return `## Task: Harden Specification

Address the red team findings and update the specification.

**Files to read:**
- Spec: ${specFile}
- Audit report: ${auditFile}

**Instructions:**
1. Read the audit report first — understand every finding
2. Update the spec (${specFile}):\n   - Address every [CRITICAL] with specific mitigations\n   - Address every [WARNING] where practical\n   - Add a "Security Considerations" section for residual risks
3. Write docs/specs/harden-changelog.md listing all changes made
4. Save the hardened spec in-place (${specFile})`;
    }

    case "implement": {
      const spec = artifacts.hardenedSpecFile || artifacts.specFile || `docs/specs/${state.feature}.html`;
      return `${taskSection}
## Task: TDD Implementation

Implement the specification using strict Red-Green-Refactor.

**Read the spec:** ${spec}

**For each requirement in the spec:**
1. Write failing tests FIRST (describe expected behavior)
2. Implement just enough code to make tests pass (Green)
3. Refactor for clarity, performance, maintainability
4. After completing a logical group of changes, call \`ralph_gate_check\`
5. Fix any gate failures before moving on
6. Commit with conventional commit messages after each feature

**After all implementation:**
- Run \`ralph_gate_check\` one final time — ALL gates must pass
- When done and gates clear, respond with "PHASE COMPLETE"`;
    }

    case "review": {
      const spec = artifacts.hardenedSpecFile || `docs/specs/${state.feature}.html`;
      return `## Task: PR Review Loop

Perform a thorough multi-pass review of the implementation.

**Reference spec:** ${spec}

**Review passes (in order):**
1. **Logic pass:** Does code match spec? Edge cases handled? Correctness?
2. **Security pass:** Auth, input validation, injection, data exposure?
3. **Style pass:** Naming, formatting, DRY, error handling patterns?

**For each [CRITICAL] issue found:**
- Fix it using TDD (test → implement → gate check)
- Run \`ralph_gate_check\` after fixes

**Loop until:** zero criticals AND all gates pass.
Max iterations: ${state.maxIterations}.

**Record findings in:** .ralph/dev-cycle-${state.feature}.md

When review is clean and gates pass, respond with "LGTM — pipeline complete"`;
    }

    default:
      return `Unknown phase: ${phaseKey}`;
  }
}

/**
 * Resolve artifacts produced by a completed phase.
 */
function resolvePhaseArtifacts(state: PipelineState, phaseKey: string): Partial<PhaseArtifacts> {
  const existing = state.artifacts || {};
  switch (phaseKey) {
    case "spec":
      return { specFile: `docs/specs/${state.feature}.html` };
    case "redteam":
      return { redTeamReport: `docs/security/red-team-audit-${state.feature}.html` };
    case "harden":
      return {
        hardenedSpecFile: `docs/specs/${state.feature}.html`,
        hardenChangelog: `docs/specs/harden-changelog.md`,
      };
    default:
      return {};
  }
}

// ── Extension: Phase State Machine ─────────────────────────

export default function (pi: ExtensionAPI) {
  let writeCountSinceGate = 0;
  const GATE_THRESHOLD = 3; // Auto-run gate after N consecutive writes

  /** Send a focused prompt for the current phase. */
  function advanceToNextPhase(ctx: ExtensionContext) {
    const state = getState(ctx);
    if (!state) return;

    const phases = state.phases && state.phases.length > 0 ? state.phases : ["spec", "redteam", "harden", "implement", "review"];
    const idx = state.currentPhaseIndex;

    if (idx >= phases.length) {
      // All phases done — pipeline complete
      ctx.ui.notify(`✅ Pipeline complete for "${state.feature}"`, "success");
      ctx.ui.setStatus("ralph-loop", `✅ Done | ${state.feature}`);
      refreshWidget(ctx, state);
      return;
    }

    const phaseKey = phases[idx];
    const meta = PHASE_META[phaseKey];
    if (!meta) {
      ctx.ui.notify(`Unknown phase: ${phaseKey}`, "error");
      return;
    }

    const phaseNum = idx + 1;
    ctx.ui.setStatus("ralph-loop", `🔄 Phase ${phaseNum}/${phases.length} | ${meta.name}`);
    refreshWidget(ctx, state);
    ctx.ui.notify(
      `▶ Phase ${phaseNum}/${phases.length}: ${meta.name}`,
      "info",
    );

    const prompt = buildPhasePrompt(state, phaseKey);
    pi.sendUserMessage(prompt);
  }

  // Refresh the widget display with current phase info
  function refreshWidget(ctx: ExtensionContext, st: PipelineState) {
    const phases = st.phases && st.phases.length > 0 ? st.phases : ["spec", "redteam", "harden", "implement", "review"];
    const idx = st.currentPhaseIndex;
    const phaseKey = phases[idx];
    const meta = PHASE_META[phaseKey];
    ctx.ui.setWidget(
      "ralph-loop",
      [
        `Pipeline: ${st.feature}`,
        `Phases: ${phases.join(" → ")}`,
        st.promptText ? `Prompt: (provided)` : `Prompt: (none — infer from codebase)`,
        `Started: ${new Date(st.startedAt).toISOString()}`,
        ``,
        `Progress: Phase ${idx + 1}/${phases.length} — ${meta?.name ?? "?"}`,
      ],
    );
  }

  // ── before_agent_start: inject ONLY current phase's skill ──
  pi.on("before_agent_start", async (event, ctx) => {
    const state = getState(ctx);
    if (!state) return;

    const phases = state.phases && state.phases.length > 0 ? state.phases : ["spec", "redteam", "harden", "implement", "review"];
    const phaseKey = phases[state.currentPhaseIndex];
    const meta = PHASE_META[phaseKey];
    if (!meta) return;

    // Load only the skill for this phase
    if (!fs.existsSync(meta.skillPath)) return;

    try {
      const skillContent = fs.readFileSync(meta.skillPath, "utf-8");
      if (!event.systemPrompt.includes("ralph-pipeline-skill")) {
        return {
          systemPrompt:
            event.systemPrompt +
            `\n\n<ralph-pipeline-skill>\nYou are executing Phase ${state.currentPhaseIndex + 1} (${meta.name}) of the Ralph pipeline for feature "${state.feature}".\nFollow this skill's instructions:\n\n${skillContent}\n</ralph-pipeline-skill>`,
        };
      }
    } catch {
      // Skill file not found — continue without injection
    }
  });

  // ── session_start: resume from saved phase index ──
  pi.on("session_start", async (_event, ctx) => {
    const state = getState(ctx);
    if (!state) return;

    const phases = state.phases && state.phases.length > 0 ? state.phases : ["spec", "redteam", "harden", "implement", "review"];
    const idx = state.currentPhaseIndex;

    ctx.ui.notify(
      `Ralph loop: ${state.feature} — resuming Phase ${idx + 1}/${phases.length}`,
      "info",
    );

    // If the current phase was already started (idx matches), re-trigger it
    // so the agent picks up where it left off with fresh instructions.
    advanceToNextPhase(ctx);
  });

  // ── agent_end: deterministic phase advancement ──
  pi.on("agent_end", async (_event, ctx) => {
    const state = getState(ctx);
    if (!state) return;

    writeCountSinceGate = 0;

    const phases = state.phases && state.phases.length > 0 ? state.phases : ["spec", "redteam", "harden", "implement", "review"];
    const idx = state.currentPhaseIndex;
    const phaseKey = phases[idx];

    // Check for pipeline completion (review phase done)
    if (phaseKey === "review") {
      const entries = ctx.sessionManager.getBranch();
      const lastAssistant = [...entries].reverse().find(
        (e) => e.type === "message" && e.message?.role === "assistant",
      );
      if (lastAssistant && lastAssistant.message) {
        const text = lastAssistant.message.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("\n");

        if (text.includes("LGTM") || text.includes("pipeline complete")) {
          ctx.ui.notify(`✅ Pipeline complete for "${state.feature}"`, "success");
          ctx.ui.setStatus("ralph-loop", `✅ Done | ${state.feature}`);
          // Don't advance — we're done
          return;
        }
      }
    }

    // Run gates after implementation/remediation phases
    if (GATE_PHASES.has(phaseKey)) {
      ctx.ui.notify(`🚧 Post-phase gate check for "${phaseKey}"...`, "info");
      const results = runLintGates(state.workDir);
      const allPass = results.every((r) => r.pass);

      if (!allPass) {
        const failed = results.filter((r) => !r.pass).map((r) => r.name);
        ctx.ui.notify(`❌ Gate failure after phase: ${failed.join(", ")}`, "error");

        // Don't advance — stay on this phase, tell agent to fix gates
        pi.sendMessage(
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `⛔ GATE FAILURE after "${phaseKey}" phase.

${formatGateResults(results)}\n\nFix the above gate failures, then respond with "PHASE COMPLETE" when all gates pass.`,
              },
            ],
          },
          { triggerTurn: true, deliverAs: "steer" },
        );
        return;
      }

      ctx.ui.notify(`✅ Gates passed for "${phaseKey}" phase`, "success");
    }

    // Resolve artifacts produced by this phase and update state
    const newArtifacts = resolvePhaseArtifacts(state, phaseKey);
    const updatedState: PipelineState = {
      ...state,
      currentPhaseIndex: idx + 1,
      artifacts: { ...(state.artifacts || {}), ...newArtifacts },
    };
    saveState(pi, updatedState);

    // Advance to next phase
    advanceToNextPhase(ctx);
  });

  // ── tool_result: auto-gate during gate phases ──
  pi.on("tool_result", async (event, ctx) => {
    const state = getState(ctx);
    if (!state) return;

    const phases = state.phases && state.phases.length > 0 ? state.phases : ["spec", "redteam", "harden", "implement", "review"];
    const phaseKey = phases[state.currentPhaseIndex];

    if (!GATE_PHASES.has(phaseKey)) return;

    if (event.toolName === "write" || event.toolName === "edit") {
      writeCountSinceGate++;

      if (writeCountSinceGate >= GATE_THRESHOLD) {
        writeCountSinceGate = 0;
        ctx.ui.notify("🚧 Auto-gate: running lint checks...", "info");
        const results = runLintGates(state.workDir);
        const allPass = results.every((r) => r.pass);

        if (allPass) {
          ctx.ui.notify("✅ All gates passed", "success");
        } else {
          const failed = results.filter((r) => !r.pass).map((r) => r.name);
          ctx.ui.notify(`❌ Gate failure: ${failed.join(", ")}`, "error");

          pi.sendMessage(
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `⛔ Auto-gate failure:\n\n${formatGateResults(results)}\n\nFix the above issues and continue.`,
                },
              ],
            },
            { triggerTurn: true, deliverAs: "steer" },
          );
        }
      }
    } else if (!["write", "edit"].includes(event.toolName)) {
      writeCountSinceGate = 0;
    }
  });

  // ── Tool: ralph_gate_check ──────────────────────────────
  pi.registerTool({
    name: "ralph_gate_check",
    label: "Ralph Gate Check",
    description:
      "Run pre-commit quality gates (ruff check, ruff format, test suite). " +
      "Use after every implementation step and before proceeding to the next phase. " +
      "All gates must pass.",
    promptSnippet: "Run lint gates (ruff check, format, tests) — use after implementation/remediation",
    promptGuidelines: [
      "Call ralph_gate_check after completing any code changes during implement or review phases.",
      "Do not proceed to the next pipeline phase until all ralph_gate_check gates pass.",
      "If gates fail, fix the issues and re-run ralph_gate_check before continuing.",
    ],
    parameters: Type.Object({
      paths: Type.Optional(
        Type.Array(Type.String(), {
          description: "File or directory paths to check. Defaults to entire project ('.').",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const state = getState(ctx);
      if (!state) {
        return {
          content: [{ type: "text", text: "No active pipeline. Use /ralph start <feature> first." }],
        };
      }

      onUpdate?.({
        content: [{ type: "text", text: "🚧 Running lint gates..." }],
      });

      const results = runLintGates(state.workDir, params.paths);
      writeCountSinceGate = 0;

      const allPass = results.every((r) => r.pass);
      const failed = results.filter((r) => !r.pass);

      const report = [
        `## ${allPass ? "✅ All Gates Passed" : "❌ Gate Failures"}`,
        ``,
        `| Gate | Status |`,
        `|------|--------|`,
        ...results.map((r) => `| ${r.name} | ${r.pass ? "✅ PASS" : "❌ FAIL"} |`),
        ``,
      ];

      for (const f of failed) {
        report.push(`### ${f.name} output`);
        report.push("```");
        report.push(f.output.slice(0, 3000));
        report.push("```");
        report.push("");
      }

      if (allPass) {
        report.push("All quality gates passed.");
        ctx.ui.setStatus("ralph-loop", `✅ Gates clear`);
      } else {
        report.push(`\`Fix the above failures and re-run ralph_gate_check.\``);
        ctx.ui.setStatus("ralph-loop", `❌ Gates: ${failed.map((f) => f.name).join(", ")}`);
      }

      return {
        content: [{ type: "text", text: report.join("\n") }],
        details: { results, allPass },
      };
    },
  });

  // ── Command: /ralph ────────────────────────────────────
  pi.registerCommand("ralph", {
    description: "Dev-cycle pipeline (start <feature> [phases] | status | cancel | gate)",
    getArgumentCompletions: (prefix: string) => {
      const commands = ["start", "status", "cancel", "gate"];
      const phases = ["spec", "redteam", "harden", "implement", "review"];
      return [...commands, ...phases]
        .filter((i) => i.startsWith(prefix))
        .map((v) => ({ value: v, label: v }));
    },
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const subCmd = parts[0]?.toLowerCase();

      switch (subCmd) {
        case "start": {
          if (getState(ctx)) {
            ctx.ui.notify("Pipeline already running. /ralph cancel first.", "error");
            return;
          }

          const feature = parts[1];
          if (!feature) {
            ctx.ui.notify(
              'Usage: /ralph start <feature> [prompt-file-or-text] [spec,redteam,harden,implement,review]',
              "error",
            );
            return;
          }

          const validPhases = new Set(["spec", "redteam", "harden", "implement", "review"]);
          let phases: string[] = ["spec", "redteam", "harden", "implement", "review"];
          let promptText: string | undefined;

          if (parts[2]) {
            const maybePhases = parts[2].split(",").map((p) => p.trim());
            if (maybePhases.every((p) => validPhases.has(p))) {
              phases = maybePhases;
            } else {
              promptText = resolvePromptInput(parts[2], ctx.cwd);
              if (parts[3]) {
                const requested = parts[3].split(",").map((p) => p.trim());
                phases = requested.filter((p) => validPhases.has(p));
                if (!phases.length) {
                  phases = ["spec", "redteam", "harden", "implement", "review"];
                }
              }
            }
          }

          const state: PipelineState = {
            feature,
            workDir: ctx.cwd,
            phases,
            maxIterations: 10,
            startedAt: Date.now(),
            currentPhaseIndex: 0,
            promptText,
          };

          saveState(pi, state);

          const promptSource = promptText ? `(prompt: ${parts[2]})` : "";
          ctx.ui.notify(`Starting pipeline for "${feature}" (${phases.join(", ")}) ${promptSource}`, "info");
          refreshWidget(ctx, state);
          advanceToNextPhase(ctx);
          break;
        }

        case "gate": {
          const state = getState(ctx) || { workDir: ctx.cwd };
          const results = runLintGates(state.workDir, parts.slice(1));
          const allPass = results.every((r) => r.pass);

          ctx.ui.notify(
            allPass ? "✅ All gates passed" : `❌ Failed: ${results.filter((r) => !r.pass).map((r) => r.name).join(", ")}`,
            allPass ? "success" : "error",
          );
          ctx.ui.setWidget("ralph-gates", formatGateResults(results).split("\n").slice(0, 15));
          break;
        }

        case "status": {
          const state = getState(ctx);
          if (!state) {
            ctx.ui.notify("No active pipeline. Use /ralph start <feature>", "info");
            return;
          }

          const phases = state.phases && state.phases.length > 0 ? state.phases : ["spec", "redteam", "harden", "implement", "review"];
          const phaseName = PHASE_META[phases[state.currentPhaseIndex]]?.name ?? "(detecting)";
          ctx.ui.notify(
            `Feature: ${state.feature}\nCurrent: Phase ${state.currentPhaseIndex + 1}/${phases.length} — ${phaseName}\nPhases: ${phases.join(" → ")}\nStarted: ${new Date(state.startedAt).toISOString()}`,
            "info",
          );
          break;
        }

        case "cancel": {
          ctx.ui.setStatus("ralph-loop", "");
          ctx.ui.setWidget("ralph-loop", []);
          writeCountSinceGate = 0;
          ctx.ui.notify("Pipeline cancelled", "warning");
          break;
        }

        default: {
          const feature = subCmd;
          if (feature && !["status", "cancel", "gate"].includes(feature)) {
            // Shorthand: /ralph <feature> [prompt-file] [phases]
            let promptText: string | undefined;
            let phases: string[] = ["spec", "redteam", "harden", "implement", "review"];

            if (parts[1]) {
              const maybePhases = parts[1].split(",").map((p) => p.trim());
              const validPhases = new Set(["spec", "redteam", "harden", "implement", "review"]);
              if (!maybePhases.every((p) => validPhases.has(p))) {
                promptText = resolvePromptInput(parts[1], ctx.cwd);
              }
              if (parts[2]) {
                const requested = parts[2].split(",").map((p) => p.trim());
                phases = requested.filter((p) => validPhases.has(p));
                if (!phases.length) {
                  phases = ["spec", "redteam", "harden", "implement", "review"];
                }
              }
            }

            const state: PipelineState = {
              feature,
              workDir: ctx.cwd,
              phases,
              maxIterations: 10,
              startedAt: Date.now(),
              currentPhaseIndex: 0,
              promptText,
            };

            saveState(pi, state);
            refreshWidget(ctx, state);
            ctx.ui.notify(`Starting pipeline for "${feature}"`, "info");
            advanceToNextPhase(ctx);
          } else {
            ctx.ui.notify(
              "Usage: /ralph start <feature> [prompt-file] [phases]\n" +
                "   or: /ralph <feature> [prompt-file] [phases]\n" +
                "   or: /ralph gate | status | cancel\n" +
                "\nPrompt file: .md, .txt file describing the task\n" +
                "Phases: spec, redteam, harden, implement, review",
              "info",
            );
          }
        }
      }
    },
  });

  // ── Contribute skill paths for auto-discovery ──────────
  pi.on("resources_discover", async () => ({
    skillPaths: [SKILL_BASE],
  }));
}
