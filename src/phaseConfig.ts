import * as fs from "node:fs";
import * as path from "node:path";
import { SKILL_BASE } from "./config";
import type { PipelineState, PostHookResult } from "./domain";
import { runLintGates } from "./gates";
import { sanitizeFeatureName, validateHardenedSpecStatus } from "./stateMachine";

export interface PhaseConfig {
  displayName: string;
  desc: string;
  skillPath: string;
  skillPathCandidates?: string[];
  preHook: (phaseKey: string, state: PipelineState) => boolean;
  postHook: (phaseKey: string, state: PipelineState) => PostHookResult;
}

function resolveSkillPath(...candidates: string[]): string {
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0] ?? "";
}

export const PHASE_CONFIGS: Record<string, PhaseConfig> = {
  spec: {
    displayName: "Generate Spec",
    desc: "Create Markdown engineering specification",
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
    displayName: "Red Team Audit",
    desc: "Adversarial security review of the spec",
    skillPath: path.join(SKILL_BASE, "red-team-audit", "SKILL.md"),
    preHook: (pk, s) => {
      if (!fs.existsSync(PHASE_CONFIGS[pk].skillPath)) return false;
      return fs.existsSync(path.join(s.workDir, "docs", "specs", `${s.feature}.md`));
    },
    postHook: (_pk, s) => {
      const ap = path.join(s.workDir, "docs", "security", `redteam-findings-${s.feature}.md`);
      if (!fs.existsSync(ap)) return { pass: false, errors: [`Audit report not found at ${ap}`] };
      const c = fs.readFileSync(ap, "utf-8");
      if (!c.includes("[CRITICAL]") && !c.includes("[WARNING]"))
        return { pass: false, errors: ["Missing severity tags"] };
      return { pass: true };
    },
  },
  harden: {
    displayName: "Harden Spec",
    desc: "Address audit findings, update spec with mitigations",
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
      const status = validateHardenedSpecStatus(fs.readFileSync(sp, "utf-8"));
      if (!status.valid)
        return { pass: false, errors: [status.error ?? "Spec YAML front matter does not show status: hardened"] };
      return { pass: true };
    },
  },
  render: {
    displayName: "Render Markdown → HTML",
    desc: "Convert hardened markdown spec to polished HTML with Mermaid diagrams and typography",
    skillPath: path.join(SKILL_BASE, "markdown-to-html", "SKILL.md"),
    preHook: (_pk, s) => {
      if (!fs.existsSync(PHASE_CONFIGS["render"].skillPath)) return false;
      const sp = path.join(s.workDir, "docs", "specs", `${s.feature}.md`);
      if (!fs.existsSync(sp)) return false;
      if (!validateHardenedSpecStatus(fs.readFileSync(sp, "utf-8")).valid) return false;
      return true;
    },
    postHook: (_pk, s) => {
      const sanitized = sanitizeFeatureName(s.feature);
      const htmlPath = path.join(s.workDir, "docs", "specs", `${sanitized}-final.html`);
      if (!fs.existsSync(htmlPath)) return { pass: false, errors: [`Rendered HTML not found at ${htmlPath}`] };
      const stat = fs.statSync(htmlPath);
      if (stat.size < 2048)
        return { pass: false, errors: [`File size: ${(stat.size / 1024).toFixed(1)}KB, minimum: 2KB`] };
      const content = fs.readFileSync(htmlPath, "utf-8");
      if (!content.includes("<") || !content.includes(">"))
        return { pass: false, errors: ["Output does not appear to be valid HTML"] };
      if (!content.includes("</html>"))
        return { pass: false, errors: ["Missing </html> closing tag — document may be truncated"] };
      if (!content.includes("</body>"))
        return { pass: false, errors: ["Missing </body> closing tag — document may be truncated"] };
      return { pass: true };
    },
  },
  implement: {
    displayName: "TDD Implement",
    desc: "Implement via Red-Green-Refactor cycle",
    skillPath: path.join(SKILL_BASE, "tdd-implement", "SKILL.md"),
    preHook: (pk) => fs.existsSync(PHASE_CONFIGS[pk].skillPath),
    postHook: (_pk, s) => {
      const r = runLintGates(s.workDir);
      if (!r.every((x) => x.pass))
        return { pass: false, errors: r.filter((x) => !x.pass).map((x) => `${x.name}: ${x.output.slice(0, 200)}`) };
      return { pass: true };
    },
  },
  review: {
    displayName: "Ralph Review Loop",
    desc: "Multi-pass PR review → remediate until LGTM",
    skillPath: resolveSkillPath(
      path.join(SKILL_BASE, "pi-skills", "pr-reviewer", "SKILL.md"),
      path.join(SKILL_BASE, "pr-reviewer", "SKILL.md"),
    ),
    skillPathCandidates: [
      path.join(SKILL_BASE, "pi-skills", "pr-reviewer", "SKILL.md"),
      path.join(SKILL_BASE, "pr-reviewer", "SKILL.md"),
    ],
    preHook: (pk) => fs.existsSync(PHASE_CONFIGS[pk].skillPath),
    postHook: () => ({ pass: true }),
  },
};

export function runPreHook(phaseKey: string, state: PipelineState): boolean {
  const cfg = PHASE_CONFIGS[phaseKey];
  if (!cfg || (cfg.skillPath && !fs.existsSync(cfg.skillPath))) return false;
  return cfg.preHook(phaseKey, state);
}

export function runPostHook(phaseKey: string, state: PipelineState): PostHookResult {
  const cfg = PHASE_CONFIGS[phaseKey];
  if (!cfg) return { pass: false, errors: [`Unknown phase config for ${phaseKey}`] };
  return cfg.postHook(phaseKey, state);
}

export function getMissingPhaseSkillPrerequisites(
  phases: string[],
): Array<{ phaseKey: string; displayName: string; paths: string[] }> {
  const missing: Array<{ phaseKey: string; displayName: string; paths: string[] }> = [];
  for (const phaseKey of phases) {
    const cfg = PHASE_CONFIGS[phaseKey];
    if (!cfg) continue;
    const paths = cfg.skillPathCandidates?.length ? cfg.skillPathCandidates : [cfg.skillPath];
    if (!paths.some((candidate) => fs.existsSync(candidate))) {
      missing.push({ phaseKey, displayName: cfg.displayName, paths });
    }
  }
  return missing;
}

export function formatMissingPhaseSkillPrerequisites(
  missing: Array<{ phaseKey: string; displayName: string; paths: string[] }>,
): string {
  const rows = missing.map((item) => `- ${item.displayName} (${item.phaseKey}): ${item.paths.join(" or ")}`);
  return `Missing Ralph phase skill prerequisites:\n${rows.join("\n")}`;
}
