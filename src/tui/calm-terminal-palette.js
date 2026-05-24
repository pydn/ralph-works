const RESET = "\u001b[0m";

export const CALM_DARK_TERMINAL_PALETTE = {
  teal: [47, 111, 123],
  seafoam: [143, 191, 177],
  sage: [168, 184, 160],
  slate: [135, 146, 162],
  amber: [213, 184, 117],
  rose: [201, 143, 143],
  mist: [202, 211, 216],
  muted: [135, 146, 162],
};

export function colorText(text, colorName, enabled = true) {
  if (!enabled) {
    return text;
  }

  const rgb = CALM_DARK_TERMINAL_PALETTE[colorName];
  if (!rgb) {
    return text;
  }

  return `\u001b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${text}${RESET}`;
}
