/**
 * Ralph Pipeline — State Machine Pure Functions
 *
 * Extracted from index.ts for testability. These functions have no dependency
 * on Pi SDK types and can be unit-tested in isolation with vitest.
 */

// ── Types ────────────────────────────────────────────────────

export interface PhaseValidationResult {
  valid: boolean;
  error?: string;
}

export const PHASE_ORDER = ["spec", "redteam", "harden", "render", "implement", "review"] as const;
export type PhaseKey = (typeof PHASE_ORDER)[number];

export interface PhaseMeta { name: string; desc: string }

export const PHASE_META: Record<string, PhaseMeta> = {
  spec: { name: "Generate Spec", desc: "Create Markdown engineering specification" },
  redteam: { name: "Red Team Audit", desc: "Adversarial security review of the spec" },
  harden: { name: "Harden Spec", desc: "Address audit findings, update spec with mitigations" },
  render: { name: "Render Markdown → HTML", desc: "Convert hardened markdown spec to polished HTML with Mermaid diagrams and typography" },
  implement: { name: "TDD Implement", desc: "Implement via Red-Green-Refactor cycle" },
  review: { name: "Ralph Review Loop", desc: "Multi-pass PR review → remediate until LGTM" },
};

// ── Pure Functions ───────────────────────────────────────────

/**
 * Validate that phases are in topological order.
 * Returns { valid: true } or { valid: false, error: "..." }.
 */
export function validatePhaseOrder(phases: string[]): PhaseValidationResult {
  // First check: all phases must be known
  for (const p of phases) {
    if (PHASE_ORDER.indexOf(p as PhaseKey) === -1) return { valid: false, error: `Unknown phase: "${p}"` };
  }
  // Second check: dependency constraints (before topological order)
  if (phases.includes("review") && !phases.includes("implement")) return { valid: false, error: "Cannot run review without implement" };
  if ((phases.includes("redteam") || phases.includes("harden")) && !phases.includes("spec")) return { valid: false, error: "Cannot run redteam or harden without spec" };
  if (phases.includes("render") && !phases.includes("harden")) return { valid: false, error: "Cannot run render without harden" };
  // Third check: topological order
  for (let i = 0; i < phases.length - 1; i++) {
    const ci = PHASE_ORDER.indexOf(phases[i] as PhaseKey);
    const ni = PHASE_ORDER.indexOf(phases[i + 1] as PhaseKey);
    if (ni <= ci) return { valid: false, error: `Invalid phase order: "${phases[i+1]}" cannot come after "${phases[i]}"` };
  }
  return { valid: true };
}

/**
 * Default phase list. HTML rendering stays available in PHASE_ORDER, but users
 * are opted out unless they explicitly request the render phase.
 */
export const DEFAULT_PHASES: string[] = PHASE_ORDER.filter(phase => phase !== "render");

export const PHASE_COMPLETE_MARKER = "RALPH_PHASE_COMPLETE";

export type PhaseCompletionTrigger = "agent_end" | "explicit_signal";
export type PhaseCompletionAction = "wait_for_explicit_completion" | "queue_next_phase" | "complete_pipeline";
export type SessionStartAction = "none" | "resume_execution" | "launch_pending_phase";

export interface PhaseCompletionResult {
  action: PhaseCompletionAction;
  nextPhaseIndex?: number;
  nextPhase?: string;
}

export interface SessionStartStateLike {
  pipelineStatus?: string;
  phaseStatus?: string;
}

/**
 * Resolve phase-completion behavior for the controller.
 * A normal agent turn ending is not enough to advance the phase.
 */
export function resolvePhaseCompletion(
  phases: string[],
  currentPhaseIndex: number,
  trigger: PhaseCompletionTrigger,
): PhaseCompletionResult {
  if (trigger === "agent_end") {
    return { action: "wait_for_explicit_completion" };
  }

  if (phases.length === 0 || currentPhaseIndex >= phases.length - 1) {
    return { action: "complete_pipeline" };
  }

  const nextPhaseIndex = currentPhaseIndex + 1;
  return {
    action: "queue_next_phase",
    nextPhaseIndex,
    nextPhase: phases[nextPhaseIndex],
  };
}

/**
 * Require the exact completion marker on the final non-empty line so prose
 * mentions of the marker do not advance the pipeline accidentally.
 */
export function hasPhaseCompletionMarker(text: string): boolean {
  const lines = text.split("\n").map(line => line.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  return lines[lines.length - 1] === PHASE_COMPLETE_MARKER;
}

/**
 * Validate that the spec YAML front matter has a root status: hardened field.
 */
export function validateHardenedSpecStatus(content: string): PhaseValidationResult {
  const yamlMatch = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!yamlMatch) return { valid: false, error: "Spec missing YAML front matter" };

  const statusLine = yamlMatch[1].split(/\r?\n/).find(line => /^status[ \t]*:/i.test(line));
  if (!statusLine) return { valid: false, error: "Spec YAML front matter missing status: hardened" };

  const statusValue = statusLine
    .replace(/^status[ \t]*:/i, "")
    .replace(/[ \t]+#.*$/, "")
    .trim()
    .replace(/^["'](.*)["']$/, "$1")
    .trim();

  if (statusValue.toLowerCase() !== "hardened") {
    return { valid: false, error: "Spec YAML front matter status is not hardened" };
  }

  return { valid: true };
}

/**
 * Decide what to do on session reload based on persisted pipeline state.
 */
export function resolveSessionStartAction(state: SessionStartStateLike | null): SessionStartAction {
  if (!state || state.pipelineStatus !== "running") return "none";
  if (state.phaseStatus === "executing") return "resume_execution";
  if (state.phaseStatus === "pre_hook") return "launch_pending_phase";
  return "none";
}

/**
 * Sanitize feature name for safe use as a filename within docs/specs/.
 * Strips path separators (/ \), null bytes, and directory traversal (..).
 */
export function sanitizeFeatureName(name: string): string {
  return name.replace(/[\\/\0]/g, "-").replace(/\.\.(?!=)/g, "-");
}

/**
 * Sanitize error output: mask paths, strip env vars, truncate stacks.
 */
export function sanitizeErrorOutput(rawOutput: string): string {
  let out = rawOutput;
  out = out.replace(/(\/home\/[^\s]+|\/usr\/[^\s]*|\/opt\/[^\s]*)/g, "[PATH]"); // mask absolute paths
  out = out.split("\n").filter(l => !/^\s*[A-Z][A-Z_0-9]*=\S+/.test(l)).join("\n"); // strip env vars
  const stacks = out.match(/(Error:.*?\n(?:\s+at .*\n){0,20})/g);
  if (stacks) for (const s of stacks) { const l = s.split("\n"); out = out.replace(s, [l[0], ...l.slice(1, 6)].join("\n")); }
  return out.trim();
}

// ── Gate Check Types & Constants ─────────────────────────────

/** Supported gate config schema versions */
export const SUPPORTED_GATE_VERSIONS: Set<string> = new Set(["1.0"]);

/** Allowlist of command first-tokens permitted in gate definitions */
export const GATE_COMMAND_WHITELIST = new Set([
  "tsc", "eslint", "vitest", "jest", "mocha",
  "ruff", "pytest", "flake8", "pylint", "black", "isort", "unittest",
  "npx", "uv", "cargo", "go", "dotnet", "npm", "yarn", "pnpm", "node",
]);

export interface GateConfig {
  version: string;
  name: string;
  language?: string;
  gates: GateDefinition[];
}

export interface GateDefinition {
  name: string;
  command: string;
  timeoutMs: number;
}

export interface ProjectStack {
  language: "python" | "typescript" | "javascript" | "unknown";
  testRunner: string;    // "vitest" | "jest" | "pytest" | "unittest" | "mocha" | "unknown"
  lintTool: string;      // "ruff" | "eslint" | "flake8" | "pylint" | "unknown"
  formatTool: string;    // "ruff" | "prettier" | "black" | "isort" | "unknown"
}

// ── Gate Detection Functions ─────────────────────────────────

/** Minimal filesystem interface for dependency injection (testability) */
export interface FsLike {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: string): string;
}

// Lazy init — resolves require("fs") at call time to avoid ESM issues
let _defaultFs: FsLike | null = null;
function getDefaultFs(): FsLike {
  if (!_defaultFs) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    _defaultFs = require("fs") as FsLike;
  }
  return _defaultFs;
}

/**
 * Detect project language and toolchain from filesystem markers.
 * Uses non-invasive fs.existsSync() only — never invokes external processes.
 *
 * Priority: (1) tsconfig.json + package.json → TypeScript
 *           (2) pyproject.toml → Python
 *           (3) requirements.txt → Python
 *           (4) package.json alone → JavaScript
 *
 * Conflicting markers across languages → "unknown"
 */
export function detectProjectStack(workDir: string, _fs?: FsLike): ProjectStack {
  const fs = _fs ?? getDefaultFs();
  const join = (base: string, name: string) => {
    // Simple path join — avoids importing node:path in test context
    if (base.endsWith("/")) return base + name;
    return base + "/" + name;
  };
  const exists = (filename: string) => fs.existsSync(join(workDir, filename));

  const hasTsconfig = exists("tsconfig.json");
  const hasPackageJson = exists("package.json");
  const hasPyproject = exists("pyproject.toml");
  const hasRequirementsTxt = exists("requirements.txt");

  // Polyglot: conflicting language markers → unknown
  const jsMarkers = hasTsconfig || hasPackageJson;
  const pyMarkers = hasPyproject || hasRequirementsTxt;
  if (jsMarkers && pyMarkers) {
    return { language: "unknown", testRunner: "unknown", lintTool: "unknown", formatTool: "unknown" };
  }

  if (hasTsconfig && hasPackageJson) {
    return { language: "typescript", testRunner: "vitest", lintTool: "eslint", formatTool: "prettier" };
  }
  if (hasPackageJson) {
    return { language: "javascript", testRunner: "jest", lintTool: "eslint", formatTool: "prettier" };
  }
  if (hasPyproject || hasRequirementsTxt) {
    return { language: "python", testRunner: "pytest", lintTool: "ruff", formatTool: "ruff" };
  }

  return { language: "unknown", testRunner: "unknown", lintTool: "unknown", formatTool: "unknown" };
}

/**
 * Load gate config from .ralph/gate-config.json (if present).
 * Returns parsed GateConfig or null on any error.
 *
 * Validates: version in SUPPORTED_GATE_VERSIONS, gates array non-empty,
 * each gate has name + command fields.
 */
export function loadGateConfig(workDir: string, _fs?: FsLike): GateConfig | null {
  const fs = _fs ?? getDefaultFs();
  const configPath = workDir.endsWith("/") ? `${workDir}.ralph/gate-config.json` : `${workDir}/.ralph/gate-config.json`;

  if (!fs.existsSync(configPath)) return null;

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);

    // Version validation
    if (!SUPPORTED_GATE_VERSIONS.has(parsed.version)) return null;

    // Required fields
    if (!parsed.name || typeof parsed.name !== "string") return null;
    if (!Array.isArray(parsed.gates) || parsed.gates.length === 0) return null;

    // Validate each gate has name + command
    for (const gate of parsed.gates) {
      if (!gate.name || !gate.command) return null;
    }

    return parsed as GateConfig;
  } catch {
    return null;
  }
}

/**
 * Build gate definition list from config override or auto-detection.
 *
 * Resolution: (1) valid config → use config gates
 *             (2) no config / invalid → auto-detect stack → default gates
 *
 * Validates each command's first token against GATE_COMMAND_WHITELIST.
 */
export function resolveGates(workDir: string, stack?: ProjectStack | FsLike, _fs?: FsLike): GateDefinition[] {
  const fs = _fs ?? getDefaultFs();
  const projectStack = typeof stack === "object" && stack !== null && "language" in stack
    ? (stack as ProjectStack)
    : undefined;

  const config = loadGateConfig(workDir, fs);

  if (config) {
    // Validate commands: whitelist + shell metacharacter check
    for (const gate of config.gates) {
      const firstToken = gate.command.trim().split(/\s+/)[0];
      const basename = firstToken.split(/[\\/]/).pop() ?? firstToken;
      if (!GATE_COMMAND_WHITELIST.has(basename)) {
        return buildDefaultGates(projectStack ?? detectProjectStack(workDir, fs));
      }
      // Block shell metacharacter injection (; | & ` $ () etc.)
      if (!isValidGateCommand(gate.command)) {
        return buildDefaultGates(projectStack ?? detectProjectStack(workDir, fs));
      }
    }
    // All commands valid — return from config
    return config.gates.map((g) => ({
      name: g.name,
      command: g.command,
      timeoutMs: g.timeoutMs ?? getDefaultTimeout(g.name),
    }));
  }

  // No valid config — auto-detect and build defaults
  const detected = projectStack ?? detectProjectStack(workDir, fs);
  return buildDefaultGates(detected);
}

/** Build default gate list for a detected project stack */
function buildDefaultGates(stack: ProjectStack): GateDefinition[] {
  switch (stack.language) {
    case "typescript":
      return [
        { name: "Type Check", command: "npx tsc --noEmit", timeoutMs: 60000 },
        { name: "Lint", command: "npx eslint . --ext .ts,.tsx", timeoutMs: 60000 },
        { name: "Test", command: "npx vitest run", timeoutMs: 300000 },
      ];
    case "javascript":
      return [
        { name: "Lint", command: "npx eslint . --ext .js,.jsx", timeoutMs: 60000 },
        { name: "Test", command: "npx jest", timeoutMs: 300000 },
      ];
    case "python":
      return [
        { name: "Lint", command: "ruff check .", timeoutMs: 60000 },
        { name: "Format", command: "ruff format --check .", timeoutMs: 30000 },
        { name: "Test", command: "pytest tests/", timeoutMs: 300000 },
      ];
    default:
      return [
        {
          name: "Skip: no project markers detected",
          command: `node -e "process.stdout.write('No gate configuration or supported project markers detected in this directory; skipping gates.\\n')"`,
          timeoutMs: 10000,
        },
      ];
  }
}

/** Get default timeout based on gate type name */
function getDefaultTimeout(name: string): number {
  const n = name.toLowerCase();
  if (n.includes("test")) return 300000;
  if (n.includes("format")) return 30000;
  return 60000;
}

/**
 * Validate that a command string contains no shell metacharacters.
 * Blocks: ; | & ` $ () { } < > ! # ~ \n
 * Returns true if the command is safe for execSync, false otherwise.
 *
 * NOTE: This is intentionally restrictive. Gate commands should be simple
 * tool invocations (tsc, eslint, ruff, pytest). Complex shell logic belongs
 * in scripts/, not inline configs.
 */
export function isValidGateCommand(cmd: string): boolean {
  // Shell metacharacters that allow command chaining or injection
  const dangerousChars = /[;|&`$(){}<>!#~\\]/;
  if (dangerousChars.test(cmd)) return false;

  // Block newline injection (multi-line commands)
  if (/\n/.test(cmd)) return false;

  return true;
}

/**
 * Validate that a path string contains no shell metacharacters.
 * Used for targetPaths injected into gate commands.
 */
export function isValidTargetPath(p: string): boolean {
  // Block any shell metacharacters in paths
  const dangerousChars = /[;|&`$(){}<>!#~\\\n]/;
  return !dangerousChars.test(p);
}
