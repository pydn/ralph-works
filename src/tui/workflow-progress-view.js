import { HARDEN_APPROVAL_STATUS } from "../state/phase-completion.js";
import { getPhaseLabel } from "../state/phase-state.js";
import { colorText } from "./calm-terminal-palette.js";
import { renderGateStatus } from "./gate-status-view.js";

const MAX_MODEL_LENGTH = 44;
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

function truncateTuiText(value, maxLength) {
  const normalized = sanitizeTuiText(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }
  if (maxLength <= 3) {
    return normalized.slice(0, maxLength);
  }

  const candidate = normalized.slice(0, maxLength - 3).trimEnd();
  const boundary = candidate.lastIndexOf(" ");
  if (boundary >= Math.floor(maxLength * 0.6)) {
    return `${candidate.slice(0, boundary)}...`;
  }
  return `${candidate}...`;
}

function currentPhaseIndex(state) {
  const index = state.phases.findIndex(
    (phase) => phase.id === state.currentPhase,
  );
  return index === -1 ? 0 : index;
}

function phaseMarker(state, phaseId) {
  if (state.currentPhase === phaseId) {
    return "active";
  }
  if (state.completedPhases.includes(phaseId)) {
    return "done";
  }
  return "pending";
}

function colorForMarker(marker, isComplete) {
  if (isComplete || marker === "done") {
    return "sage";
  }
  if (marker === "active") {
    return "seafoam";
  }
  return "slate";
}

function phaseSymbol(marker, isComplete) {
  if (isComplete || marker === "done") {
    return "✓";
  }
  if (marker === "active") {
    return "▶";
  }
  return "·";
}

function formatWordmark(color) {
  return [
    colorText("ralph", "teal", color),
    colorText("-", "amber", color),
    colorText("works", "teal", color),
  ].join("");
}

function buildPhaseTrack(state, { color }) {
  const isComplete = state.currentPhase === "complete";
  return state.phases
    .map((phase) => {
      const marker = phaseMarker(state, phase.id);
      return colorText(
        phaseSymbol(marker, isComplete),
        colorForMarker(marker, isComplete),
        color,
      );
    })
    .join(" ");
}

function resolveStatus(state) {
  if (state.currentPhase === "complete") {
    return { label: "COMPLETE", tone: "sage" };
  }
  if (state.phaseStatus === HARDEN_APPROVAL_STATUS) {
    return { label: "WAITING", tone: "amber" };
  }
  if (
    state.gateResults?.some(
      (result) => result.blocksTransition && !result.passed,
    )
  ) {
    return { label: "BLOCKED", tone: "rose" };
  }
  return { label: "RUNNING", tone: "seafoam" };
}

export function renderWorkflowProgress(
  state,
  { activeModel, color = true } = {},
) {
  const index = currentPhaseIndex(state);
  const currentLabel = getPhaseLabel(state.currentPhase);
  const status = resolveStatus(state);
  const modelText = activeModel
    ? `${colorText(" · ", "muted", color)}model ${truncateTuiText(
        activeModel,
        MAX_MODEL_LENGTH,
      )}`
    : "";
  const header = [
    formatWordmark(color),
    colorText(" · ", "muted", color),
    colorText(status.label, status.tone, color),
    modelText,
  ].join("");
  const phaseLine = [
    colorText(
      state.currentPhase === "complete" ? "✓" : "▶",
      status.tone,
      color,
    ),
    colorText(
      ` ${index + 1}/${state.phases.length} ${currentLabel}`,
      "mist",
      color,
    ),
    colorText(" · ", "muted", color),
    `[${buildPhaseTrack(state, { color })}]`,
  ].join("");

  const lines = [header, phaseLine];

  lines.push(
    [
      colorText("Loopbacks", "mist", color),
      colorText(" · ", "muted", color),
      colorText(
        String(state.loopbackCount),
        state.loopbackCount ? "amber" : "slate",
        color,
      ),
    ].join(""),
  );

  const loopback = [...state.transitionHistory]
    .reverse()
    .find((entry) => entry.kind === "loopback");
  if (loopback) {
    lines.push(
      [
        `${getPhaseLabel(loopback.from)} -> ${getPhaseLabel(loopback.to)}`,
        colorText(" · ", "muted", color),
        truncateTuiText(loopback.reason, 52),
      ].join(""),
    );
  }

  lines.push(...renderGateStatus(state.gateResults, { color }));

  return lines;
}
