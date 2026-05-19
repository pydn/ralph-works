import * as child from "node:child_process";
import type { GateResult } from "./domain";
import { isValidTargetPath, resolveGateConfiguration, sanitizeErrorOutput } from "./stateMachine";

// Prevent overlapping manual and auto-gate executions inside the same extension process.
let isGating = false;

function runShell(cmd: string, cwd: string, timeoutMs?: number): { ok: boolean; output: string } {
  try {
    const output = child.execSync(cmd, {
      cwd,
      encoding: "utf-8",
      timeout: timeoutMs ?? 300_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return { ok: true, output: output.trim() };
  } catch (err: any) {
    return { ok: false, output: sanitizeErrorOutput((err.stdout ?? "") + (err.stderr ?? "") + (err.message ?? "")) };
  }
}

/**
 * Resolve and run the current project's quality gates.
 *
 * The target-path support is intentionally conservative. Only tools that
 * commonly accept file arguments get appended paths, and each path is filtered
 * before it is interpolated into the command string.
 */
export function runLintGates(wd: string, targetPaths?: string[]): GateResult[] {
  if (isGating) {
    return [{ name: "skip", pass: true, output: "Gate check already running — skipping." }];
  }
  isGating = true;

  try {
    const resolution = resolveGateConfiguration(wd);
    if (resolution.errors.length > 0) {
      return [
        {
          name: "Gate Configuration",
          pass: false,
          output: resolution.errors.join("\n"),
          source: resolution.source,
        },
      ];
    }
    if (resolution.gates.length === 0) {
      return [
        {
          name: "No configured gates",
          pass: true,
          skipped: true,
          output:
            "No .ralph/gate-config.json found. Ralph gates are opt-in; run the project's documented test commands manually.",
        },
      ];
    }

    const gates = resolution.gates;
    const results: GateResult[] = [];

    for (const gate of gates) {
      let cmd = gate.command;
      if (targetPaths && targetPaths.length > 0) {
        const firstToken = gate.command.trim().split(/\s+/)[0];
        const supportedCmds = new Set(["tsc", "eslint", "ruff", "flake8", "pylint"]);
        if (supportedCmds.has(firstToken)) {
          const safePaths = targetPaths.filter((p) => isValidTargetPath(p));
          if (safePaths.length > 0) {
            cmd += " " + safePaths.join(" ");
          }
        }
      }

      const timeout = gate.timeoutMs || 60_000;
      const rc = runShell(cmd, wd, timeout);
      results.push({
        name: gate.name,
        pass: rc.ok,
        output: sanitizeErrorOutput(rc.output || ""),
        command: cmd,
        source: gate.source,
      });
    }

    return results;
  } finally {
    isGating = false;
  }
}

/** Render gate results into a compact Markdown report for steer/tool output. */
export function formatGateResults(results: GateResult[]): string {
  const rows = results.map(
    (r) => `| ${r.name} | ${r.pass ? "✅ PASS" : "❌ FAIL"} | ${r.command ?? ""} | ${r.source ?? ""} |`,
  );
  const details = results
    .map((r) => (r.pass && !r.skipped ? "" : `\`\`\`\n${r.name} output:\n${r.output}\n\`\`\``))
    .filter(Boolean)
    .join("\n\n");
  return `## Ralph Gate Results\n\n| Gate | Status | Command | Source |\n|------|--------|---------|--------|\n${rows.join("\n")}\n\n${details}`;
}
