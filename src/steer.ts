/**
 * Ralph Pipeline — Steer Message Helpers
 *
 * Pure functions for constructing and gating steer messages sent to the agent
 * during session reload / compaction recovery. Extracted from index.ts for
 * testability (following stateMachine.ts pattern).
 */

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
