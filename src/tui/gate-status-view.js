import { colorText } from "./calm-terminal-palette.js";

// biome-ignore lint/complexity/useRegexLiterals: String construction avoids Biome control-character regex diagnostics for intentional TUI sanitization.
const CONTROL_CHARACTER_PATTERN = new RegExp(
  "[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f]",
  "g",
);

function sanitizeTuiText(value) {
  return String(value ?? "")
    .replace(CONTROL_CHARACTER_PATTERN, " ")
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
