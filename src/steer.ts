/**
 * Ralph Pipeline — Steer Message Helpers
 *
 * Pure functions for constructing and gating steer messages sent to the agent
 * during session reload / compaction recovery. Extracted from index.ts for
 * testability (following stateMachine.ts pattern).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { sanitizeFeatureName } from "./stateMachine";

// ── Constants ───────────────────────────────────────────────

/** Maximum steer message size before truncation to summary mode. 8K characters (UTF-16 code units). */
export const MAX_STEER_SIZE = 8 * 1024;

// ── Pure Functions ──────────────────────────────────────────

/**
 * Wrap a steer message with a size budget check.
 * If `text.length <= maxSize`, return `text` unchanged.
 * If `text.length > maxSize`, extract the header (lines before "---" separator)
 * and replace the body with a re-read directive, keeping total output within budget.
 *
 * @param text  Full steer message text (header + phase prompt content)
 * @param maxSize Maximum allowed byte length before truncation
 * @returns Original text if within budget; truncated summary if exceeded
 */
export function wrapSteerMessage(text: string, maxSize: number): string {
  if (!text || text.length <= maxSize) {
    return text;
  }

  // Extract header: everything before the "---" separator (resume label + instructions)
  const separatorIndex = text.indexOf("---");
  const header = separatorIndex > 0 ? text.slice(0, separatorIndex).trim() : text.slice(0, maxSize);

  // Build summary that stays within budget
  const reReadDirective = `\n\n[Truncated: steer message exceeded ${maxSize} byte budget.\nPlease re-read your phase skill file for full instructions:\nThe task and deliverable details are in the skill referenced by this pipeline.]`;
  const summary = `${header}\n---\n${reReadDirective}`;

  // If even the summary is too long, cut header further
  if (summary.length > maxSize + 500) {
    const cutHeader = header.slice(0, maxSize - reReadDirective.length - 10);
    return `${cutHeader}\n---\n${reReadDirective}`;
  }

  return summary;
}

/**
 * Validate that a phase index is within the valid range for a phase list.
 *
 * @param idx Current phase index to validate (may be negative, undefined-coalesced, or oversized)
 * @param phases Ordered array of phase keys
 * @returns true if `0 <= idx < phases.length`, false otherwise
 */
export function validatePhaseIndex(idx: number, phases: string[]): boolean {
  return idx >= 0 && idx < phases.length;
}

// ── Clear Context Guards ───────────────────────────────────

/** Result of a clear-context validation check. */
export interface CanClearResult { ok: boolean; reason?: string; }

/**
 * Validate whether context can be safely cleared for the given pipeline state.
 * Pure function — checks required fields, pipeline status, phase status, and rate-limit cooldown.
 *
 * @param state PipelineState from getState(), or null if no active pipeline
 * @returns { ok: boolean; reason?: string } with rejection reason when ok is false
 */
export function canClearContext(state: { feature?: string; currentPhaseIndex?: number | undefined; pipelineStatus?: string; phaseStatus?: string; lastContextClearAt?: number | undefined } | null): CanClearResult {
  if (!state) return { ok: false, reason: "No active pipeline" };
  if (!state.feature) return { ok: false, reason: "State missing required field: feature" };
  if (state.currentPhaseIndex === undefined || state.currentPhaseIndex === null) return { ok: false, reason: "State missing required field: currentPhaseIndex" };
  const blocked = ["completed", "cancelled", "failed", "halted"] as const;
  if (blocked.includes(state.pipelineStatus as typeof blocked[number])) return { ok: false, reason: `Pipeline is ${state.pipelineStatus}` };
  if (state.phaseStatus === "pre_hook") return { ok: false, reason: "Cannot clear during pre_hook" };
  if (state.lastContextClearAt !== undefined) {
    const elapsed = Date.now() - state.lastContextClearAt;
    if (elapsed < 30_000) return { ok: false, reason: `Rate-limit cooldown active (${Math.ceil((30_000 - elapsed) / 1000)}s remaining)` };
  }
  return { ok: true };
}

// ── Artifact Path Resolution ───────────────────────────────

/**
 * Resolve artifact file paths for a feature from naming conventions.
 * Validates each path with fs.existsSync and returns only existing paths.
 */
export function resolveArtifactPaths(state: { feature: string; workDir: string }): string[] {
  const safeFeature = sanitizeFeatureName(state.feature);
  const sanitized = safeFeature.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  const candidates = [
    `docs/specs/${safeFeature}.md`,
    `docs/specs/${sanitized}-final.html`,
    `docs/security/redteam-findings-${safeFeature}.md`,
    `docs/specs/harden-changelog-${safeFeature}.md`,
  ];

  return candidates.filter(p => {
    try { return fs.existsSync(path.join(state.workDir, p)); } catch { return false; }
  });
}

// ── Re-orientation Prompt Builder (Tiered) ─────────────────

/**
 * Build a tiered re-orientation steer message for clear-context.
 * Tier 1 (header) always included. Tier 2 (metadata) if budget permits.
 * Tier 3 (full phase prompt) only if total < MAX_STEER_SIZE - 500; otherwise fallback directive.
 */
export function buildReorientationPrompt(state: {
  feature: string;
  currentPhase?: string;
  currentPhaseIndex?: number;
  phases?: string[];
  startedAt?: number;
}): string {
  const idx = state.currentPhaseIndex ?? 0;
  const phaseName = state.currentPhase ?? "unknown";
  const total = (state.phases?.length ?? 1);

  // Tier 1 — Always included (~500 chars)
  const header = "⛔ CONTEXT RESET — Phase " + (idx + 1) + ": " + phaseName +
    "\nYou are in a Ralph pipeline for feature \"" + state.feature + "\"."
    + "\nConversation context was refreshed. State is preserved in JSONL."
    + "\nCurrent phase: " + phaseName + " (Phase " + (idx + 1) + "/" + total + ")";

  // Tier 2 — Metadata if budget permits
  const phases = state.phases ?? [];
  const completed = idx > 0 ? phases.slice(0, idx).join(", ") : "none";
  const remaining = phases.length > idx + 1 ? phases.slice(idx + 1).join(", ") : "none";
  const metadata = `Completed phases: ${completed}\nRemaining phases: ${remaining}`;

  const budget = MAX_STEER_SIZE - header.length - 200;
  let prompt = header;

  // Tier 2 if fits
  if (metadata.length < budget) {
    prompt += `\n${metadata}`;
  }

  return wrapSteerMessage(prompt, MAX_STEER_SIZE);
}
