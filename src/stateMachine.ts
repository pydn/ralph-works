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
 * Default phase list — single source of truth for all hardcoded default arrays.
 * Exported from stateMachine so index.ts can import instead of hardcoding.
 */
export const DEFAULT_PHASES: string[] = [...PHASE_ORDER];

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
