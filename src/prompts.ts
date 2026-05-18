import * as fs from "node:fs";
import * as path from "node:path";
import { PROMPT_FILE_EXTENSIONS, RENDER_HTML_FLAG, RENDER_PHASE, YOLO_FLAG } from "./config";
import type { PipelineState } from "./domain";
import { PHASE_CONFIGS } from "./phaseConfig";
import { PHASE_COMPLETE_MARKER, PHASE_ORDER, sanitizeFeatureName } from "./stateMachine";

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

/** Remove Ralph flags from positional args while returning their parsed values. */
export function parseRalphFlags(args: string[]): { args: string[]; renderHtml: boolean; yolo: boolean } {
  const filtered = args.filter((arg) => arg !== RENDER_HTML_FLAG && arg !== YOLO_FLAG);
  return {
    args: filtered,
    renderHtml: args.includes(RENDER_HTML_FLAG),
    yolo: args.includes(YOLO_FLAG),
  };
}

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
    case "implement":
      phaseContext = `## Task
Implement via Red-Green-Refactor.
Read spec: docs/specs/${state.feature}-final.html (HTML) or docs/specs/${state.feature}.md (markdown fallback)
Call the registered \`ralph_gate_check\` tool after implementation. Do not run \`ralph_gate_check\` in \`bash\`; it is a Pi extension tool, not a shell command.`;
      break;
    case "review":
      phaseContext = `## Task\nMulti-pass PR review. Call \`ralph_review_decision\` with status LGTM or CRITICAL.`;
      break;
  }
  const rules = [
    phaseKey === "implement"
      ? "- After implementation steps, call the registered `ralph_gate_check` tool. Do not run `ralph_gate_check` in `bash`."
      : "",
    phaseKey === "review"
      ? "- End the review by calling `ralph_review_decision` with status LGTM or CRITICAL."
      : `- When this phase is fully complete, end your final assistant message with the exact line \`${PHASE_COMPLETE_MARKER}\`. The controller will not advance automatically at turn end.`,
  ]
    .filter(Boolean)
    .join("\n");
  return `# Ralph Pipeline — Phase: ${cfg.displayName}\n\n${taskSection}\n\n## Skill Context\n<ralph-skill-instructions>\n${skillContent || "(Skill file not available)"}</ralph-skill-instructions>\n\n## Phase Instructions\n${phaseContext}\n\n## Rules\n${rules}`;
}
