import { HARDEN_APPROVAL_STATUS } from "../state/phase-completion.ts";
import { getPhaseLabel } from "../state/phase-state.ts";
import {
  HANDOFF_PHASE_FAILED_STATUS,
  HANDOFF_PHASE_PENDING_STATUS,
  HANDOFF_STATUS_FAILED,
  HANDOFF_STATUS_IN_PROGRESS,
  HANDOFF_STATUS_PENDING,
  HANDOFF_STATUS_READY_IN_NEW_SESSION,
} from "../state/session-handoff-state.ts";
import {
  type CalmTerminalColorName,
  colorText,
} from "./calm-terminal-palette.ts";
import {
  type GateStatusViewResult,
  renderGateStatus,
} from "./gate-status-view.ts";

const MAX_MODEL_LENGTH = 44;
const MAX_HANDOFF_ID_LENGTH = 48;
const MAX_HANDOFF_ERROR_LENGTH = 96;
const ACTIVE_HANDOFF_STATUSES = new Set<string>([
  HANDOFF_STATUS_PENDING,
  HANDOFF_STATUS_IN_PROGRESS,
  HANDOFF_STATUS_READY_IN_NEW_SESSION,
]);
// biome-ignore lint/complexity/useRegexLiterals: String construction avoids Biome control-character regex diagnostics for intentional TUI sanitization.
const CONTROL_CHARACTER_PATTERN = new RegExp(
  "[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f]",
  "g",
);

type PhaseMarker = "active" | "done" | "pending";
type HandoffPhaseStatus =
  | typeof HANDOFF_PHASE_FAILED_STATUS
  | typeof HANDOFF_PHASE_PENDING_STATUS;

interface ColorOption {
  color: boolean;
}

interface FormatHandoffOptions {
  maxLength?: number;
}

interface ResolvedStatus {
  label: string;
  tone: CalmTerminalColorName;
}

interface WorkflowProgressPhase {
  id: string;
}

interface WorkflowProgressTransition {
  from?: string;
  to: string;
  reason?: unknown;
  kind?: string;
}

interface WorkflowProgressHandoff {
  id?: unknown;
  status?: string;
  boundary?: unknown;
  sourcePhase?: string;
  targetPhase?: string;
  error?: unknown;
  errorMessage?: unknown;
}

export interface WorkflowProgressState {
  currentPhase: string;
  phaseStatus?: string;
  phases: readonly WorkflowProgressPhase[];
  completedPhases: readonly string[];
  transitionHistory: readonly WorkflowProgressTransition[];
  loopbackCount: number;
  gateResults?: readonly GateStatusViewResult[];
  pendingHandoff?: WorkflowProgressHandoff;
}

export interface RenderWorkflowProgressOptions {
  activeModel?: unknown;
  color?: boolean;
}

function sanitizeTuiText(value: unknown): string {
  return String(value ?? "")
    .replace(CONTROL_CHARACTER_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateTuiText(value: unknown, maxLength: number): string {
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

function currentPhaseIndex(state: WorkflowProgressState): number {
  const index = state.phases.findIndex(
    (phase) => phase.id === state.currentPhase,
  );
  return index === -1 ? 0 : index;
}

function phaseMarker(
  state: WorkflowProgressState,
  phaseId: string,
): PhaseMarker {
  if (state.currentPhase === phaseId) {
    return "active";
  }
  if (state.completedPhases.includes(phaseId)) {
    return "done";
  }
  return "pending";
}

function colorForMarker(
  marker: PhaseMarker,
  isComplete: boolean,
): CalmTerminalColorName {
  if (isComplete || marker === "done") {
    return "sage";
  }
  if (marker === "active") {
    return "seafoam";
  }
  return "slate";
}

function phaseSymbol(marker: PhaseMarker, isComplete: boolean): string {
  if (isComplete || marker === "done") {
    return "✓";
  }
  if (marker === "active") {
    return "▶";
  }
  return "·";
}

function formatWordmark(color: boolean): string {
  return [
    colorText("ralph", "teal", color),
    colorText("-", "amber", color),
    colorText("works", "teal", color),
  ].join("");
}

function buildPhaseTrack(
  state: WorkflowProgressState,
  { color }: ColorOption,
): string {
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

function isHandoffPendingProgressState(state: WorkflowProgressState): boolean {
  return (
    state.phaseStatus === HANDOFF_PHASE_PENDING_STATUS ||
    ACTIVE_HANDOFF_STATUSES.has(state.pendingHandoff?.status ?? "")
  );
}

function isHandoffFailedProgressState(state: WorkflowProgressState): boolean {
  return (
    state.phaseStatus === HANDOFF_PHASE_FAILED_STATUS ||
    state.pendingHandoff?.status === HANDOFF_STATUS_FAILED
  );
}

function resolveStatus(state: WorkflowProgressState): ResolvedStatus {
  if (state.currentPhase === "complete") {
    return { label: "COMPLETE", tone: "sage" };
  }
  if (isHandoffFailedProgressState(state)) {
    return { label: "HANDOFF FAILED", tone: "rose" };
  }
  if (isHandoffPendingProgressState(state)) {
    return { label: "HANDOFF PENDING", tone: "amber" };
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

function handoffPhaseStatus(
  state: WorkflowProgressState,
): HandoffPhaseStatus | undefined {
  if (isHandoffFailedProgressState(state)) {
    return HANDOFF_PHASE_FAILED_STATUS;
  }
  if (isHandoffPendingProgressState(state)) {
    return HANDOFF_PHASE_PENDING_STATUS;
  }
  return undefined;
}

function handoffTone(status: HandoffPhaseStatus): CalmTerminalColorName {
  return status === HANDOFF_PHASE_FAILED_STATUS ? "rose" : "amber";
}

function formatHandoffValue(
  value: unknown,
  { maxLength = 40 }: FormatHandoffOptions = {},
): string {
  const normalized = truncateTuiText(value, maxLength);
  return normalized.length === 0 ? "unknown" : normalized;
}

function renderHandoffDetails(
  state: WorkflowProgressState,
  { color }: ColorOption,
): string[] {
  const status = handoffPhaseStatus(state);
  if (!status) {
    return [];
  }

  const handoff = state.pendingHandoff ?? {};
  const targetPhase = handoff.targetPhase
    ? getPhaseLabel(handoff.targetPhase)
    : "unknown";
  const lines = [
    [
      colorText("Handoff", "mist", color),
      colorText(" · ", "muted", color),
      colorText(status, handoffTone(status), color),
      colorText(" · ", "muted", color),
      `id ${formatHandoffValue(handoff.id, {
        maxLength: MAX_HANDOFF_ID_LENGTH,
      })}`,
      colorText(" · ", "muted", color),
      `boundary ${formatHandoffValue(handoff.boundary)}`,
      colorText(" · ", "muted", color),
      `target ${formatHandoffValue(targetPhase)}`,
    ].join(""),
  ];

  const error = handoff.errorMessage ?? handoff.error;
  if (error) {
    lines.push(
      [
        colorText("Handoff error", "rose", color),
        colorText(" · ", "muted", color),
        truncateTuiText(error, MAX_HANDOFF_ERROR_LENGTH),
      ].join(""),
    );
  }

  return lines;
}

function renderHardenApprovalDetails(
  state: WorkflowProgressState,
  { color }: ColorOption,
): string[] {
  if (state.phaseStatus !== HARDEN_APPROVAL_STATUS) {
    return [];
  }

  return [
    [
      colorText("Approval", "mist", color),
      colorText(" · ", "muted", color),
      colorText("/ralph-works approve", "amber", color),
      colorText(" or ", "muted", color),
      colorText("/ralph-works approve --render-html", "amber", color),
    ].join(""),
  ];
}

export function renderWorkflowProgress(
  state: WorkflowProgressState,
  { activeModel, color = true }: RenderWorkflowProgressOptions = {},
): string[] {
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

  lines.push(...renderHardenApprovalDetails(state, { color }));
  lines.push(...renderHandoffDetails(state, { color }));
  lines.push(...renderGateStatus(state.gateResults, { color }));

  return lines;
}
