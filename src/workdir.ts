import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { PipelineState, PostHookResult } from "./domain";
import { sanitizeFeatureName } from "./stateMachine";

export interface ExpectedArtifactPath {
  label: string;
  relativePath: string;
  absolutePath: string;
}

export interface WorkDirResolution {
  ok: boolean;
  workDir?: string;
  message: string;
}

function resolvePathFrom(baseDir: string, candidate: string): string {
  return path.resolve(path.isAbsolute(candidate) ? candidate : path.join(baseDir, candidate));
}

function gitCommonDir(workDir: string): string | null {
  try {
    const output = childProcess
      .execFileSync("git", ["-C", workDir, "rev-parse", "--git-common-dir"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      })
      .trim();
    if (!output) return null;
    return path.resolve(path.isAbsolute(output) ? output : path.join(workDir, output));
  } catch {
    return null;
  }
}

function listGitWorktrees(workDir: string): string[] {
  try {
    const output = childProcess.execFileSync("git", ["-C", workDir, "worktree", "list", "--porcelain"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output
      .split(/\r?\n/)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => path.resolve(line.slice("worktree ".length).trim()))
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function getExpectedArtifactPaths(phaseKey: string, state: PipelineState): ExpectedArtifactPath[] {
  const sanitized = sanitizeFeatureName(state.feature);
  const relativePaths: Array<{ label: string; relativePath: string }> = [];

  switch (phaseKey) {
    case "spec":
      relativePaths.push({ label: "Spec", relativePath: `docs/specs/${state.feature}.md` });
      break;
    case "redteam":
      relativePaths.push({
        label: "Red team report",
        relativePath: `docs/security/redteam-findings-${state.feature}.md`,
      });
      break;
    case "harden":
      relativePaths.push({ label: "Hardened spec", relativePath: `docs/specs/${state.feature}.md` });
      relativePaths.push({
        label: "Harden changelog",
        relativePath: `docs/specs/harden-changelog-${state.feature}.md`,
      });
      break;
    case "render":
      relativePaths.push({ label: "Rendered HTML", relativePath: `docs/specs/${sanitized}-final.html` });
      break;
    default:
      break;
  }

  return relativePaths.map((item) => ({
    ...item,
    absolutePath: path.join(state.workDir, item.relativePath),
  }));
}

export function formatExpectedArtifactPaths(paths: ExpectedArtifactPath[]): string {
  if (!paths.length) return "Expected artifact paths: none for this phase.";
  return ["Expected artifact paths:", ...paths.map((item) => `- ${item.label}: ${item.absolutePath}`)].join("\n");
}

export function findExpectedArtifactsInOtherWorktrees(
  state: PipelineState,
  expectedPaths: ExpectedArtifactPath[],
): Array<{ worktree: string; paths: string[] }> {
  if (!expectedPaths.length) return [];
  const currentRoot = path.resolve(state.workDir);
  return listGitWorktrees(state.workDir)
    .filter((worktree) => path.resolve(worktree) !== currentRoot)
    .map((worktree) => ({
      worktree,
      paths: expectedPaths
        .map((item) => path.join(worktree, item.relativePath))
        .filter((candidate) => fs.existsSync(candidate)),
    }))
    .filter((match) => match.paths.length > 0);
}

export function isPrimaryGitCheckout(workDir: string): boolean {
  try {
    const gitPath = path.join(workDir, ".git");
    return fs.existsSync(gitPath) && fs.statSync(gitPath).isDirectory();
  } catch {
    return false;
  }
}

export function requiresDedicatedWorktree(workDir: string): boolean {
  const agentsPath = path.join(workDir, "AGENTS.md");
  try {
    if (!fs.existsSync(agentsPath)) return false;
    const content = fs.readFileSync(agentsPath, "utf-8");
    return /NEVER EDIT THE PRIMARY CHECKOUT|dedicated\s+git\s+worktree/i.test(content);
  } catch {
    return false;
  }
}

export function buildWorkDirPolicyWarning(state: PipelineState): string | null {
  if (!requiresDedicatedWorktree(state.workDir) || !isPrimaryGitCheckout(state.workDir)) return null;
  const phaseKey = state.currentPhase ?? state.phases?.[state.currentPhaseIndex ?? 0] ?? "unknown";
  const expected = formatExpectedArtifactPaths(getExpectedArtifactPaths(phaseKey, state));
  return [
    `Ralph workDir is the primary checkout: ${state.workDir}`,
    "This repository policy requires implementation and phase artifacts to be written from a dedicated git worktree.",
    expected,
    "Remediation: create or select the dedicated worktree, then call the registered `ralph_set_workdir` tool with that worktree root or run `/ralph set-workdir <path>` before completing the phase.",
  ].join("\n");
}

export function formatPostHookFailure(phaseKey: string, state: PipelineState, result: PostHookResult): string {
  const expectedPaths = getExpectedArtifactPaths(phaseKey, state);
  const details = result.errors?.length ? result.errors : ["Unknown validation error"];
  const lines = [
    `Phase "${phaseKey}" failed validation.`,
    `Expected workDir: ${state.workDir}`,
    formatExpectedArtifactPaths(expectedPaths),
    "",
    "Validation details:",
    ...details.map((detail) => `- ${detail}`),
  ];

  const otherWorktreeMatches = findExpectedArtifactsInOtherWorktrees(state, expectedPaths);
  if (otherWorktreeMatches.length > 0) {
    lines.push("", "Likely worktree mismatch: expected artifacts were found outside the persisted workDir.");
    for (const match of otherWorktreeMatches) {
      lines.push(`- Worktree: ${match.worktree}`);
      for (const foundPath of match.paths) lines.push(`  - Found: ${foundPath}`);
    }
  }

  lines.push(
    "",
    "Remediation: if the agent created or switched to a dedicated worktree, call the registered `ralph_set_workdir` tool with that worktree root, or run `/ralph set-workdir <path>`, then retry phase completion. Do not copy artifacts between checkouts unless the operator explicitly confirms that move.",
  );
  return lines.join("\n");
}

export function resolvePipelineWorkDir(currentWorkDir: string, candidate: string, cwd: string): WorkDirResolution {
  const resolved = resolvePathFrom(cwd, candidate);
  if (!fs.existsSync(resolved)) return { ok: false, message: `WorkDir does not exist: ${resolved}` };
  try {
    if (!fs.statSync(resolved).isDirectory()) return { ok: false, message: `WorkDir is not a directory: ${resolved}` };
  } catch {
    return { ok: false, message: `Cannot inspect workDir: ${resolved}` };
  }

  const currentCommon = gitCommonDir(currentWorkDir);
  const nextCommon = gitCommonDir(resolved);
  if (currentCommon && nextCommon && currentCommon !== nextCommon) {
    return {
      ok: false,
      message: `Refusing to switch workDir to a different git repository. Current common dir: ${currentCommon}; requested common dir: ${nextCommon}`,
    };
  }

  return { ok: true, workDir: resolved, message: `Ralph workDir updated to ${resolved}` };
}
