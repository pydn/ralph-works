/**
 * Ralph Loop Extension — Phase-state-machine pipeline inside pi.
 *
 * Deterministic state machine with pre-hook → execution → post-hook lifecycle.
 * Single-skill injection, structured review decisions, crash recovery.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as child from "node:child_process";
import { validatePhaseOrder, sanitizeErrorOutput, PHASE_META, DEFAULT_PHASES, sanitizeFeatureName, resolveGates, isValidTargetPath } from "./src/stateMachine";
import { wrapSteerMessage, MAX_STEER_SIZE, validatePhaseIndex, canClearContext, buildReorientationPrompt, resolveArtifactPaths } from "./src/steer";

// ── Constants ───────────────────────────────────────────────
const CUSTOM_TYPE = "ralph-loop-state";
const SKILL_BASE = process.env.PI_SKILL_BASE ?? path.join(os.homedir(), ".pi", "agent", "skills", "_global");
const MAX_PHASE_ATTEMPTS = 3;
const GATE_THRESHOLD = 3;
const GATE_PHASES = new Set(["implement", "review"]);
// Concurrency lock — module-level is safe: Pi runs single-threaded per process,
// and extension supports only one pipeline per session (AGENTS.md §Open Risks #4).
let isGating = false;

// ── Interfaces ──────────────────────────────────────────────
interface GateResult { name: string; pass: boolean; output: string; }
interface PostHookResult { pass: boolean; decision?: ReviewDecision; errors?: string[]; }
interface ReviewDecision { status: "LGTM" | "CRITICAL"; issues?: string[]; }

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
  currentPhase?: string;
  currentPhaseIndex?: number;
  phaseStatus?: string;      // "pre_hook" | "executing" | "post_hook"
  reviewIterations?: number;
  pipelineStatus?: string;   // "running"|"completed"|"halted"|"failed"|"cancelled"|"paused"
  phaseAttempts?: number;
  turnWriteCount?: number;
  promptText?: string;
  contextClearCount?: number;     // times context has been cleared (default: 0)
  autoClearContext?: boolean;      // auto-clear at phase boundaries (default: false)
  lastContextClearAt?: number;     // timestamp of most recent clear for rate-limiting
}

// ── Phase Metadata ──────────────────────────────────────────
// Imported from ./src/stateMachine (PHASE_META)

// ── Phase Config Registry ──────────────────────────────────
const PHASE_CONFIGS: Record<string, {
  displayName: string; desc: string; skillPath: string;
  preHook: (pk: string, s: PipelineState) => boolean;
  postHook: (pk: string, s: PipelineState) => PostHookResult;
}> = {
  spec: {
    displayName: "Generate Spec", desc: "Create Markdown engineering specification",
    skillPath: path.join(SKILL_BASE, "generate-spec", "SKILL.md"),
    preHook: (pk) => fs.existsSync(PHASE_CONFIGS[pk].skillPath),
    postHook: (_pk, s) => {
      const sp = path.join(s.workDir, "docs", "specs", `${s.feature}.md`);
      if (!fs.existsSync(sp)) return { pass: false, errors: [`Spec not found at ${sp}`] };
      if (fs.statSync(sp).size < 1024) return { pass: false, errors: ["Spec file too small (< 1KB)"] };
      return { pass: true };
    },
  },
  redteam: {
    displayName: "Red Team Audit", desc: "Adversarial security review of the spec",
    skillPath: path.join(SKILL_BASE, "red-team-audit", "SKILL.md"),
    preHook: (pk, s) => {
      if (!fs.existsSync(PHASE_CONFIGS[pk].skillPath)) return false;
      return fs.existsSync(path.join(s.workDir, "docs", "specs", `${s.feature}.md`));
    },
    postHook: (_pk, s) => {
      const ap = path.join(s.workDir, "docs", "security", `redteam-findings-${s.feature}.md`);
      if (!fs.existsSync(ap)) return { pass: false, errors: [`Audit report not found at ${ap}`] };
      const c = fs.readFileSync(ap, "utf-8");
      if (!c.includes("[CRITICAL]") && !c.includes("[WARNING]")) return { pass: false, errors: ["Missing severity tags"] };
      return { pass: true };
    },
  },
  harden: {
    displayName: "Harden Spec", desc: "Address audit findings, update spec with mitigations",
    skillPath: path.join(SKILL_BASE, "harden-spec", "SKILL.md"),
    preHook: (pk, s) => {
      if (!fs.existsSync(PHASE_CONFIGS[pk].skillPath)) return false;
      const sp = path.join(s.workDir, "docs", "specs", `${s.feature}.md`);
      const ap = path.join(s.workDir, "docs", "security", `redteam-findings-${s.feature}.md`);
      return fs.existsSync(sp) && fs.existsSync(ap);
    },
    postHook: (_pk, s) => {
      const sp = path.join(s.workDir, "docs", "specs", `${s.feature}.md`);
      const clp = path.join(s.workDir, "docs", "specs", `harden-changelog-${s.feature}.md`);
      if (!fs.existsSync(sp)) return { pass: false, errors: ["Hardened spec not found"] };
      if (!fs.existsSync(clp)) return { pass: false, errors: [`Changelog not found at ${clp}`] };
      if (!fs.readFileSync(sp, "utf-8").includes("HARDENED")) return { pass: false, errors: ["Spec missing HARDENED marker"] };
      return { pass: true };
    },
  },
  render: {
    displayName: "Render Markdown → HTML", desc: "Convert hardened markdown spec to polished HTML with Mermaid diagrams and typography",
    skillPath: path.join(SKILL_BASE, "markdown-to-html", "SKILL.md"),
    preHook: (_pk, s) => {
      if (!fs.existsSync(PHASE_CONFIGS["render"].skillPath)) return false;
      const sp = path.join(s.workDir, "docs", "specs", `${s.feature}.md`);
      if (!fs.existsSync(sp)) return false;
      // HARDENED marker check — prevents converting un-audited specs
      if (!fs.readFileSync(sp, "utf-8").includes("HARDENED")) return false;
      return true;
    },
    postHook: (_pk, s) => {
      const sanitized = sanitizeFeatureName(s.feature);
      const htmlPath = path.join(s.workDir, "docs", "specs", `${sanitized}-final.html`);
      if (!fs.existsSync(htmlPath)) return { pass: false, errors: [`Rendered HTML not found at ${htmlPath}`] };
      const stat = fs.statSync(htmlPath);
      if (stat.size < 2048) return { pass: false, errors: [`File size: ${(stat.size / 1024).toFixed(1)}KB, minimum: 2KB`] };
      const content = fs.readFileSync(htmlPath, "utf-8");
      if (!content.includes("<") || !content.includes(">")) return { pass: false, errors: ["Output does not appear to be valid HTML"] };
      if (!content.includes("</html>")) return { pass: false, errors: ["Missing </html> closing tag — document may be truncated"] };
      if (!content.includes("</body>")) return { pass: false, errors: ["Missing </body> closing tag — document may be truncated"] };
      return { pass: true };
    },
  },
  implement: {
    displayName: "TDD Implement", desc: "Implement via Red-Green-Refactor cycle",
    skillPath: path.join(SKILL_BASE, "tdd-implement", "SKILL.md"),
    preHook: (pk) => fs.existsSync(PHASE_CONFIGS[pk].skillPath),
    postHook: (_pk, s) => {
      const r = runLintGates(s.workDir);
      if (!r.every(x => x.pass)) return { pass: false, errors: r.filter(x => !x.pass).map(x => `${x.name}: ${x.output.slice(0,200)}`) };
      return { pass: true };
    },
  },
  review: {
    displayName: "Ralph Review Loop", desc: "Multi-pass PR review → remediate until LGTM",
    skillPath: path.join(SKILL_BASE, "pi-skills", "pr-reviewer", "SKILL.md"),
    preHook: (pk) => fs.existsSync(PHASE_CONFIGS[pk].skillPath),
    postHook: () => ({ pass: true }), // controlled by ralph_review_decision tool
  },
};

// ── Helpers ───────────────────────────────────────────────

function getState(ctx: ExtensionContext): PipelineState | null {
  let latest = null;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === CUSTOM_TYPE && entry.data) latest = entry.data as PipelineState;
  }
  return latest;
}

function saveState(pi: ExtensionAPI, state: PipelineState) { pi.appendEntry(CUSTOM_TYPE, state); }

function findLatestSpec(wd: string): string | null {
  const dir = path.join(wd, "docs", "specs");
  try {
    let files = fs.readdirSync(dir).filter(f => f.endsWith(".md"));
    if (!files.length) files = fs.readdirSync(dir).filter(f => f.endsWith(".html"));
    if (!files.length) return null;
    const sorted = files.map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
    return `docs/specs/${sorted[0].name}`;
  } catch { return null; }
}

// sanitizeErrorOutput imported from ./src/stateMachine

function runShell(cmd: string, cwd: string, timeoutMs?: number): { ok: boolean; output: string } {
  try {
    const o = child.execSync(cmd, { cwd, encoding: "utf-8", timeout: timeoutMs ?? 300_000, maxBuffer: 2*1024*1024 });
    return { ok: true, output: o.trim() };
  } catch (err: any) {
    return { ok: err.signal ? false : err.status !== 0, output: sanitizeErrorOutput((err.stdout ?? "") + (err.stderr ?? "") + (err.message ?? "")) };
  }
}

function runLintGates(wd: string, targetPaths?: string[]): GateResult[] {
  // Concurrency lock — prevents auto-gate + manual tool from running simultaneously
  if (isGating) {
    return [{ name: "skip", pass: true, output: "Gate check already running — skipping." }];
  }
  isGating = true;

  try {
    const gates = resolveGates(wd);
    const results: GateResult[] = [];

    for (const gate of gates) {
      // Build command with optional target paths
      let cmd = gate.command;
      if (targetPaths && targetPaths.length > 0) {
        // Only append paths to commands that support file targeting
        const firstToken = gate.command.trim().split(/\s+/)[0];
        const supportedCmds = new Set(["tsc", "eslint", "ruff", "flake8", "pylint"]);
        if (supportedCmds.has(firstToken)) {
          // Sanitize paths — reject any containing shell metacharacters
          const safePaths = targetPaths.filter(p => isValidTargetPath(p));
          if (safePaths.length > 0) {
            cmd += " " + safePaths.join(" ");
          }
        }
      }

      const timeout = gate.timeoutMs || 60_000;
      const rc = runShell(cmd, wd, timeout);
      results.push({ name: gate.name, pass: rc.ok, output: sanitizeErrorOutput(rc.output || "") });
    }

    return results;
  } finally {
    isGating = false;
  }
}

function formatGateResults(results: GateResult[]): string {
  const rows = results.map(r => `| ${r.name} | ${r.pass ? "✅ PASS" : "❌ FAIL"} |`);
  return `## Lint Gate Results\n\n| Gate | Status |\n|------|--------|\n${rows.join("\n")}\n\n${results.map(r => r.pass ? "" : `\`\`\`\n${r.name} output:\n${r.output}\n\`\`\``).join("\n\n")}`;
}

function resolvePromptInput(arg: string, wd: string): string | undefined {
  // Only treat as file path if it looks like one
  if (arg.includes("/") || arg.includes(".")) {
    const r = path.isAbsolute(arg) ? arg : path.join(wd, arg);
    const resolved = path.resolve(r);
    // Security: block reads outside workDir and sensitive files
    const wdirResolved = path.resolve(wd);
    if (!resolved.startsWith(wdirResolved)) return arg; // path traversal attempt
    if (/\.env|\.gitconfig|\.npmrc|id_rsa|\s+secrets/i.test(resolved)) return arg; // sensitive file
    if (fs.existsSync(r)) return fs.readFileSync(r, "utf-8").trim();
  }
  return arg;
}

// ── State Machine Core ─────────────────────────────────────
// validatePhaseOrder imported from ./src/stateMachine

function buildPhasePrompt(phaseKey: string, state: PipelineState): string {
  const cfg = PHASE_CONFIGS[phaseKey];
  if (!cfg) return `Unknown phase: ${phaseKey}`;
  const taskSection = state.promptText
    ? `<description-start>\n${state.promptText}\n<description-end>`
    : `<description-start>\nFeature name: ${state.feature}\n(No detailed requirements provided — infer from codebase and spec)\n<description-end>`;
  let skillContent = "";
  if (fs.existsSync(cfg.skillPath)) { try { skillContent = fs.readFileSync(cfg.skillPath, "utf-8"); } catch {} }
  const specFile = findLatestSpec(state.workDir);
  const auditFile = `docs/security/redteam-findings-${state.feature}.md`;
  let phaseContext = "";
  switch (phaseKey) {
    case "spec": phaseContext = `## Task\nCreate Markdown engineering specification.\nFeature: ${state.feature}\nSave to: docs/specs/${state.feature}.md`; break;
    case "redteam": phaseContext = `## Task\nAdversarial security review.\nRead: ${specFile || `docs/specs/${state.feature}.md`}\nMark [CRITICAL]/[WARNING].\nSave to: ${auditFile}`; break;
    case "harden": phaseContext = `## Task\nIntegrate red team findings into spec.\nRead findings: ${auditFile}\nPatch spec, write changelog, mark HARDENED`; break;
    case "render": {
      const sanitized = sanitizeFeatureName(state.feature);
      phaseContext = `## Task
Convert hardened markdown spec to polished HTML.
Read: docs/specs/${state.feature}.md
Output: docs/specs/${sanitized}-final.html
Requirements: Mermaid diagrams rendered, severity badges styled, responsive typography, print-friendly CSS
Use atomic write pattern: write to ${sanitized}-final.html.tmp then rename to final path.`; break;
    }
    case "implement": phaseContext = `## Task
Implement via Red-Green-Refactor.
Read spec: docs/specs/${state.feature}-final.html (HTML) or docs/specs/${state.feature}.md (markdown fallback)
Run \`ralph_gate_check\` after implementation.`; break;
    case "review": phaseContext = `## Task\nMulti-pass PR review. Call \`ralph_review_decision\` with status LGTM or CRITICAL.`; break;
  }
  return `# Ralph Pipeline — Phase: ${cfg.displayName}\n\n${taskSection}\n\n## Skill Context\n<ralph-skill-instructions>\n${skillContent || "(Skill file not available)"}</ralph-skill-instructions>\n\n## Phase Instructions\n${phaseContext}\n\n## Rules\n- After implementation steps, run \`ralph_gate_check\`\n- Complete this phase fully. Extension controller advances phases.`;
}

function runPreHook(phaseKey: string, state: PipelineState): boolean {
  const cfg = PHASE_CONFIGS[phaseKey];
  if (!cfg || (cfg.skillPath && !fs.existsSync(cfg.skillPath))) return false;
  return cfg.preHook(phaseKey, state);
}

function runPostHook(phaseKey: string, state: PipelineState): PostHookResult {
  const cfg = PHASE_CONFIGS[phaseKey];
  if (!cfg) return { pass: false, errors: [`Unknown phase config for ${phaseKey}`] };
  return cfg.postHook(phaseKey, state);
}

function advancePhase(pi: ExtensionAPI, ctx: ExtensionContext, state: PipelineState) {
  const phases = state.phases?.length ? state.phases : DEFAULT_PHASES;
  const idx = state.currentPhaseIndex ?? 0;
  if (idx >= phases.length - 1) {
    const u = { ...state, pipelineStatus: "completed", phaseStatus: "post_hook" };
    saveState(pi, u); refreshWidget(ctx, u);
    ctx.ui.notify(`✅ Ralph loop complete for "${state.feature}"`, "info");
    ctx.ui.setStatus("ralph-loop", `✅ Done | ${state.feature}`);
    writeDevCycleSummary(state);
    writeMetrics(state);
    return;
  }
  const nextIdx = idx + 1;
  const nextPhase = phases[nextIdx];
  const meta = PHASE_META[nextPhase];
  const u: PipelineState = { ...state, currentPhaseIndex: nextIdx, currentPhase: nextPhase, phaseStatus: "pre_hook", phaseAttempts: 0, turnWriteCount: 0 };
  saveState(pi, u); refreshWidget(ctx, u);
  ctx.ui.notify(`→ Phase ${nextIdx+1}/${phases.length} (${meta?.name ?? nextPhase})`, "info");

  // Auto-clear at phase boundary (except implement→review transition)
  // Check BEFORE pre_hook blocks it: pass "executing" so cooldown/status gates still apply
  const prevPhase = phases[idx];
  if (state.autoClearContext && !(prevPhase === "implement" && nextPhase === "review")) {
    const autoCheckState = { ...u, phaseStatus: "executing" } as PipelineState;
    const autoCheck = canClearContext(autoCheckState);
    if (autoCheck.ok) {
      const piAny = pi as any;
      ctx.compact({
        customInstructions: "Preserve pipeline phase context. Focus on transitioning to the new phase.",
        onComplete: () => {
          try {
            // Re-validate cooldown before committing (race guard)
            if (!canClearContext(autoCheckState).ok) return; // skip — manual clear raced ahead
            const prompt = buildReorientationPrompt(u);
            piAny.sendMessage({ role: "user", content: [{ type: "text", text: wrapSteerMessage(prompt, MAX_STEER_SIZE) }] }, { triggerTurn: true, deliverAs: "steer" });
            const updated = { ...u, contextClearCount: (u.contextClearCount ?? 0) + 1, lastContextClearAt: Date.now() };
            saveState(pi, updated);
            refreshWidget(ctx, updated);
          } catch (e) {
            // Silent failure — auto-clear is best-effort
          }
        },
      });
    }
  }
}

function handleReviewDecision(pi: ExtensionAPI, ctx: ExtensionContext, params: { status: string; issues?: string[] }) {
  const state = getState(ctx);
  if (!state) return;
  // Phase gate — reject decisions from non-review phases
  if (state.currentPhase !== "review") {
    ctx.ui.notify(`ERROR: ralph_review_decision can only be called during review phase (current: ${state.currentPhase}).`, "error");
    return;
  }
  const status = params.status as "LGTM" | "CRITICAL";
  const iter = state.reviewIterations ?? 0;
  if (status === "LGTM") {
    const u = { ...state, pipelineStatus: "completed", phaseStatus: "post_hook" };
    saveState(pi, u); refreshWidget(ctx, u);
    ctx.ui.notify(`✅ Ralph loop complete for "${state.feature}"`, "info");
    ctx.ui.setStatus("ralph-loop", `✅ Done | ${state.feature}`);
    writeDevCycleSummary(state);
    writeMetrics(state);
  } else if (status === "CRITICAL") {
    const maxIters = state.maxIterations ?? 10;
    if (iter >= maxIters) { ctx.ui.notify(`Max review iterations (${maxIters}) reached — halted.`, "error"); saveState(pi, { ...state, pipelineStatus: "halted" }); return; }
    const phases = state.phases ?? DEFAULT_PHASES;
    const implIdx = phases.indexOf("implement");
    const u: PipelineState = { ...state, currentPhaseIndex: implIdx >= 0 ? implIdx : 3, currentPhase: "implement", phaseStatus: "pre_hook", reviewIterations: iter + 1, phaseAttempts: 0, turnWriteCount: 0 };
    saveState(pi, u); refreshWidget(ctx, u);
    ctx.ui.notify(`⚠️ Review CRITICAL (iteration ${iter+1}/${maxIters}) — backtracking to implement`, "warning");
    const prompt = buildPhasePrompt("implement", u);
    const steerText = params.issues?.length ? `\n\nCRITICAL issues:\n${params.issues.map(i => `- ${i}`).join("\n")}` : "";
    (pi as any).sendMessage({ role: "user", content: [{ type: "text", text: `⛔ REVIEW CRITICAL — Backtrack to implement.\n\n${prompt}${steerText}` }] }, { triggerTurn: true, deliverAs: "steer" });
  }
}

async function handleAgentEnd(pi: ExtensionAPI, ctx: ExtensionContext) {
  const state = getState(ctx);
  if (!state) return;
  const updated = { ...state, turnWriteCount: 0 };
  const phases = updated.phases?.length ? updated.phases : DEFAULT_PHASES;
  const idx = updated.currentPhaseIndex ?? 0;
  const pk = phases[idx];
  if (pk) {
    const result = runPostHook(pk, updated);
    if (result.pass) { writePhaseCompletionMarker(pk, state.workDir); advancePhase(pi, ctx, { ...updated, pipelineStatus: "running" }); }
    else {
      const attempts = updated.phaseAttempts ?? 0;
      if (attempts >= MAX_PHASE_ATTEMPTS) { ctx.ui.notify(`Phase "${pk}" failed ${MAX_PHASE_ATTEMPTS} times — halted.`, "error"); saveState(pi, { ...updated, pipelineStatus: "failed", phaseStatus: "post_hook" }); return; }
      const errList = result.errors?.map(e => `- ${e}`).join("\n") || "Unknown error";
      ctx.ui.notify(`Post-hook failed for "${pk}" (attempt ${attempts+1}/${MAX_PHASE_ATTEMPTS})`, "warning");
      (pi as any).sendMessage({ role: "user", content: [{ type: "text", text: `⛔ Phase validation failed:\n\n${errList}\nFix and retry. Run \`ralph_gate_check\` after.` }] }, { triggerTurn: true, deliverAs: "steer" });
      saveState(pi, { ...updated, phaseAttempts: attempts + 1 });
    }
  }
}

function writePhaseCompletionMarker(phaseKey: string, workDir: string): void {
  const ralphDir = path.join(workDir, ".ralph");
  if (!fs.existsSync(ralphDir)) fs.mkdirSync(ralphDir, { recursive: true });
  const markerPath = path.join(ralphDir, `.phase-${phaseKey}-done`);
  const tmpPath = `${markerPath}.tmp`;
  const data = { phase: phaseKey, completedAt: Date.now(), attemptNumber: 1 };
  try { fs.writeFileSync(tmpPath, JSON.stringify(data), "utf-8"); fs.renameSync(tmpPath, markerPath); } catch {}
  // Log to .ralph/phase-attempts.json
  const logPath = path.join(ralphDir, "phase-attempts.json");
  try { let log: any[] = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, "utf-8")) : []; log.push({ ...data, logType: "completion" }); fs.writeFileSync(logPath, JSON.stringify(log, null, 2), "utf-8"); } catch {}
}

function writeDevCycleSummary(state: PipelineState): void {
  const ralphDir = path.join(state.workDir, ".ralph");
  if (!fs.existsSync(ralphDir)) fs.mkdirSync(ralphDir, { recursive: true });
  const phases = state.phases ?? DEFAULT_PHASES;
  const phaseResults = phases.map(p => `- ${PHASE_META[p]?.name ?? p}: ${fs.existsSync(path.join(ralphDir, `.phase-${p}-done`)) ? "✅ Completed" : "❌ Not completed"}`).join("\n");
  try { fs.writeFileSync(path.join(ralphDir, `dev-cycle-${state.feature}.md`), `# Dev-Cycle Summary: ${state.feature}\n\n**Started:** ${new Date(state.startedAt).toISOString()}\n**Completed:** ${new Date().toISOString()}\n**Review Iterations:** ${state.reviewIterations ?? 0}\n\n## Phases\n${phaseResults}`, "utf-8"); } catch {}
}

// ── Metrics Export (per spec task #12) ─────────────────────

function writeMetrics(state: PipelineState): void {
  const ralphDir = path.join(state.workDir, ".ralph");
  if (!fs.existsSync(ralphDir)) fs.mkdirSync(ralphDir, { recursive: true });
  const phases = state.phases ?? DEFAULT_PHASES;
  const phaseDurations: Record<string, number> = {};
  for (const p of phases) {
    const markerPath = path.join(ralphDir, `.phase-${p}-done`);
    if (fs.existsSync(markerPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(markerPath, "utf-8"));
        phaseDurations[p] = data.completedAt ?? 0;
      } catch {}
    }
  }
  let gateCount = 0;
  try {
    const logPath = path.join(ralphDir, "phase-attempts.json");
    if (fs.existsSync(logPath)) {
      const log: any[] = JSON.parse(fs.readFileSync(logPath, "utf-8"));
      gateCount = log.filter((e: any) => e.logType === "completion").length;
    }
  } catch {}
  const metrics = {
    feature: state.feature,
    startedAt: state.startedAt,
    completedAt: Date.now(),
    durationMs: Date.now() - state.startedAt,
    phases,
    phaseDurations,
    reviewIterations: state.reviewIterations ?? 0,
    phaseAttempts: state.phaseAttempts ?? 0,
    gateCount,
  };
  try { fs.writeFileSync(path.join(ralphDir, `metrics-${state.feature}.json`), JSON.stringify(metrics, null, 2), "utf-8"); } catch {}
}

function checkPipelineLock(feature: string, wd: string): { locked: boolean; stale?: boolean } {
  const lp = path.join(wd, ".ralph", `pipeline-lock-${feature}`);
  if (!fs.existsSync(lp)) return { locked: false };
  try { const s = fs.statSync(lp); return { locked: true, stale: (Date.now() - s.mtimeMs) > 24*60*60*1000 }; } catch { return { locked: false }; }
}

function createPipelineLock(feature: string, wd: string): boolean {
  const ralphDir = path.join(wd, ".ralph");
  if (!fs.existsSync(ralphDir)) fs.mkdirSync(ralphDir, { recursive: true });
  try { fs.writeFileSync(path.join(ralphDir, `pipeline-lock-${feature}`), JSON.stringify({ feature, createdAt: Date.now() }), "utf-8"); return true; } catch { return false; }
}

function removePipelineLock(feature: string, wd: string): void {
  const lp = path.join(wd, ".ralph", `pipeline-lock-${feature}`);
  try { if (fs.existsSync(lp)) fs.unlinkSync(lp); } catch {}
}

// ── Widget ──────────────────────────────────────────────────

function refreshWidget(ctx: ExtensionContext, st: PipelineState) {
  const phases = st.phases?.length ? st.phases : DEFAULT_PHASES;
  const idx = st.currentPhaseIndex ?? 0;
  const meta = PHASE_META[phases[idx]];
  ctx.ui.setWidget("ralph-loop", [
    `Pipeline: ${st.feature}`, `Phases: ${phases.join(" → ")}`,
    st.promptText ? `Prompt: (provided)` : `Prompt: (none)`,
    `Started: ${new Date(st.startedAt).toISOString()}`,
    `Status: ${st.pipelineStatus ?? "running"} | Phase: ${st.phaseStatus ?? "executing"}`, "",
    `Progress: Phase ${idx+1}/${phases.length} — ${meta?.name ?? "?"}`,
    st.reviewIterations ? `Review iterations: ${st.reviewIterations}` : "",
    st.phaseAttempts && st.phaseAttempts > 0 ? `Phase attempts: ${st.phaseAttempts}` : "",
    st.contextClearCount && st.contextClearCount > 0 ? `Context clears: ${st.contextClearCount}` : "",
  ].filter(Boolean));
}

// ── Extension Entry Point ──────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Note: turnWriteCount is tracked in PipelineState, not module-level,
  // to survive page reloads and session compaction.

  pi.on("message_start", async (event, ctx) => {
    const state = getState(ctx);
    if (!state || event.message.role !== "assistant") return;
    saveState(pi, { ...state, turnWriteCount: 0 });
  });

  pi.on("message_update", async (_event, ctx) => {
    const state = getState(ctx);
    if (!state || _event.message.role !== "assistant") return;
    refreshWidget(ctx, state);
  });

  pi.on("session_start", async (_event, ctx) => {
    const state = getState(ctx);
    if (!state) return;
    const phases = state.phases?.length ? state.phases : DEFAULT_PHASES;
    ctx.ui.notify(`Ralph loop: ${state.feature} (${phases.join(", ")})`, "info");
    ctx.ui.setStatus("ralph-loop", `🔄 Ralph | ${state.feature}`);
    refreshWidget(ctx, state);

    // Auto-resume if phase was executing when session reloaded
    const ps = state.phaseStatus;
    const currentIdx = state.currentPhaseIndex ?? 0;

    // Guard against corrupted phase index from aggressive compaction
    if (!validatePhaseIndex(currentIdx, phases)) {
      ctx.ui.notify(`⛔ Pipeline state corrupted: currentPhaseIndex=${currentIdx} out of bounds. Run /ralph cancel to reset.`, "error");
      saveState(pi, { ...state, pipelineStatus: "failed", phaseStatus: "corrupted" });
      return;
    }

    if (ps === "executing" || ps === "pre_hook") {
      const pk = phases[currentIdx];
      const phasePrompt = buildPhasePrompt(pk, state);
      const steerText = wrapSteerMessage(
        `⛔ SESSION RELOAD — Resuming Phase ${currentIdx + 1}: ${PHASE_META[pk]?.name}.

You were interrupted mid-phase. The phase-specific instructions are below — follow them completely before the extension advances you to the next phase.

---

${phasePrompt}`,
        MAX_STEER_SIZE
      );
      ctx.ui.notify(`Resuming Phase ${currentIdx+1} (${PHASE_META[pk]?.name})`, "warning");
      (pi as any).sendMessage({ role: "user", content: [{ type: "text", text: steerText }] }, { triggerTurn: true, deliverAs: "steer" });
    }

    // Check for unfinished phases (agent may have shortcut)
    const unfinished = phases.slice(currentIdx + 1);
    if (unfinished.length > 0 && ps === "post_hook") {
      const nextPhaseKey = phases[currentIdx + 1];
      const phasePrompt = buildPhasePrompt(nextPhaseKey, state);
      const steerText = wrapSteerMessage(
        `⛔ PIPELINE RESUMPTION — You skipped a phase. Remaining: ${unfinished.join(", ")}.
Start with the next required phase now. Full instructions below:

---

${phasePrompt}`,
        MAX_STEER_SIZE
      );
      (pi as any).sendMessage({ role: "user", content: [{ type: "text", text: steerText }] }, { triggerTurn: true, deliverAs: "steer" });
    }
  });

  // Auto-gate on write operations during gate phases
  pi.on("tool_result", async (event, ctx) => {
    const state = getState(ctx);
    if (!state) return;
    if (!GATE_PHASES.has(state.currentPhase ?? "")) return;
    const currentCount = state.turnWriteCount ?? 0;
    if (event.toolName === "write" || event.toolName === "edit") {
      const newCount = currentCount + 1;
      if (newCount >= GATE_THRESHOLD) {
        saveState(pi, { ...state, turnWriteCount: 0 });
        ctx.ui.notify("🚧 Auto-gate: running lint checks...", "info");
        const results = runLintGates(state.workDir);
        if (results.every(r => r.pass)) { ctx.ui.notify("✅ All gates passed", "info"); }
        else { ctx.ui.notify(`❌ Gate failure: ${results.filter(r => !r.pass).map(r => r.name).join(", ")}`, "error"); (pi as any).sendMessage({ role: "user", content: [{ type: "text", text: formatGateResults(results) + "\n\nFix and re-check." }]}, { triggerTurn: true, deliverAs: "steer" }); }
      }
      saveState(pi, { ...state, turnWriteCount: newCount });
    } else {
      saveState(pi, { ...state, turnWriteCount: 0 });
    }
  });

  // Agent end → post-hook → state machine advance
  pi.on("agent_end", async (_event, ctx) => {
    const state = getState(ctx);
    if (!state) return;
    saveState(pi, { ...state, turnWriteCount: 0 });
    await handleAgentEnd(pi, ctx);
  });

  // ── Tool: ralph_gate_check ──────────────────────────────
  pi.registerTool({
    name: "ralph_gate_check", label: "Ralph Gate Check",
    description: "Run quality gates (tsc --noEmit, vitest run). Use after every implementation step.",
    promptSnippet: "Run lint gates — use after implementation/remediation",
    parameters: Type.Object({ paths: Type.Optional(Type.Array(Type.String())) }),
    // @ts-expect-error strict Pi SDK type mismatch on execute return
    async execute(_id, params, _sig, onUpdate, ctx) {
      const state = getState(ctx);
      if (!state) return { content: [{ type: "text", text: "No active pipeline." }] };
      ((onUpdate as any) as Function)?.({ content: [{ type: "text", text: "🚧 Running lint gates..." }] });
      const results = runLintGates(state.workDir, params.paths);
      saveState(pi, { ...state, turnWriteCount: 0 });
      const allPass = results.every(r => r.pass);
      const failed = results.filter(r => !r.pass);
      const report = [`## ${allPass ? "✅ All Gates Passed" : "❌ Gate Failures"}`, "", `| Gate | Status |`, `|------|--------|`, ...results.map(r => `| ${r.name} | ${r.pass ? "✅ PASS" : "❌ FAIL"} |`), ""];
      for (const f of failed) report.push(`\`${f.output.slice(0,3000)}\``);
      report.push(allPass ? "All gates passed. Proceed to next phase." : "Fix failures and re-run ralph_gate_check.");
      ctx.ui.setStatus("ralph-loop", allPass ? `✅ Gates clear` : `❌ Gates: ${failed.map(f => f.name).join(", ")}`);
      return { content: [{ type: "text", text: report.join("\n") }], details: { results, allPass } };
    },
  });

  // ── Tool: ralph_review_decision ────────────────────────
  pi.registerTool({
    name: "ralph_review_decision", label: "Ralph Review Decision",
    description: "Submit final review verdict. Only call during review phase.",
    parameters: Type.Object({ status: Type.Union([Type.Literal("LGTM"), Type.Literal("CRITICAL")]), issues: Type.Optional(Type.Array(Type.String())) }),
    // @ts-expect-error strict Pi SDK type mismatch on execute return
    async execute(_id, params, _sig, onUpdate, ctx) {
      const state = getState(ctx);
      if (!state) return { content: [{ type: "text", text: "No active pipeline." }] };
      // Phase gate — reject decisions from non-review phases
      if (state.currentPhase !== "review") return { content: [{ type: "text", text: `ERROR: ralph_review_decision can only be called during review phase (current: ${state.currentPhase}).` }] };
      handleReviewDecision(pi, ctx, params as { status: string; issues?: string[] });
      return { content: [{ type: "text", text: `Decision recorded: ${params.status}` }] };
    },
  });

  // ── Command: /ralph ────────────────────────────────────
  pi.registerCommand("ralph", {
    description: "Dev-cycle pipeline (start | status | cancel | gate | resume | pause)",
    getArgumentCompletions: (prefix: string) => { const items = ["start","status","cancel","gate","resume","pause","spec","redteam","harden","render","implement","review"].map(v => ({ value: v, label: v })); return items.filter(i => i.value.startsWith(prefix)); },
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const cmd = parts[0]?.toLowerCase();
      switch (cmd) {
        case "start": {
          if (getState(ctx)) { ctx.ui.notify("Pipeline already running. /ralph cancel first.", "error"); return; }
          const feature = parts[1];
          if (!feature) { ctx.ui.notify('Usage: /ralph start <feature> [prompt] [phases]', "error"); return; }
          // Check pipeline lock
          const lockCheck = checkPipelineLock(feature, ctx.cwd);
          if (lockCheck.locked && !lockCheck.stale) { ctx.ui.notify("Pipeline already running — /ralph cancel first.", "error"); return; }
          const validPhases = new Set(DEFAULT_PHASES);
          let phases: string[] = [...DEFAULT_PHASES];
          let promptText: string | undefined;
          if (parts[2]) {
            const mp = parts[2].split(",").map(p => p.trim());
            if (mp.every(p => validPhases.has(p))) { phases = mp; }
            else { promptText = resolvePromptInput(parts[2], ctx.cwd); if (parts[3]) { const rp = parts[3].split(",").map(p => p.trim()).filter(p => validPhases.has(p)); if (rp.length) phases = rp; } }
          }
          // Validate phase order
          const validation = validatePhaseOrder(phases);
          if (!validation.valid) { ctx.ui.notify(`Invalid phase order: ${validation.error}`, "error"); return; }
          createPipelineLock(feature, ctx.cwd);
          const state: PipelineState = { feature, workDir: ctx.cwd, phases, maxIterations: 10, startedAt: Date.now(), currentPhaseIndex: 0, currentPhase: phases[0], phaseStatus: "executing", pipelineStatus: "running", reviewIterations: 0, phaseAttempts: 0, turnWriteCount: 0, promptText };
          saveState(pi, state); refreshWidget(ctx, state);
          ctx.ui.notify(`Starting pipeline for "${feature}" (${phases.join(", ")})`, "info");
          ctx.ui.setStatus("ralph-loop", `🔄 Starting | ${feature}`);
          // Run pre-hook for first phase
          if (runPreHook(phases[0], state)) { pi.sendUserMessage(buildPhasePrompt(phases[0], state)); }
          else { ctx.ui.notify(`Pre-hook failed for phase "${phases[0]}". Check prerequisites and /ralph resume.`, "error"); saveState(pi, { ...state, pipelineStatus: "failed", phaseStatus: "pre_hook" }); removePipelineLock(feature, ctx.cwd); }
          break;
        }
        case "resume": {
          const state = getState(ctx);
          if (!state) { ctx.ui.notify("No pipeline to resume.", "error"); return; }
          if (state.pipelineStatus === "completed") { ctx.ui.notify("Pipeline already completed.", "info"); return; }
          // Remove stale lock or keep existing
          removePipelineLock(state.feature, state.workDir);
          createPipelineLock(state.feature, state.workDir);
          const phases = state.phases?.length ? state.phases : DEFAULT_PHASES;
          const resumePhase = parts[1];
          let targetIdx = state.currentPhaseIndex ?? 0;
          if (resumePhase) { const ri = phases.indexOf(resumePhase); if (ri >= 0) targetIdx = ri; }
          // Check completion markers for crash recovery
          const ralphDir = path.join(state.workDir, ".ralph");
          const markerPath = path.join(ralphDir, `.phase-${phases[targetIdx]}-done`);
          if (fs.existsSync(markerPath)) { targetIdx = Math.min(targetIdx + 1, phases.length - 1); }
          const pk = phases[targetIdx];
          ctx.ui.notify(`Resuming at Phase ${targetIdx+1} (${PHASE_META[pk]?.name ?? pk})`, "info");
          const updated: PipelineState = { ...state, currentPhaseIndex: targetIdx, currentPhase: pk, phaseStatus: "executing", pipelineStatus: "running", phaseAttempts: 0 };
          saveState(pi, updated); refreshWidget(ctx, updated);
          ctx.ui.setStatus("ralph-loop", `🔄 Resuming | ${state.feature}`);
          if (runPreHook(pk, updated)) { pi.sendUserMessage(buildPhasePrompt(pk, updated)); }
          else { ctx.ui.notify(`Pre-hook failed for "${pk}". Fix prerequisites first.`, "error"); saveState(pi, { ...updated, pipelineStatus: "failed", phaseStatus: "pre_hook" }); }
          break;
        }
        case "pause": {
          const state = getState(ctx);
          if (!state) { ctx.ui.notify("No active pipeline.", "info"); return; }
          saveState(pi, { ...state, pipelineStatus: "paused", phaseStatus: "post_hook" });
          ctx.ui.setStatus("ralph-loop", `⏸ Paused | ${state.feature}`);
          ctx.ui.notify(`Pipeline paused. Use /ralph resume to continue.`, "warning");
          break;
        }
        case "gate": {
          const state = getState(ctx) || { workDir: ctx.cwd };
          const results = runLintGates(state.workDir, parts.slice(1));
          ctx.ui.notify(results.every(r => r.pass) ? "✅ All gates passed" : `❌ Failed: ${results.filter(r => !r.pass).map(r => r.name).join(", ")}`, results.every(r => r.pass) ? "info" : "error");
          break;
        }
        case "status": {
          const state = getState(ctx);
          if (!state) { ctx.ui.notify("No active pipeline.", "info"); return; }
          const phases = state.phases?.length ? state.phases : DEFAULT_PHASES;
          const idx = state.currentPhaseIndex ?? 0;
          const pk = phases[idx];
          ctx.ui.notify([`Feature: ${state.feature}`, `Status: ${state.pipelineStatus ?? "running"}`, `phaseStatus: ${state.phaseStatus ?? "executing"}`, `Current: Phase ${idx+1} — ${PHASE_META[pk]?.name ?? pk}`, `Phases: ${phases.join(" → ")}`, `reviewIterations: ${state.reviewIterations ?? 0}`, `phaseAttempts: ${state.phaseAttempts ?? 0}`, `Context clears: ${state.contextClearCount ?? 0}`, `Auto clear: ${(state.autoClearContext ?? false) ? "ON" : "OFF"}`, `Started: ${new Date(state.startedAt).toISOString()}`].join("\n"), "info");
          break;
        }
        case "cancel": {
          const state = getState(ctx);
          if (state) removePipelineLock(state.feature, state.workDir);
          ctx.ui.setStatus("ralph-loop", ""); ctx.ui.setWidget("ralph-loop", []);
          ctx.ui.notify("Pipeline cancelled", "warning");
          break;
        }
        case "clear-context": {
          const cs = getState(ctx);
          if (!cs) { ctx.ui.notify("No active pipeline.", "error"); return; }
          // Parse flags
          const flag = parts[1];
          if (flag && flag !== "--auto") {
            ctx.ui.notify("Unknown flag. Usage: /ralph clear-context [--auto]", "error");
            return;
          }
          if (flag === "--auto") {
            const updatedAuto = { ...cs, autoClearContext: true };
            saveState(pi, updatedAuto);
          }
          // Validate clear
          const check = canClearContext(cs);
          if (!check.ok) { ctx.ui.notify("Cannot clear context: " + (check.reason ?? "unknown"), "error"); return; }
          // Build artifact list for prompt augmentation
          const artifacts = resolveArtifactPaths(cs);
          let artList = "";
          if (artifacts.length > 0) artList = "\nArtifacts on disk:\n" + artifacts.map(a => "- " + a).join("\n");
          // Trigger compaction via ctx, then send steer message in onComplete
          const piAny = pi as any;
          ctx.compact({
            customInstructions: "Preserve pipeline phase context and file operations. Focus on current task instructions.",
            onComplete: (_result) => {
              try {
                // Re-validate cooldown before committing (race guard)
                if (!canClearContext(cs).ok) { ctx.ui.notify("Context clear skipped — cooldown active", "info"); return; }
                const prompt = buildReorientationPrompt(cs);
                const fullMsg = wrapSteerMessage(prompt + artList, MAX_STEER_SIZE);
                piAny.sendMessage({ role: "user", content: [{ type: "text", text: fullMsg }] }, { triggerTurn: true, deliverAs: "steer" });
                // Increment counter only after successful send (not before)
                const updated = { ...cs, contextClearCount: (cs.contextClearCount ?? 0) + 1, lastContextClearAt: Date.now() };
                saveState(pi, updated);
                refreshWidget(ctx, updated);
                ctx.ui.notify("Context cleared — Phase " + ((cs.currentPhaseIndex ?? 0) + 1) + "/" + (cs.phases?.length ?? "?") + " resumed", "info");
              } catch (e) {
                ctx.ui.notify("Steer failed: " + String(e), "error");
              }
            },
            onError: (_err) => {
              // Fallback: send steer-only without compaction
              try {
                const prompt = buildReorientationPrompt(cs);
                piAny.sendMessage({ role: "user", content: [{ type: "text", text: wrapSteerMessage(prompt, MAX_STEER_SIZE) }] }, { triggerTurn: true, deliverAs: "steer" });
                const updated = { ...cs, contextClearCount: (cs.contextClearCount ?? 0) + 1, lastContextClearAt: Date.now() };
                saveState(pi, updated);
                ctx.ui.notify("Context cleared (compaction fallback)", "warning");
              } catch (e) {
                ctx.ui.notify("Clear failed entirely: " + String(e), "error");
              }
            },
          });
          break;
        }
        default: {
          if (cmd && !cmd.startsWith("-")) { // Shorthand: /ralph <feature>
            if (!getState(ctx)) {
              const feature = cmd;
              const state: PipelineState = { feature, workDir: ctx.cwd, phases: [...DEFAULT_PHASES], maxIterations: 10, startedAt: Date.now(), currentPhaseIndex: 0, currentPhase: "spec", phaseStatus: "executing", pipelineStatus: "running", reviewIterations: 0, phaseAttempts: 0, turnWriteCount: 0 };
              saveState(pi, state); refreshWidget(ctx, state);
              createPipelineLock(feature, ctx.cwd);
              pi.sendUserMessage(buildPhasePrompt("spec", state));
            }
          } else { ctx.ui.notify("Usage: /ralph start <feature> | status | cancel | gate | resume | pause | clear-context [--auto]", "info"); }
        }
      }
    },
  });

  // ── Resources discovery ─────────────────────────────────
  pi.on("resources_discover", async () => ({ skillPaths: [SKILL_BASE] }));

  // ── Single-skill injection per phase ────────────────────
  pi.on("before_agent_start", async (event, ctx) => {
    const state = getState(ctx);
    if (!state) return;
    const pk = state.currentPhase;
    if (!pk || !PHASE_CONFIGS[pk]) return;
    const skillPath = PHASE_CONFIGS[pk].skillPath;
    if (!fs.existsSync(skillPath)) return;
    try {
      const content = fs.readFileSync(skillPath, "utf-8");
      if (!event.systemPrompt.includes(pk + "-skill")) {
        return { systemPrompt: event.systemPrompt + `\n\n<ralph-${pk}-skill>\n${content}\n</ralph-${pk}-skill>` };
      }
    } catch {}
  });
}
