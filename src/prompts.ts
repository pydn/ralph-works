import * as fs from "node:fs";
import * as path from "node:path";
import { PROMPT_FILE_EXTENSIONS, RENDER_PHASE } from "./config";
import type { PipelineState, RalphImplementationTask } from "./domain";
import { parseRalphFlags } from "./modelPlan";
import { PHASE_CONFIGS } from "./phaseConfig";
import { PHASE_COMPLETE_MARKER, PHASE_ORDER, resolveGateConfiguration, sanitizeFeatureName } from "./stateMachine";
import { formatExpectedArtifactPaths, getExpectedArtifactPaths } from "./workdir";

/**
 * Split slash-command arguments while preserving quoted prompt text.
 * This avoids the old whitespace-only parser losing multi-word prompts.
 */
export function parseCommandArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: string | undefined;
  let tokenStarted = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) {
        quote = undefined;
      } else if (ch === "\\" && input[i + 1] === quote) {
        current += input[i + 1];
        i += 1;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      tokenStarted = true;
    } else if (/\s/.test(ch)) {
      if (tokenStarted) {
        args.push(current);
        current = "";
        tokenStarted = false;
      }
    } else {
      current += ch;
      tokenStarted = true;
    }
  }

  if (tokenStarted) args.push(current);
  return args;
}

/**
 * Expand prompt-file arguments into prompt text, but only for safe files inside
 * the current workspace. Suspicious or missing paths fall back to literal text.
 */
export function resolvePromptInput(arg: string, wd: string): string | undefined {
  const ext = path.extname(arg).toLowerCase();
  if (PROMPT_FILE_EXTENSIONS.has(ext)) {
    const r = path.isAbsolute(arg) ? arg : path.join(wd, arg);
    const resolved = path.resolve(r);
    const wdirResolved = path.resolve(wd);
    if (!resolved.startsWith(wdirResolved)) return arg;
    if (/\.env|\.gitconfig|\.npmrc|id_rsa|\s+secrets/i.test(resolved)) return arg;
    if (fs.existsSync(r)) return fs.readFileSync(r, "utf-8").trim();
  }
  return arg;
}

export { parseRalphFlags };

/** Insert the optional render phase at its canonical point in the phase order. */
export function addRenderPhase(phases: string[]): string[] {
  if (phases.includes(RENDER_PHASE)) return [...phases];
  const renderOrder = PHASE_ORDER.findIndex((phase) => phase === RENDER_PHASE);
  const insertAt = phases.findIndex((phase) => {
    const phaseOrder = PHASE_ORDER.findIndex((knownPhase) => knownPhase === phase);
    return phaseOrder > renderOrder;
  });
  const idx = insertAt >= 0 ? insertAt : phases.length;
  return [...phases.slice(0, idx), RENDER_PHASE, ...phases.slice(idx)];
}

/** HTML rendering can only be enabled before the pipeline has passed render's slot. */
export function canAddRenderBeforeCurrentPhase(phases: string[], currentPhaseIndex: number): boolean {
  const currentPhase = phases[currentPhaseIndex];
  const currentOrder = PHASE_ORDER.findIndex((phase) => phase === currentPhase);
  const renderOrder = PHASE_ORDER.findIndex((phase) => phase === RENDER_PHASE);
  return currentOrder >= 0 && currentOrder < renderOrder;
}

/** Reconcile a saved current phase with a phase list that may have gained render. */
export function resolveCurrentPhaseIndex(state: PipelineState, phases: string[], fallbackIndex: number): number {
  if (state.currentPhase) {
    const currentPhaseIndex = phases.indexOf(state.currentPhase);
    if (currentPhaseIndex >= 0) return currentPhaseIndex;
  }
  return fallbackIndex;
}

function findLatestSpec(wd: string): string | null {
  const dir = path.join(wd, "docs", "specs");
  try {
    let files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
    if (!files.length) files = fs.readdirSync(dir).filter((f) => f.endsWith(".html"));
    if (!files.length) return null;
    const sorted = files
      .map((f) => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return `docs/specs/${sorted[0].name}`;
  } catch {
    return null;
  }
}

function formatSelectedTask(task: RalphImplementationTask): string {
  return [
    `id: ${task.id}`,
    `title: ${task.title}`,
    `priority: ${task.priority}`,
    `status: ${task.status}`,
    `source: ${task.source}`,
    `dependsOn: ${task.dependsOn.length ? task.dependsOn.join(", ") : "none"}`,
    `reviewFindingRef: ${task.reviewFindingRef ?? "none"}`,
    `filesHint: ${task.filesHint.length ? task.filesHint.join(", ") : "none"}`,
    "acceptanceCriteria:",
    ...task.acceptanceCriteria.map((item) => `- ${item}`),
    "testPlan:",
    ...task.testPlan.map((item) => `- ${item}`),
  ].join("\n");
}

/**
 * Build the phase prompt sent to the agent.
 *
 * This is intentionally self-contained: it embeds the selected skill content,
 * the user task, phase-specific artifact paths, and the exact completion rule
 * so reload and follow-up launches can rehydrate the agent from persisted state.
 */
export function buildPhasePrompt(phaseKey: string, state: PipelineState): string {
  const cfg = PHASE_CONFIGS[phaseKey];
  if (!cfg) return `Unknown phase: ${phaseKey}`;
  const taskSection = state.promptText
    ? `<description-start>\n${state.promptText}\n<description-end>`
    : `<description-start>\nFeature name: ${state.feature}\n(No detailed requirements provided — infer from codebase and spec)\n<description-end>`;
  let skillContent = "";
  if (fs.existsSync(cfg.skillPath)) {
    try {
      skillContent = fs.readFileSync(cfg.skillPath, "utf-8");
    } catch {}
  }
  const specFile = findLatestSpec(state.workDir);
  const auditFile = `docs/security/redteam-findings-${state.feature}.md`;
  const expectedArtifactSection = [
    "## Run Root and Artifacts",
    `Persisted workDir: ${state.workDir}`,
    formatExpectedArtifactPaths(getExpectedArtifactPaths(phaseKey, state)),
    "If you create or switch to a dedicated git worktree for this run, call the registered `ralph_set_workdir` tool with that worktree root before writing phase artifacts or completing the phase.",
  ].join("\n");
  let phaseContext = "";
  switch (phaseKey) {
    case "spec":
      phaseContext = `## Task\nCreate Markdown engineering specification.\nFeature: ${state.feature}\nSave to: docs/specs/${state.feature}.md`;
      break;
    case "redteam":
      phaseContext = `## Task\nAdversarial security review.\nRead: ${specFile || `docs/specs/${state.feature}.md`}\nMark [CRITICAL]/[WARNING].\nSave to: ${auditFile}`;
      break;
    case "harden":
      phaseContext = `## Task\nIntegrate red team findings into spec.\nRead findings: ${auditFile}\nPatch spec, write changelog, set YAML front matter \`status: hardened\``;
      break;
    case "tasks": {
      const sanitized = sanitizeFeatureName(state.feature);
      phaseContext = `## Task
Create a comprehensive implementation task ledger from the hardened spec.
Read: docs/specs/${state.feature}.md
Read harden changelog: docs/specs/harden-changelog-${state.feature}.md
Output: docs/specs/todo_${sanitized}.md
Requirements: strict Markdown task format, stable TASK-0001 IDs, priority/status/source metadata, acceptance criteria, and test plan for each task. Do not implement code in this phase.`;
      break;
    }
    case "render": {
      const sanitized = sanitizeFeatureName(state.feature);
      phaseContext = `## Task
Convert hardened markdown spec to polished HTML.
Read: docs/specs/${state.feature}.md
Output: docs/specs/${sanitized}-final.html
Requirements: Mermaid diagrams rendered, severity badges styled, responsive typography, print-friendly CSS
Use atomic write pattern: write to ${sanitized}-final.html.tmp then rename to final path.`;
      break;
    }
    case "implement": {
      const gateResolution = resolveGateConfiguration(state.workDir);
      const gateInstructions =
        gateResolution.errors.length > 0
          ? `ralph-works gate configuration is present but invalid at ${gateResolution.source}. Fix the configuration or rely on documented project commands before completing implementation.\nErrors:\n${gateResolution.errors.map((e) => `- ${e}`).join("\n")}`
          : gateResolution.gates.length > 0
            ? `Configured ralph-works gates are available through the registered \`ralph_gate_check\` tool.\nConfig source: ${gateResolution.source}\nCommands:\n${gateResolution.gates.map((g) => `- ${g.name}: ${g.command}`).join("\n")}\nIf the registered tool is not visible in your tool list, do not run \`ralph_gate_check\` in bash; continue with documented project commands and let the completion post-hook or operator run \`/ralph-works gate\`.`
            : "No ralph-works gates are configured for this workDir. Run the project's documented test commands manually during Red-Green-Refactor, and do not assume universal lint/typecheck/test defaults exist.";
      const selectedTaskSection =
        state.selectedTask && state.taskFile
          ? `## Selected Task
<selected_task>
${formatSelectedTask(state.selectedTask)}
</selected_task>

Task ledger: ${state.taskFile}

You may not implement adjacent pending tasks. If additional work is discovered, record it as a separate pending task in the task ledger.`
          : `## Selected Task
No selected task is persisted. Do not perform broad implementation; wait for Ralph to select a task from the task ledger.`;
      phaseContext = `${selectedTaskSection}

## Task
Implement via Red-Green-Refactor.
Read spec: docs/specs/${state.feature}-final.html (HTML) or docs/specs/${state.feature}.md (markdown fallback)
${gateInstructions}`;
      break;
    }
    case "review":
      phaseContext = `## Task\nMulti-pass PR review. Call \`ralph_review_decision\` with status LGTM or CRITICAL.`;
      break;
  }
  const rules = [
    phaseKey === "implement"
      ? "- Task-loop mode is active. Use configured ralph-works gates only when `.ralph/gate-config.json` exists. Otherwise run the repository's documented test commands manually. When the selected task is complete, end your final assistant message with exactly `RALPH_TASK_COMPLETE`, or use `RALPH_TASK_BLOCKED`, `RALPH_TASK_PARTIALLY_VERIFIED`, or `RALPH_TASK_NEEDS_FOLLOWUP` when that status is accurate. Do not use `RALPH_PHASE_COMPLETE` during implement."
      : "",
    phaseKey === "review"
      ? "- End the review by calling `ralph_review_decision` with status LGTM or CRITICAL."
      : phaseKey === "implement"
        ? ""
        : `- When this phase is fully complete, end your final assistant message with the exact line \`${PHASE_COMPLETE_MARKER}\`. The controller will not advance automatically at turn end.`,
  ]
    .filter(Boolean)
    .join("\n");
  return `# ralph-works Pipeline — Phase: ${cfg.displayName}\n\n${taskSection}\n\n${expectedArtifactSection}\n\n## Skill Context\n<ralph-skill-instructions>\n${skillContent || "(Skill file not available)"}</ralph-skill-instructions>\n\n## Phase Instructions\n${phaseContext}\n\n## Rules\n${rules}`;
}
