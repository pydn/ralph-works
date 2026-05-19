import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { STEER_DEDUP_TTL_MS } from "./config";
import type { PipelineDeliveryMode, PipelineState } from "./domain";
import { buildPhasePrompt } from "./prompts";
import { MAX_STEER_SIZE, wrapSteerMessage } from "./steer";
import { getState, saveState } from "./stateStore";

const DEFERRED_FOLLOW_UP_RETRY_MS = 25;
const DEFERRED_FOLLOW_UP_MAX_ATTEMPTS = 40;

/** Stable key for coalescing phase-transition nudges within a short TTL. */
function transitionSteerKey(state: PipelineState): string {
  return `phase-transition:${state.currentPhaseIndex ?? 0}:${state.currentPhase ?? "unknown"}`;
}

/** Clear queued-steer metadata once the assistant starts responding to it. */
export function withoutPendingSteer(state: PipelineState): PipelineState {
  const { pendingSteerKey: _pendingSteerKey, pendingSteerSentAt: _pendingSteerSentAt, ...rest } = state;
  return rest;
}

function shouldCoalesceSteer(state: PipelineState, steerKey: string, now = Date.now()): boolean {
  if (state.pendingSteerKey !== steerKey) return false;
  const sentAt = state.pendingSteerSentAt ?? 0;
  return sentAt > 0 && now - sentAt < STEER_DEDUP_TTL_MS;
}

/**
 * Persist the pending steer marker before sending so reloads and rapid nudges
 * cannot stack multiple equivalent transition prompts.
 */
function markPendingSteer(pi: ExtensionAPI, ctx: ExtensionContext, state: PipelineState, steerKey: string): boolean {
  const latest = getState(ctx) ?? state;
  if (latest.pipelineStatus !== "running") return false;
  if (shouldCoalesceSteer(latest, steerKey)) {
    ctx.ui.notify("Skipped duplicate pending Ralph phase steer.", "info");
    return false;
  }
  saveState(pi, { ...latest, pendingSteerKey: steerKey, pendingSteerSentAt: Date.now() });
  return true;
}

function isBusyPromptError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already processing a prompt|while streaming/i.test(message);
}

/** Some Pi versions expose an idle probe; absent support is treated as busy. */
function isContextIdle(ctx: ExtensionContext): boolean {
  const maybeCtx = ctx as ExtensionContext & { isIdle?: () => boolean };
  return typeof maybeCtx.isIdle === "function" ? maybeCtx.isIdle() : false;
}

/** Ralph-origin messages should not launch new work after the pipeline is paused/cancelled/failed. */
function canDeliverPipelineMessage(ctx: ExtensionContext): boolean {
  const latest = getState(ctx);
  return Boolean(latest && latest.pipelineStatus === "running");
}

/** Retry follow-up delivery briefly when Pi is still processing the current turn. */
function sendUserMessageWhenIdle(pi: ExtensionAPI, ctx: ExtensionContext, payload: string, attempt = 0): void {
  if (!canDeliverPipelineMessage(ctx)) return;

  if (!isContextIdle(ctx)) {
    if (attempt < DEFERRED_FOLLOW_UP_MAX_ATTEMPTS) {
      setTimeout(() => sendUserMessageWhenIdle(pi, ctx, payload, attempt + 1), DEFERRED_FOLLOW_UP_RETRY_MS);
      return;
    }
    pi.sendUserMessage(payload, { deliverAs: "followUp" });
    return;
  }

  pi.sendUserMessage(payload);
}

/**
 * Send a message through the safest available Pi delivery mode.
 *
 * Steer messages are size-capped before delivery. Follow-ups wait for idle when
 * possible, because some Pi builds reject queued regular messages while busy.
 */
export function sendPipelineUserMessage(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  text: string,
  options?: { deliverAs?: PipelineDeliveryMode; wrapSteer?: boolean },
): void {
  const normalized = text.trim();
  if (!normalized) return;
  if (!canDeliverPipelineMessage(ctx)) return;

  const deliverAs = options?.deliverAs;
  const payload =
    deliverAs === "steer" && options?.wrapSteer !== false ? wrapSteerMessage(normalized, MAX_STEER_SIZE) : normalized;

  if (!deliverAs) {
    pi.sendUserMessage(payload);
    return;
  }

  if (deliverAs === "followUp" && !isContextIdle(ctx)) {
    sendUserMessageWhenIdle(pi, ctx, payload);
    return;
  }

  if (!isContextIdle(ctx)) {
    pi.sendUserMessage(payload, { deliverAs });
    return;
  }

  try {
    pi.sendUserMessage(payload);
  } catch (error) {
    if (!isBusyPromptError(error)) throw error;
    pi.sendUserMessage(payload, { deliverAs });
  }
}

/** Send a steer/follow-up only if an equivalent pending message is not fresh. */
export function sendDedupedPipelineUserMessage(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: PipelineState,
  text: string,
  options: { deliverAs: PipelineDeliveryMode; wrapSteer?: boolean; dedupeKey?: string },
): void {
  const steerKey = options.dedupeKey ?? transitionSteerKey(state);
  if (!markPendingSteer(pi, ctx, state, steerKey)) return;
  sendPipelineUserMessage(pi, ctx, text, options);
}

/** Build and send the prompt for the state's current phase. */
export function sendPhasePrompt(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: PipelineState,
  options?: { asSteer?: boolean; asFollowUp?: boolean; prefixText?: string; dedupeKey?: string },
): void {
  const pk = state.currentPhase;
  if (!pk) return;
  const prompt = buildPhasePrompt(pk, state);
  const text = options?.prefixText ? `${options.prefixText}\n\n${prompt}` : prompt;
  if (options?.asFollowUp) {
    sendDedupedPipelineUserMessage(pi, ctx, state, text, {
      deliverAs: "followUp",
      dedupeKey: options.dedupeKey,
    });
    return;
  }
  if (options?.asSteer) {
    sendDedupedPipelineUserMessage(pi, ctx, state, text, {
      deliverAs: "steer",
      dedupeKey: options.dedupeKey,
    });
    return;
  }
  sendPipelineUserMessage(pi, ctx, text);
}
