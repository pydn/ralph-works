import * as fs from "node:fs";
import * as path from "node:path";
import type { PipelineState } from "./domain";
import { DEFAULT_PHASES, PHASE_META } from "./stateMachine";

export function writePhaseCompletionMarker(phaseKey: string, workDir: string): void {
  const ralphDir = path.join(workDir, ".ralph");
  if (!fs.existsSync(ralphDir)) fs.mkdirSync(ralphDir, { recursive: true });
  const markerPath = path.join(ralphDir, `.phase-${phaseKey}-done`);
  const tmpPath = `${markerPath}.tmp`;
  const data = { phase: phaseKey, completedAt: Date.now(), attemptNumber: 1 };
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data), "utf-8");
    fs.renameSync(tmpPath, markerPath);
  } catch {}
  const logPath = path.join(ralphDir, "phase-attempts.json");
  try {
    const log: any[] = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, "utf-8")) : [];
    log.push({ ...data, logType: "completion" });
    fs.writeFileSync(logPath, JSON.stringify(log, null, 2), "utf-8");
  } catch {}
}

export function writeDevCycleSummary(state: PipelineState): void {
  const ralphDir = path.join(state.workDir, ".ralph");
  if (!fs.existsSync(ralphDir)) fs.mkdirSync(ralphDir, { recursive: true });
  const phases = state.phases ?? DEFAULT_PHASES;
  const phaseResults = phases
    .map(
      (p) =>
        `- ${PHASE_META[p]?.name ?? p}: ${fs.existsSync(path.join(ralphDir, `.phase-${p}-done`)) ? "✅ Completed" : "❌ Not completed"}`,
    )
    .join("\n");
  try {
    fs.writeFileSync(
      path.join(ralphDir, `dev-cycle-${state.feature}.md`),
      `# Dev-Cycle Summary: ${state.feature}\n\n**Started:** ${new Date(state.startedAt).toISOString()}\n**Completed:** ${new Date().toISOString()}\n**Review Iterations:** ${state.reviewIterations ?? 0}\n\n## Phases\n${phaseResults}`,
      "utf-8",
    );
  } catch {}
}

export function writeMetrics(state: PipelineState): void {
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
  try {
    fs.writeFileSync(path.join(ralphDir, `metrics-${state.feature}.json`), JSON.stringify(metrics, null, 2), "utf-8");
  } catch {}
}

export function checkPipelineLock(feature: string, wd: string): { locked: boolean; stale?: boolean } {
  const lp = path.join(wd, ".ralph", `pipeline-lock-${feature}`);
  if (!fs.existsSync(lp)) return { locked: false };
  try {
    const s = fs.statSync(lp);
    return { locked: true, stale: Date.now() - s.mtimeMs > 24 * 60 * 60 * 1000 };
  } catch {
    return { locked: false };
  }
}

export function createPipelineLock(feature: string, wd: string): boolean {
  const ralphDir = path.join(wd, ".ralph");
  if (!fs.existsSync(ralphDir)) fs.mkdirSync(ralphDir, { recursive: true });
  try {
    fs.writeFileSync(
      path.join(ralphDir, `pipeline-lock-${feature}`),
      JSON.stringify({ feature, createdAt: Date.now() }),
      "utf-8",
    );
    return true;
  } catch {
    return false;
  }
}

export function removePipelineLock(feature: string, wd: string): void {
  const lp = path.join(wd, ".ralph", `pipeline-lock-${feature}`);
  try {
    if (fs.existsSync(lp)) fs.unlinkSync(lp);
  } catch {}
}

export function phaseCompletionMarkerExists(state: PipelineState, phaseKey: string): boolean {
  return fs.existsSync(path.join(state.workDir, ".ralph", `.phase-${phaseKey}-done`));
}
