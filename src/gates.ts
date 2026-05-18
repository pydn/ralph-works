import * as child from "node:child_process";
import type { GateResult } from "./domain";
import { isValidTargetPath, resolveGates, sanitizeErrorOutput } from "./stateMachine";

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

export function runLintGates(wd: string, targetPaths?: string[]): GateResult[] {
  if (isGating) {
    return [{ name: "skip", pass: true, output: "Gate check already running — skipping." }];
  }
  isGating = true;

  try {
    const gates = resolveGates(wd);
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
      results.push({ name: gate.name, pass: rc.ok, output: sanitizeErrorOutput(rc.output || "") });
    }

    return results;
  } finally {
    isGating = false;
  }
}

export function formatGateResults(results: GateResult[]): string {
  const rows = results.map((r) => `| ${r.name} | ${r.pass ? "✅ PASS" : "❌ FAIL"} |`);
  return `## Lint Gate Results\n\n| Gate | Status |\n|------|--------|\n${rows.join("\n")}\n\n${results.map((r) => (r.pass ? "" : `\`\`\`\n${r.name} output:\n${r.output}\n\`\`\``)).join("\n\n")}`;
}
