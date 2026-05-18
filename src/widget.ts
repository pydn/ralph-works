import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  GATE_PHASES,
  IMPLEMENT_CHECKPOINT_WAIT_REASON,
  UI_WIDGET_ID,
  UI_WIDGET_MAX_LINES,
  WAITING_FOR_USER_PHASE_STATUS,
} from "./config";
import type { PipelineState } from "./domain";
import { DEFAULT_PHASES, PHASE_META } from "./stateMachine";

const widgetRenderCache = new Map<string, string>();

type UiTone = "warning" | "accent" | "dim";

/** Normalize defensive phase defaults before any rendering math is performed. */
function getPhaseDisplay(st: PipelineState): {
  phases: string[];
  idx: number;
  phaseKey: string | undefined;
  phaseName: string;
} {
  const phases = st.phases?.length ? st.phases : DEFAULT_PHASES;
  const idx = st.currentPhaseIndex ?? 0;
  const phaseKey = phases[idx];
  return { phases, idx, phaseKey, phaseName: PHASE_META[phaseKey ?? ""]?.name ?? phaseKey ?? "?" };
}

function styleUiText(ctx: ExtensionContext, tone: UiTone, text: string): string {
  return ctx.ui.theme?.fg ? ctx.ui.theme.fg(tone, text) : text;
}

function formatYoloBadge(ctx: ExtensionContext): string {
  const letters: Array<{ tone: UiTone; text: string }> = [
    { tone: "accent", text: "Y" },
    { tone: "warning", text: "O" },
    { tone: "dim", text: "L" },
    { tone: "accent", text: "O" },
  ];
  return letters.map(({ tone, text }) => styleUiText(ctx, tone, text)).join("");
}

/** Strip control characters so partial terminal escape sequences never leak into widgets. */
function sanitizeUiText(value: string | undefined): string {
  return (value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, " ");
}

/** Prefer word-boundary truncation so compact widget labels remain readable. */
function truncateUiText(value: string | undefined, maxLength: number): string {
  const normalized = sanitizeUiText(value).replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  if (maxLength <= 3) return normalized.slice(0, maxLength);
  const candidate = normalized.slice(0, maxLength - 3).trimEnd();
  const boundary = candidate.lastIndexOf(" ");
  if (boundary >= Math.floor(maxLength * 0.6)) return `${candidate.slice(0, boundary)}...`;
  return `${candidate}...`;
}

/** Map persisted pipeline state to a short status label and one operator action. */
function resolveWidgetState(st: PipelineState): { label: string; tone: UiTone; actions: string[] } {
  if (st.phaseStatus === WAITING_FOR_USER_PHASE_STATUS) {
    if (st.waitingReason === IMPLEMENT_CHECKPOINT_WAIT_REASON) {
      return {
        label: "WAITING FOR IMPLEMENT REVIEW",
        tone: "warning",
        actions: ["/ralph continue approves TDD implementation"],
      };
    }
    return {
      label: "WAITING FOR USER INPUT",
      tone: "warning",
      actions: ["Reply to the prompt in chat", "/ralph continue relaunches this phase"],
    };
  }

  switch (st.pipelineStatus) {
    case "completed":
      return { label: "COMPLETE", tone: "accent", actions: ["Review the .ralph summary or start another run"] };
    case "paused":
      return { label: "PAUSED", tone: "warning", actions: ["/ralph resume continues the pipeline"] };
    case "failed":
    case "halted":
      return {
        label: "BLOCKED",
        tone: "warning",
        actions: ["Fix the blocker, then run /ralph resume", "/ralph cancel abandons this run"],
      };
    case "cancelled":
      return { label: "CANCELLED", tone: "dim", actions: ["/ralph start <feature> begins a new run"] };
    default:
      break;
  }

  if (st.phaseStatus === "pre_hook") {
    return { label: "PREPARING", tone: "accent", actions: ["Checking prerequisites for the next phase"] };
  }
  if (st.phaseStatus === "post_hook") {
    return { label: "VALIDATING", tone: "accent", actions: ["Validating phase output before transition"] };
  }
  if (st.phaseStatus === "corrupted") {
    return { label: "STATE ERROR", tone: "warning", actions: ["/ralph cancel resets the pipeline state"] };
  }

  return {
    label: "RUNNING",
    tone: "accent",
    actions: GATE_PHASES.has(st.currentPhase ?? "") ? ["Run ralph_gate_check after implementation changes"] : [],
  };
}

/** Render a compact phase-progress rail using one symbol per phase. */
function buildPhaseTrack(phases: string[], idx: number): string {
  return phases
    .map((_phase, phaseIdx) => {
      if (phaseIdx < idx) return "✓";
      if (phaseIdx === idx) return "▶";
      return "·";
    })
    .join(" ");
}

/** Build the complete, capped widget payload consumed by Pi's TUI. */
function buildWidgetLines(ctx: ExtensionContext, st: PipelineState): string[] {
  const { phases, idx, phaseName } = getPhaseDisplay(st);
  const widgetState = resolveWidgetState(st);
  const featureLabel = truncateUiText(st.feature, st.yoloMode ? 34 : 42);
  const yoloLabel = st.yoloMode ? ` · ${formatYoloBadge(ctx)}` : "";
  const detailLines = [
    st.pipelineStatus && st.pipelineStatus !== "running" ? `Status: ${st.pipelineStatus}` : "",
    st.phaseStatus && !["executing", "pre_hook", WAITING_FOR_USER_PHASE_STATUS].includes(st.phaseStatus)
      ? `Phase status: ${st.phaseStatus}`
      : "",
    st.reviewIterations && st.reviewIterations > 0 ? `Review iterations: ${st.reviewIterations}` : "",
    st.phaseAttempts && st.phaseAttempts > 0 ? `Phase attempts: ${st.phaseAttempts}` : "",
    st.contextClearCount && st.contextClearCount > 0 ? `Context clears: ${st.contextClearCount}` : "",
    st.promptText ? "Prompt: provided" : "",
  ].filter(Boolean);

  const lines = [
    styleUiText(ctx, widgetState.tone, `Ralph · ${widgetState.label} · ${featureLabel}${yoloLabel}`),
    styleUiText(
      ctx,
      "accent",
      `▶ ${idx + 1}/${phases.length} ${truncateUiText(phaseName, 34)} · [${buildPhaseTrack(phases, idx)}]`,
    ),
  ];

  const action = widgetState.actions[0];
  if (action) lines.push(styleUiText(ctx, widgetState.tone, `Action · ${truncateUiText(action, 52)}`));
  if (detailLines.length > 0) lines.push(styleUiText(ctx, "dim", truncateUiText(detailLines.join(" · "), 60)));
  return lines.slice(0, UI_WIDGET_MAX_LINES);
}

/** Include run identity so separate pipelines do not suppress each other's first render. */
function getWidgetRenderCacheKey(st: PipelineState): string {
  const startedAt = Number.isFinite(st.startedAt) ? String(st.startedAt) : "unknown";
  return [UI_WIDGET_ID, st.workDir, st.feature, startedAt].join("\0");
}

/** Skip duplicate widget payloads to avoid repeated render artifacts in the terminal. */
function setPipelineWidget(
  ctx: ExtensionContext,
  lines: string[],
  options?: { force?: boolean; cacheKey?: string },
): void {
  const signature = lines.join("\n");
  const cacheKey = options?.cacheKey ?? UI_WIDGET_ID;
  if (!options?.force && widgetRenderCache.get(cacheKey) === signature) return;
  widgetRenderCache.set(cacheKey, signature);
  ctx.ui.setWidget(UI_WIDGET_ID, lines, { placement: "belowEditor" });
}

/** Reset render de-duplication when the current pipeline is explicitly cancelled. */
export function clearPipelineWidgetCache(): void {
  widgetRenderCache.clear();
}

/** Restore normal working UI while the agent is actively processing a phase. */
export function setPipelineWorkingUi(ctx: ExtensionContext, _st: PipelineState): void {
  ctx.ui.setWorkingVisible?.(true);
  ctx.ui.setWorkingMessage?.();
  ctx.ui.setWorkingIndicator?.();
  ctx.ui.setStatus(UI_WIDGET_ID, undefined);
}

/** Show an explicit compaction status before Pi starts context reduction. */
export function setPipelineCompactingUi(ctx: ExtensionContext, _st: PipelineState): void {
  ctx.ui.setWorkingVisible?.(true);
  ctx.ui.setWorkingMessage?.();
  ctx.ui.setWorkingIndicator?.();
  ctx.ui.setStatus(UI_WIDGET_ID, "COMPACTING; this may take a minute");
}

/** Replace the spinner with a stable waiting state when the operator must reply. */
export function setPipelineWaitingUi(ctx: ExtensionContext, _st: PipelineState): void {
  ctx.ui.setWorkingVisible?.(false);
  ctx.ui.setWorkingMessage?.("Waiting for user input");
  ctx.ui.setWorkingIndicator?.({ frames: [] });
  ctx.ui.setStatus(UI_WIDGET_ID, undefined);
}

/** Public widget refresh entrypoint used by lifecycle handlers after state changes. */
export function refreshWidget(ctx: ExtensionContext, st: PipelineState, options?: { force?: boolean }): void {
  setPipelineWidget(ctx, buildWidgetLines(ctx, st), { ...options, cacheKey: getWidgetRenderCacheKey(st) });
}
