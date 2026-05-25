const MAX_DIAGNOSTIC_TEXT_LENGTH = 300;

function boundedDiagnosticText(value) {
  const text = String(value ?? "unknown")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(
      /\b(?:api[_-]?key|secret|token|password|credential)[\w.-]*\s*[:=]\s*[^\s,;]+/gi,
      "[redacted secret]",
    )
    .replace(/RAW_GATE_OUTPUT\s*:?\s*[^\s,;]*/gi, "[redacted gate output]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (text.length <= MAX_DIAGNOSTIC_TEXT_LENGTH) {
    return text;
  }

  return `${text.slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH)}…[truncated]`;
}

export function formatSessionBoundaryDiagnostic({ boundaryId, reason } = {}) {
  return `boundary ${boundedDiagnosticText(boundaryId)} (reason: ${boundedDiagnosticText(
    reason,
  )})`;
}
