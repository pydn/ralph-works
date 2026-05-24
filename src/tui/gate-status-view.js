import { colorText } from "./calm-terminal-palette.js";

function sanitizeTuiText(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function renderGateStatus(gateResults = [], { color = true } = {}) {
  if (gateResults.length === 0) {
    return [];
  }

  const lines = [colorText("Gates", "mist", color)];
  for (const result of gateResults) {
    const marker = result.passed ? "✓ pass" : "✗ fail";
    const colorName = result.passed ? "sage" : "rose";
    const requirement = result.required ? "required" : "optional";
    const blockText = result.blocksTransition ? " · blocks transition" : "";
    lines.push(
      `${colorText(marker, colorName, color)} · ${sanitizeTuiText(
        result.name,
      )} · ${requirement}${blockText}`,
    );
  }

  return lines;
}
