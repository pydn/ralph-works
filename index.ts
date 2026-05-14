/**
 * Ralph Loop Extension — Full dev-cycle pipeline inside pi.
 *
 * Runs all phases (spec → redteam → harden → implement → review) as a single
 * continuous agent workflow. No subprocess spawning, no TTY issues, full tool access.
 *
 * Features:
 *   - Pipeline command (/ralph start <feature>)
 *   - Pre/post lint gates (ruff check, format, tests)
 *   - Auto-gate after file writes during implementation phases
 *   - Skill injection via before_agent_start
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

interface PipelineState {
  feature: string;
  workDir: string;
  phases: string[];
  maxIterations: number;
  startedAt: number;
  currentPhase?: string;     // track which phase we're in for auto-gates
  currentPhaseIndex?: number; // 0-based index into phases[] (survives compaction)
  promptText?: string;       // task description from prompt file or inline arg
}

// Phase metadata
const PHASE_META: Record<string, { name: string; desc: string }> = {
  spec: { name: "Generate Spec", desc: "Create HTML engineering specification" },
  redteam: { name: "Red Team Audit", desc: "Adversarial security review of the spec" },
  harden: { name: "Harden Spec", desc: "Address audit findings, update spec with mitigations" },
  implement: { name: "TDD Implement", desc: "Implement via Red-Green-Refactor cycle" },
  review: { name: "Ralph Review Loop", desc: "Multi-pass PR review → remediate until LGTM" },
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
 * Detect which phase the LLM is likely in based on recent conversation.
 */
function detectCurrentPhase(ctx: ExtensionContext): string | null {
  const entries = ctx.sessionManager.getBranch();
  // Look for recent assistant messages mentioning a phase
  for (let i = entries.length - 1; i >= Math.max(0, entries.length - 20); i--) {
    const e = entries[i];
    if (e.type === "message" && e.message?.role === "assistant") {
      const text = e.message.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n")
        .toLowerCase();

      // Check for phase markers in conversation
      if (text.includes("phase 4") || text.includes("tdd implement")) return "implement";
      if (text.includes("phase 5") || text.includes("review loop") || text.includes("remediate")) return "review";
    }
  }
  return null;
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
 * Build the master pipeline prompt that instructs the LLM to execute all phases.
 */
function buildPipelinePrompt(state: PipelineState): string {
  const specFile = findLatestSpec(state.workDir);

  // Task definition section — injected into every phase so context is preserved
  const taskSection = state.promptText
    ? `## Feature Requirements\n\n${state.promptText}\n`
    : `## Feature Requirements\n\nFeature name: ${state.feature}\n(No detailed requirements provided — infer from codebase and spec)\n`;

  let phaseInstructions = "";

  if (state.phases.includes("spec")) {
    phaseInstructions += `## Phase 1: Generate Specification\n`;
    phaseInstructions += `Use the generate-spec skill to create an HTML engineering specification.\n`;
    phaseInstructions += `Feature: ${state.feature}\n`;
    phaseInstructions += `Save to: docs/specs/${state.feature}.html\n`;
    phaseInstructions += `Include: problem statement, proposed solution, implementation plan, risk assessment.\n\n`;
  }

  if (state.phases.includes("redteam")) {
    const target = specFile || `docs/specs/${state.feature}.html`;
    phaseInstructions += `## Phase 2: Red Team Audit\n`;
    phaseInstructions += `Conduct an adversarial security review of the specification.\n`;
    phaseInstructions += `Read: ${target}\n`;
    phaseInstructions += `Look for: logic gaps, security vulnerabilities, edge cases, scalability issues.\n`;
    phaseInstructions += `Mark findings as [CRITICAL] or [WARNING].\n`;
    phaseInstructions += `Save audit report to: docs/security/red-team-audit-${state.feature}.html\n\n`;
  }

  if (state.phases.includes("harden")) {
    phaseInstructions += `## Phase 3: Harden Specification\n`;
    phaseInstructions += `Read the red team audit findings and update the specification:\n`;
    phaseInstructions += `- Address every [CRITICAL] with specific mitigations\n`;
    phaseInstructions += `- Address every [WARNING] where practical\n`;
    phaseInstructions += `- Add a "Security Considerations" section for residual risks\n`;
    phaseInstructions += `- Write docs/specs/harden-changelog.md listing all changes\n\n`;
  }

  if (state.phases.includes("implement")) {
    const spec = specFile || `docs/specs/${state.feature}.html`;
    phaseInstructions += `## Phase 4: TDD Implementation\n`;
    phaseInstructions += `Implement the specification using strict Red-Green-Refactor:\n`;
    phaseInstructions += `1. Read ${spec} for requirements\n`;
    phaseInstructions += `2. For each requirement: write failing tests FIRST, then implement\n`;
    phaseInstructions += `3. After completing implementation, run \`ralph_gate_check\` to verify quality gates\n`;
    phaseInstructions += `4. If any gate fails, fix the issues and re-run \`ralph_gate_check\`\n`;
    phaseInstructions += `5. Only proceed after all gates pass\n`;
    phaseInstructions += `6. Commit with conventional commit messages\n\n`;
  }

  if (state.phases.includes("review")) {
    phaseInstructions += `## Phase 5: Ralph Review Loop\n`;
    phaseInstructions += `Run up to ${state.maxIterations} iterations:\n`;
    phaseInstructions += `1. Perform deep multi-pass PR review (Logic + Security + Style)\n`;
    phaseInstructions += `2. If [CRITICAL] issues found: fix via TDD, then run \`ralph_gate_check\`\n`;
    phaseInstructions += `3. Verify all gates pass before counting the iteration\n`;
    phaseInstructions += `4. If zero criticals and all gates pass: respond "LGTM — pipeline complete"\n`;
    phaseInstructions += `5. If max iterations reached without LGTM: note and recommend manual review\n`;
    phaseInstructions += `6. Record each iteration's findings in .ralph/dev-cycle-${state.feature}.md\n\n`;
  }

  return `# Ralph Dev-Cycle Pipeline

Execute the following phases **sequentially** for feature "${state.feature}". Complete each phase fully before moving to the next.

${taskSection}
## Workflow Rules
- Use your tools (read, write, edit, bash, find, grep) directly — no subprocess spawning needed
- **After every implementation/remediation step, run \`ralph_gate_check\`** to verify quality gates
- Do NOT proceed past implement or review phases without passing all gates
- For each phase: show what you're doing, execute it, report results
- After each phase, summarize what was accomplished before proceeding

## Anti-Shortcut Rules (read carefully)
- **DO NOT write a "Complete Summary" until ALL phases are actually executed**
- Validation results from Phase 4 (implement) are NOT the same as Phase 5 (review)
- Phase 5 requires a genuine multi-pass PR review, not just re-reporting gate results
- Only output "LGTM" as your FINAL response after completing every listed phase
- If you have remaining phases, keep working — do not summarize and stop early

## Quality Gates (via ralph_gate_check tool)
Run after implementation and after every remediation cycle:
1. \`uv run ruff check . --select E,F,W,I\` — lint errors (blocker)
2. \`uv run ruff format --check .\` — formatting (auto-fixed on failure)
3. \`uv run python -m unittest discover tests -v\` — test suite (blocker)

All gates must pass before proceeding to the next phase.

${phaseInstructions}
## Completion Checklist
After all phases: write .ralph/dev-cycle-${state.feature}.md summarizing the full pipeline run.
`;
}

// ── Extension ───────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Track file writes during implementation/remediation for auto-gating
  let writeCountSinceGate = 0;
  const GATE_THRESHOLD = 3; // Auto-run gate after N consecutive writes

  // Refresh the widget display with current phase info
  function refreshWidget(ctx: ExtensionContext, st: PipelineState) {
    const idx = st.currentPhaseIndex ?? 0;
    const phaseKey = st.phases[idx];
    const meta = PHASE_META[phaseKey];
    ctx.ui.setWidget(
      "ralph-loop",
      [
        `Pipeline: ${st.feature}`,
        `Phases: ${st.phases.join(" → ")}`,
        st.promptText ? `Prompt: (provided)` : `Prompt: (none — infer from codebase)`,
        `Started: ${new Date(st.startedAt).toISOString()}`,
        ``,
        `Progress: Phase ${idx + 1}/${st.phases.length} — ${meta?.name ?? "?"}`,
      ],
    );
  }

  // Restore state on session start (refreshes widget after compaction)
  pi.on("session_start", async (_event, ctx) => {
    const state = getState(ctx);
    if (state) {
      ctx.ui.notify(`Ralph loop: ${state.feature} (${state.phases.join(", ")})`, "info");
      ctx.ui.setStatus(
        "ralph-loop",
        `🔄 Ralph | ${state.feature} | phases: ${state.phases.join(",")}`,
      );
      refreshWidget(ctx, state);
    }
  });

  // Intercept write/edit tool results during gate phases → auto-gate
  pi.on("tool_result", async (event, ctx) => {
    if (!getState(ctx)) return;
    const state = getState(ctx);

    // Only auto-gate during implementation/remediation phases
    const detectedPhase = state.currentPhase || detectCurrentPhase(ctx);
    if (!detectedPhase || !GATE_PHASES.has(detectedPhase)) return;

    // Count write/edit operations
    if (event.toolName === "write" || event.toolName === "edit") {
      writeCountSinceGate++;

      // Auto-trigger gate after threshold writes
      if (writeCountSinceGate >= GATE_THRESHOLD) {
        writeCountSinceGate = 0;
        ctx.ui.notify("🚧 Auto-gate: running lint checks...", "info");
        ctx.ui.setStatus("ralph-loop", `🚧 Gate check...`);

        const results = runLintGates(state.workDir);
        const allPass = results.every((r) => r.pass);
        const failed = results.filter((r) => !r.pass).map((r) => r.name);

        if (allPass) {
          ctx.ui.notify("✅ All gates passed", "success");
          ctx.ui.setStatus("ralph-loop", `✅ Gates clear`);
        } else {
          ctx.ui.notify(`❌ Gate failure: ${failed.join(", ")}`, "error");
          ctx.ui.setStatus("ralph-loop", `❌ Gates failed: ${failed.join(", ")}`);

          // Steer the LLM to fix gate failures
          pi.sendMessage(
            {
              customType: "ralph-gate-failure",
              content: formatGateResults(results) + `\n\nFix the above gate failures and re-check.`,
              display: true,
            },
            { triggerTurn: true, deliverAs: "steer" },
          );
        }
      }
    } else {
      // Reset counter on non-write operations (bash, read, etc.)
      if (!["write", "edit"].includes(event.toolName)) {
        writeCountSinceGate = 0;
      }
    }
  });

  // Track agent completion for status updates
  pi.on("agent_end", async (_event, ctx) => {
    const state = getState(ctx);
    if (!state) return;

    // Reset write counter at phase boundaries
    writeCountSinceGate = 0;

    // Check for pipeline completion markers
    const entries = ctx.sessionManager.getBranch();
    const lastAssistant = [...entries].reverse().find(
      (e) => e.type === "message" && e.message?.role === "assistant",
    );

    if (lastAssistant && lastAssistant.message) {
      const text = lastAssistant.message.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");

      // Check for genuine pipeline completion (LGTM + review done)
      if ((text.includes("LGTM") || text.includes("pipeline complete")) && state.currentPhase === "review") {
        ctx.ui.notify(`✅ Ralph loop complete for "${state.feature}"`, "success");
        ctx.ui.setStatus("ralph-loop", `✅ Done | ${state.feature}`);
      }

      // Detect current phase from conversation context
      const detectedPhase = detectCurrentPhase(ctx);
      if (detectedPhase) {
        const idx = state.phases.indexOf(detectedPhase);
        if (idx >= 0 && idx !== state.currentPhaseIndex) {
          state.currentPhase = detectedPhase;
          state.currentPhaseIndex = idx;
          saveState(pi, state);
          refreshWidget(ctx, state);
        }
      }

      // Anti-shortcut: detect if agent wrote a "Complete Summary" but didn't finish all phases
      const currentIdx = state.currentPhaseIndex ?? 0;
      const unfinishedPhases = state.phases.slice(currentIdx + 1);
      if (unfinishedPhases.length > 0 && text.includes("Complete Summary") && text.includes("✅")) {
        // Agent wrote a summary claiming things are done, but phases remain
        const nextPhase = state.phases[currentIdx + 1];
        const meta = PHASE_META[nextPhase];
        ctx.ui.notify(
          `⚠️ Agent shortcut — Phase ${currentIdx + 2}/${state.phases.length} (${meta?.name}) not yet done`,
          "warning",
        );

        pi.sendMessage(
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `⛔ STOP — You wrote a summary but Phase ${currentIdx + 1}/${state.phases.length} (${meta?.name ?? nextPhase}) was not actually executed.\n\n**You still need to complete these phases:**\n${unfinishedPhases.map((p, i) => `- **Phase ${currentIdx + 2 + i}: ${PHASE_META[p]?.name ?? p}** — ${PHASE_META[p]?.desc ?? ""}`).join("\n")}\n\nStart Phase ${currentIdx + 2} (${meta?.name}) now. Do NOT write a summary until ALL phases are genuinely complete and you have output "LGTM" as your final response.`,
              },
            ],
          },
          { triggerTurn: true, deliverAs: "steer" },
        );
      }
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
      writeCountSinceGate = 0; // Reset auto-gate counter on explicit check

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

      // Include failure details
      for (const f of failed) {
        report.push(`### ${f.name} output`);
        report.push("```");
        report.push(f.output.slice(0, 3000)); // cap output size
        report.push("```");
        report.push("");
      }

      if (allPass) {
        report.push("All quality gates passed. Safe to proceed to the next phase.");
        ctx.ui.setStatus("ralph-loop", `✅ Gates clear`);
      } else {
        report.push(
          `\`Fix the above failures and re-run ralph_gate_check before proceeding.\``,
        );
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
      const items = [
        ...commands.map((c) => ({ value: c, label: c })),
        ...phases.map((p) => ({ value: p, label: p })),
      ];
      return items.filter((i) => i.value.startsWith(prefix));
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

          // Parse remaining args: arg2 could be prompt text or phase list
          if (parts[2]) {
            // Check if it's a phase list (comma-separated known phases)
            const maybePhases = parts[2].split(",").map((p) => p.trim());
            if (maybePhases.every((p) => validPhases.has(p))) {
              // It's phases — no prompt text
              phases = maybePhases;
            } else {
              // It's a prompt file path or inline description
              promptText = resolvePromptInput(parts[2], ctx.cwd);
              if (parts[3]) {
                const requested = parts[3].split(",").map((p) => p.trim());
                phases = requested.filter((p) => validPhases.has(p));
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

          const promptSource = promptText
            ? `(prompt: ${parts[2]})`
            : "";
          ctx.ui.notify(`Starting pipeline for "${feature}" (${phases.join(", ")}) ${promptSource}`, "info");
          ctx.ui.setStatus("ralph-loop", `🔄 Starting | ${feature}`);

          const prompt = buildPipelinePrompt(state);

          refreshWidget(ctx, state);

          pi.sendUserMessage(prompt);
          break;
        }

        case "gate": {
          // Standalone gate check (no pipeline required)
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

          const phaseName = PHASE_META[state.currentPhase]?.name ?? "(detecting)";
          const msg = [
            `Feature: ${state.feature}`,
            `Current: ${phaseName}`,
            `Phases: ${state.phases.join(" → ")}`,
            `Max review iterations: ${state.maxIterations}`,
            `Started: ${new Date(state.startedAt).toISOString()}`,
          ].join("\n");
          ctx.ui.notify(msg, "info");
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
              }
            }

            ctx.ui.notify(`Starting pipeline for "${feature}"`, "info");

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
            ctx.ui.setStatus("ralph-loop", `🔄 Starting | ${feature}`);
            refreshWidget(ctx, state);
            pi.sendUserMessage(buildPipelinePrompt(state));
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

  // ── Inject skills into system prompt before agent runs ──
  pi.on("before_agent_start", async (event, ctx) => {
    if (!getState(ctx)) return;

    const skillPaths = [
      path.join(SKILL_BASE, "generate-spec", "SKILL.md"),
      path.join(SKILL_BASE, "red-team-audit", "SKILL.md"),
      path.join(SKILL_BASE, "tdd-implement", "SKILL.md"),
      path.join(SKILL_BASE, "pi-skills", "pr-reviewer", "SKILL.md"),
    ];

    const skillContent = skillPaths
      .filter((p) => fs.existsSync(p))
      .map((p) => {
        try {
          return `--- Skill: ${path.basename(path.dirname(p))} ---\n${fs.readFileSync(p, "utf-8")}`;
        } catch {
          return "";
        }
      })
      .filter(Boolean)
      .join("\n\n");

    if (skillContent && !event.systemPrompt.includes("generate-spec")) {
      return {
        systemPrompt:
          event.systemPrompt +
          `\n\n<ralph-pipeline-skills>\nThe following skills are available for the Ralph pipeline. Follow their instructions when executing each phase:\n\n${skillContent}\n</ralph-pipeline-skills>`,
      };
    }
  });
}
