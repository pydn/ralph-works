export const PHASE_COMPLETE_MARKER = "RALPH_PHASE_COMPLETE";
export const HARDEN_APPROVAL_STATUS = "awaiting_harden_approval";

function finalNonEmptyLine(text) {
  const lines = String(text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) ?? "";
}

export function hasPhaseCompletionMarker(text) {
  return finalNonEmptyLine(text) === PHASE_COMPLETE_MARKER;
}

export function isLgtmReview(text) {
  const value = String(text ?? "");
  if (
    /(?:^|\n)\s*(?:[-*]\s*)?(?:\[CRITICAL\]|\bCRITICAL\b\s*:)/i.test(value)
  ) {
    return false;
  }
  return /\bLGTM\b/i.test(value);
}

export function requestsReviewLoopback(text) {
  const value = String(text ?? "");
  return /(?:^|\n)\s*(?:[-*]\s*)?(?:\[CRITICAL\]|\bCRITICAL\b\s*:|RALPH_REVIEW_CHANGES_REQUESTED\b)/i.test(
    value,
  );
}
