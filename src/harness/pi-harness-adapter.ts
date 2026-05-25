import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recordArtifact } from "../artifacts/artifact-tracker.ts";
import {
  type GateResult as RuntimeGateResult,
  requiredGatesPassed,
} from "../gates/gate-result.ts";
import { buildPhasePrompt } from "../prompts/phase-prompt-builder.ts";
import {
  getTddTaskCompletionMarkerTaskId,
  HARDEN_APPROVAL_STATUS,
  hasPhaseCompletionMarker,
  isLgtmReview,
  requestsReviewLoopback,
} from "../state/phase-completion.ts";
import { createPhaseState } from "../state/phase-state.ts";
import { advancePhase, transitionToPhase } from "../state/phase-transitions.ts";
import type {
  ImplementationStatus,
  SessionHandoffDescriptor,
  TransitionRecord,
  WorkflowState,
} from "../state/phase-types.ts";
import {
  completeSessionHandoff,
  createPendingSessionHandoff,
  failSessionHandoff,
  HANDOFF_PHASE_FAILED_STATUS,
  HANDOFF_PHASE_PENDING_STATUS,
  HANDOFF_STATUS_READY_IN_NEW_SESSION,
  isHandoffBlockingState,
  isHandoffFailedState,
  validatePendingSessionHandoff,
} from "../state/session-handoff-state.ts";
import {
  createImplementationStatus,
  markTaskComplete,
} from "../tasks/task-status-updater.ts";
import { splitCommandArgs } from "./pi-argument-parser.ts";
import { runPiConfiguredGates } from "./pi-gate-runner.ts";
import type {
  RalphWorksContext,
  RalphWorksPiApi,
  UserMessageOptions,
} from "./pi-harness-types.ts";
import {
  getActivePhaseModelName,
  routeModelForCurrentPhase,
} from "./pi-model-router.ts";
import { executeRalphWorksSessionHandoff } from "./pi-session-handoff.ts";
import {
  persistRalphWorksState,
  restoreRalphWorksState,
} from "./pi-state-persistence.ts";
import { createToolResult } from "./pi-tool-result.ts";
import { updateRalphWorksTui } from "./pi-tui-updater.ts";

const DEFAULT_EXTENSION_ROOT = fileURLToPath(
  new URL("../../", import.meta.url),
);
const NO_ACTIVE_PIPELINE_MESSAGE =
  "No active ralph-works pipeline. Start one with /ralph-works start <feature> [prompt].";
const HARDEN_APPROVAL_MESSAGE =
  "Approve the hardened spec with /ralph-works approve to continue to implementation planning, or /ralph-works approve --render-html to render HTML first.";
const TDD_PHASE_COMPLETION_MESSAGE =
  "TDD review transition requires RALPH_PHASE_COMPLETE from the agent and passing gates.";
const HANDOFF_PHASE_BOUNDARIES = new Set([
  "generate_spec->red_team",
  "red_team->harden_spec",
  "render_html_optional->create_tasks",
  "create_tasks->tdd_implement",
]);

const HELP_MESSAGE = [
  "Commands:",
  "/ralph-works start <feature> [prompt]",
  "/ralph-works status",
  "/ralph-works next",
  "/ralph-works next --render-html",
  "/ralph-works gates",
  "/ralph-works tdd-complete <task-id>",
  "/ralph-works artifact <key> <path>",
  "/ralph-works loopback [reason]",
  "/ralph-works approve",
  "/ralph-works approve --render-html",
  "/ralph-works reset",
  "/ralph-works help",
].join("\n");

interface TextContentPart {
  type?: unknown;
  text?: unknown;
}

interface RegisterRalphWorksExtensionOptions {
  extensionRoot?: string;
}

interface LaunchCurrentPhaseOptions {
  prefixText?: string;
  delivery?: string;
}

interface RequestSessionHandoffOptions {
  boundary?: string;
  reason?: string;
  sourcePhase?: string;
  targetPhase?: string;
  taskId?: string;
}

interface EnterPhaseOptions {
  reason?: string;
  prefixText?: string;
}

interface AgentMessage {
  role?: string;
  content?: unknown;
}

interface AgentEndEvent {
  messages?: AgentMessage[];
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter(
      (part: TextContentPart) =>
        part?.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text as string)
    .join("\n")
    .trim();
}

function latestTransition(state: WorkflowState): TransitionRecord | undefined {
  return state.transitionHistory.at(-1);
}

function shouldHandoffPhaseBoundary(nextState: WorkflowState): boolean {
  const transition = latestTransition(nextState);
  if (!transition?.from || !transition.to) {
    return false;
  }

  return HANDOFF_PHASE_BOUNDARIES.has(`${transition.from}->${transition.to}`);
}

function createSessionHandoffId(): string {
  return `handoff-${randomUUID()}`;
}

function messageForError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type SessionControlContext = RalphWorksContext & {
  newSession: NonNullable<RalphWorksContext["newSession"]>;
};

interface SessionControlRecord {
  context: SessionControlContext;
  newSession: NonNullable<RalphWorksContext["newSession"]>;
}

const SESSION_CONTROL_REGISTRY_KEY = "__ralphWorksSessionControlsBySessionFile";

// Pi tears down and rebinds extension instances during session replacement, while
// the command-capable replacement context arrives through the old withSession
// callback. Keep that context in a process-global registry so the new extension
// instance can create the next replacement session from later event callbacks.
const globalSessionControlRegistry = globalThis as typeof globalThis & {
  [SESSION_CONTROL_REGISTRY_KEY]?: Map<string, SessionControlRecord>;
};

const existingSessionControls =
  globalSessionControlRegistry[SESSION_CONTROL_REGISTRY_KEY];
const sessionControlsBySessionFile =
  existingSessionControls ?? new Map<string, SessionControlRecord>();
globalSessionControlRegistry[SESSION_CONTROL_REGISTRY_KEY] =
  sessionControlsBySessionFile;

function safeGetSessionFile(
  ctx: Partial<RalphWorksContext> | undefined,
): string | undefined {
  try {
    return ctx?.sessionManager?.getSessionFile?.();
  } catch {
    return undefined;
  }
}

function isSessionControlContext(
  ctx: Partial<RalphWorksContext> | undefined,
): ctx is SessionControlContext {
  try {
    return typeof ctx?.newSession === "function";
  } catch {
    return false;
  }
}

function createSessionControlRecord(
  ctx: SessionControlContext,
): SessionControlRecord {
  return {
    context: ctx,
    newSession: (options) => ctx.newSession(options),
  };
}

function rememberSessionControlContext(
  ctx: RalphWorksContext,
  sessionFile = safeGetSessionFile(ctx),
): SessionControlRecord | undefined {
  if (!isSessionControlContext(ctx) || !sessionFile) {
    return undefined;
  }

  const record = createSessionControlRecord(ctx);
  sessionControlsBySessionFile.set(sessionFile, record);
  return record;
}

function getRememberedSessionControlContext(
  ctx: RalphWorksContext,
): SessionControlContext | undefined {
  if (isSessionControlContext(ctx)) {
    rememberSessionControlContext(ctx);
    return ctx;
  }

  const sessionFile = safeGetSessionFile(ctx);
  if (!sessionFile) {
    return undefined;
  }

  const remembered = sessionControlsBySessionFile.get(sessionFile);
  if (!remembered || typeof remembered.newSession !== "function") {
    sessionControlsBySessionFile.delete(sessionFile);
    return undefined;
  }

  return {
    ...remembered.context,
    ...ctx,
    newSession: remembered.newSession,
  };
}

export function registerRalphWorksExtension(
  pi: RalphWorksPiApi,
  {
    extensionRoot = DEFAULT_EXTENSION_ROOT,
  }: RegisterRalphWorksExtensionOptions = {},
): void {
  let state: WorkflowState | undefined;
  let implementationStatus: ImplementationStatus = createImplementationStatus();

  function notifyNoActivePipeline(ctx: RalphWorksContext): void {
    ctx.ui?.notify?.(NO_ACTIVE_PIPELINE_MESSAGE, "info");
  }

  function notifyHardenApproval(
    ctx: RalphWorksContext,
    message = HARDEN_APPROVAL_MESSAGE,
  ): void {
    ctx.ui?.notify?.(message, "warning");
  }

  async function showStatus(
    ctx: RalphWorksContext,
  ): Promise<WorkflowState | undefined> {
    if (!state) {
      notifyNoActivePipeline(ctx);
      return undefined;
    }

    const activeModel = await getActivePhaseModelName(ctx, state);
    updateRalphWorksTui(ctx, state, activeModel);
    return state;
  }

  async function sendUserMessageForContext(
    ctx: RalphWorksContext,
    content: string,
    options?: UserMessageOptions,
  ): Promise<unknown> {
    if (typeof ctx?.sendUserMessage === "function") {
      return ctx.sendUserMessage(content, options);
    }

    return pi.sendUserMessage?.(content, options);
  }

  async function launchCurrentPhase(
    ctx: RalphWorksContext,
    { prefixText, delivery }: LaunchCurrentPhaseOptions = {},
  ): Promise<WorkflowState | undefined> {
    if (!state) {
      return undefined;
    }

    const activeModel = await routeModelForCurrentPhase(pi, ctx, state);
    state = {
      ...state,
      pipelineStatus: "running",
      phaseStatus: "executing",
    };
    persistRalphWorksState(pi, state);
    updateRalphWorksTui(ctx, state, activeModel);

    const prompt = buildPhasePrompt(state, { extensionRoot });
    const content = prefixText ? `${prefixText}\n\n${prompt}` : prompt;
    await sendUserMessageForContext(
      ctx,
      content,
      delivery ? { deliverAs: delivery } : undefined,
    );
    return state;
  }

  async function requestSessionHandoff(
    ctx: RalphWorksContext,
    nextState: WorkflowState,
    {
      boundary = "phase",
      reason,
      sourcePhase,
      targetPhase,
      taskId,
    }: RequestSessionHandoffOptions = {},
  ): Promise<WorkflowState> {
    const transition = latestTransition(nextState);
    state = createPendingSessionHandoff(nextState, {
      id: createSessionHandoffId(),
      boundary,
      reason: reason ?? `entered ${nextState.currentPhase}`,
      sourcePhase: sourcePhase ?? transition?.from ?? nextState.currentPhase,
      targetPhase: targetPhase ?? transition?.to ?? nextState.currentPhase,
      taskId,
    });
    const handoff = validatePendingSessionHandoff(state);
    persistRalphWorksState(pi, state);
    updateRalphWorksTui(ctx, state, await getActivePhaseModelName(ctx, state));
    await executePendingHandoffWithSessionControl(ctx, handoff.id);
    return state;
  }

  async function requestPhaseHandoff(
    ctx: RalphWorksContext,
    nextState: WorkflowState,
    { reason }: Pick<RequestSessionHandoffOptions, "reason"> = {},
  ): Promise<WorkflowState> {
    return requestSessionHandoff(ctx, nextState, {
      boundary: "phase",
      reason,
    });
  }

  async function enterPhase(
    ctx: RalphWorksContext,
    nextState: WorkflowState,
    { reason, prefixText }: EnterPhaseOptions = {},
  ): Promise<WorkflowState | undefined> {
    if (shouldHandoffPhaseBoundary(nextState)) {
      return requestPhaseHandoff(ctx, nextState, { reason });
    }

    state = nextState;
    if (state.currentPhase === "complete") {
      return completePipeline(ctx, reason ?? "workflow complete");
    }

    return launchCurrentPhase(ctx, {
      prefixText,
      delivery: "followUp",
    });
  }

  async function pauseForHardenApproval(
    ctx: RalphWorksContext,
  ): Promise<WorkflowState | undefined> {
    if (!state) {
      return undefined;
    }

    if (state.phaseStatus === HARDEN_APPROVAL_STATUS) {
      notifyHardenApproval(
        ctx,
        `Hardened spec is waiting for approval. ${HARDEN_APPROVAL_MESSAGE}`,
      );
      return state;
    }

    return requestSessionHandoff(ctx, state, {
      boundary: "approval",
      reason: "hardened spec awaiting approval",
      sourcePhase: "harden_spec",
      targetPhase: "harden_spec",
    });
  }

  async function advanceToNextPhase(
    ctx: RalphWorksContext,
    commandArgs: readonly string[],
    reason: string,
  ): Promise<WorkflowState | undefined> {
    if (!state) {
      return undefined;
    }

    if (blockIfHandoffActive(ctx, "phase advancement")) {
      return state;
    }

    if (state.currentPhase === "harden_spec") {
      return pauseForHardenApproval(ctx);
    }

    if (state.currentPhase === "tdd_implement") {
      ctx.ui?.notify?.(TDD_PHASE_COMPLETION_MESSAGE, "warning");
      return state;
    }

    const nextState = advancePhase(state, {
      renderHtml: commandArgs.includes("--render-html"),
      reason,
    });
    return enterPhase(ctx, nextState, {
      reason: `entered ${nextState.currentPhase}`,
    });
  }

  async function startWorkflow(
    ctx: RalphWorksContext,
    commandArgs: readonly string[],
  ): Promise<WorkflowState | undefined> {
    const [feature, ...promptParts] = commandArgs;
    if (blockIfHandoffActive(ctx, "workflow start")) {
      return state;
    }

    if (!feature) {
      ctx.ui?.notify?.("Usage: /ralph-works start <feature> [prompt]", "error");
      return undefined;
    }
    if (state?.pipelineStatus === "running") {
      ctx.ui?.notify?.(
        "A ralph-works pipeline is already running. Reset it before starting another.",
        "error",
      );
      return state;
    }

    state = createPhaseState({
      feature,
      promptText: promptParts.join(" ") || undefined,
    });
    implementationStatus = createImplementationStatus();
    return launchCurrentPhase(ctx);
  }

  async function completePipeline(
    ctx: RalphWorksContext,
    reason: string,
  ): Promise<WorkflowState | undefined> {
    if (!state) {
      return undefined;
    }

    state =
      state.currentPhase === "complete"
        ? state
        : transitionToPhase(state, "complete", { reason });
    state = {
      ...state,
      pipelineStatus: "completed",
      phaseStatus: "post_hook",
    };
    persistRalphWorksState(pi, state);
    updateRalphWorksTui(ctx, state, await getActivePhaseModelName(ctx, state));
    ctx.ui?.notify?.("ralph-works pipeline complete.", "info");
    return state;
  }

  async function advanceWorkflow(
    ctx: RalphWorksContext,
    commandArgs: readonly string[],
  ): Promise<WorkflowState | undefined> {
    if (!state) {
      notifyNoActivePipeline(ctx);
      return undefined;
    }

    return advanceToNextPhase(ctx, commandArgs, "command:next");
  }

  async function recordWorkflowArtifact(
    ctx: RalphWorksContext,
    commandArgs: readonly string[],
  ): Promise<WorkflowState | undefined> {
    if (!state) {
      notifyNoActivePipeline(ctx);
      return undefined;
    }

    if (blockIfHandoffActive(ctx, "artifact recording")) {
      return state;
    }

    const [artifactKey, artifactPath] = commandArgs;
    state = recordArtifact(state, artifactKey, artifactPath);
    persistRalphWorksState(pi, state);
    await showStatus(ctx);
    return state;
  }

  async function runGates(
    ctx: RalphWorksContext,
  ): Promise<RuntimeGateResult[]> {
    if (!state) {
      notifyNoActivePipeline(ctx);
      return [];
    }

    if (blockIfHandoffActive(ctx, "gate execution")) {
      return (state.gateResults ?? []) as unknown as RuntimeGateResult[];
    }

    const gateResults = await runPiConfiguredGates(pi, ctx);
    state = {
      ...state,
      gateResults,
    };
    persistRalphWorksState(pi, state);
    await showStatus(ctx);
    return gateResults;
  }

  function getBlockingHandoffStatus(): string {
    return isHandoffFailedState(state)
      ? HANDOFF_PHASE_FAILED_STATUS
      : HANDOFF_PHASE_PENDING_STATUS;
  }

  function formatBlockingHandoffMessage(action: string): string {
    const handoffId = state?.pendingHandoff?.id ?? "unknown";
    return `RalphWorks ${action} is blocked because session handoff ${handoffId} is ${getBlockingHandoffStatus()}.`;
  }

  function notifyWorkflowBlockedByHandoff(
    ctx: RalphWorksContext,
    action: string,
  ): void {
    const status = getBlockingHandoffStatus();
    const level = status === HANDOFF_PHASE_FAILED_STATUS ? "error" : "warning";
    ctx.ui?.notify?.(formatBlockingHandoffMessage(action), level);
  }

  function blockIfHandoffActive(
    ctx: RalphWorksContext,
    action: string,
  ): boolean {
    if (!isHandoffBlockingState(state)) {
      return false;
    }

    notifyWorkflowBlockedByHandoff(ctx, action);
    return true;
  }

  function formatTransitionToolResultText(): string {
    if (isHandoffBlockingState(state)) {
      return `ralph-works ${getBlockingHandoffStatus()}: ${state?.pendingHandoff?.id ?? "unknown"}`;
    }

    return state
      ? `ralph-works phase: ${state.currentPhase}`
      : "ralph-works pipeline not started";
  }

  function notifyTaskCompletionBlockedByHandoff(ctx: RalphWorksContext): void {
    notifyWorkflowBlockedByHandoff(ctx, "task completion");
  }

  async function completeTddPhase(
    ctx: RalphWorksContext,
  ): Promise<WorkflowState | undefined> {
    if (!state) {
      return undefined;
    }

    if (isHandoffBlockingState(state)) {
      notifyWorkflowBlockedByHandoff(ctx, "phase completion");
      return state;
    }

    const gateResults = await runGates(ctx);
    if (!requiredGatesPassed(gateResults)) {
      ctx.ui?.notify?.(
        "ralph-works gates failed; review phase will not start.",
        "error",
      );
      return state;
    }

    const nextState = advancePhase(state, {
      reason: "completed tdd_implement",
    });
    return requestSessionHandoff(ctx, nextState, {
      boundary: "phase",
      reason: "completed tdd_implement",
      sourcePhase: "tdd_implement",
      targetPhase: "review",
    });
  }

  async function completeTddTask(
    ctx: RalphWorksContext,
    taskId: unknown,
  ): Promise<WorkflowState | undefined> {
    if (!state) {
      notifyNoActivePipeline(ctx);
      return undefined;
    }

    if (isHandoffBlockingState(state)) {
      notifyTaskCompletionBlockedByHandoff(ctx);
      return state;
    }

    const normalizedTaskId = String(taskId ?? "").trim();
    if (!normalizedTaskId) {
      ctx.ui?.notify?.("Usage: /ralph-works tdd-complete <task-id>", "error");
      return state;
    }

    if (state.currentPhase !== "tdd_implement") {
      ctx.ui?.notify?.(
        "TDD task completion is only available during tdd_implement.",
        "warning",
      );
      return state;
    }

    if (implementationStatus.completedTaskIds.includes(normalizedTaskId)) {
      ctx.ui?.notify?.(
        `RalphWorks task ${normalizedTaskId} is already completed.`,
        "info",
      );
      return state;
    }

    const gateResults = await runGates(ctx);
    if (!requiredGatesPassed(gateResults)) {
      ctx.ui?.notify?.(
        "ralph-works gates failed; task remains incomplete.",
        "error",
      );
      return state;
    }

    implementationStatus = markTaskComplete(
      implementationStatus,
      normalizedTaskId,
      {
        gateResults,
      },
    );
    const completedState = {
      ...state,
      tddCompletedTasks: (state.tddCompletedTasks ?? 0) + 1,
      implementationStatus,
    };

    return requestSessionHandoff(ctx, completedState, {
      boundary: "task",
      reason: `completed ${normalizedTaskId}`,
      sourcePhase: "tdd_implement",
      targetPhase: "tdd_implement",
      taskId: normalizedTaskId,
    });
  }

  async function handlePhaseCompleteSignal(
    ctx: RalphWorksContext,
  ): Promise<WorkflowState | undefined> {
    if (!state) {
      return undefined;
    }

    if (blockIfHandoffActive(ctx, "phase completion")) {
      return state;
    }

    if (state.currentPhase === "complete") {
      return completePipeline(ctx, "LGTM");
    }

    if (state.currentPhase === "review") {
      ctx.ui?.notify?.(
        "Review approval must end with LGTM; RALPH_PHASE_COMPLETE is ignored during review.",
        "warning",
      );
      return state;
    }

    if (state.currentPhase === "harden_spec") {
      return pauseForHardenApproval(ctx);
    }

    if (state.currentPhase === "tdd_implement") {
      return completeTddPhase(ctx);
    }

    const nextState = advancePhase(state, {
      reason: `completed ${state.currentPhase}`,
    });
    return enterPhase(ctx, nextState, {
      reason: `entered ${nextState.currentPhase}`,
    });
  }

  async function requestReviewLoopback(
    ctx: RalphWorksContext,
    reason: string,
  ): Promise<WorkflowState | undefined> {
    if (!state) {
      notifyNoActivePipeline(ctx);
      return undefined;
    }

    if (blockIfHandoffActive(ctx, "review loopback")) {
      return state;
    }

    if (state.currentPhase !== "review") {
      ctx.ui?.notify?.(
        "Review loopback is only available during review.",
        "warning",
      );
      return state;
    }

    const nextState = transitionToPhase(state, "tdd_implement", { reason });
    return requestSessionHandoff(ctx, nextState, {
      boundary: "review_loopback",
      reason,
      sourcePhase: "review",
      targetPhase: "tdd_implement",
    });
  }

  async function handleReviewTurn(
    ctx: RalphWorksContext,
    assistantText: string,
  ): Promise<boolean> {
    if (!state || state.currentPhase !== "review") {
      return false;
    }

    if (blockIfHandoffActive(ctx, "review completion")) {
      return true;
    }

    if (isLgtmReview(assistantText)) {
      await completePipeline(ctx, "review LGTM");
      return true;
    }

    if (requestsReviewLoopback(assistantText)) {
      await requestReviewLoopback(ctx, "review requested changes");
      return true;
    }

    return false;
  }

  async function handleAgentEnd(
    event: AgentEndEvent,
    ctx: RalphWorksContext,
  ): Promise<void> {
    if (!state || state.pipelineStatus !== "running") {
      return;
    }

    if (blockIfHandoffActive(ctx, "automatic advancement")) {
      return;
    }

    const lastAssistantMessage = [...(event.messages ?? [])]
      .reverse()
      .find((message) => message.role === "assistant");
    const assistantText = extractMessageText(lastAssistantMessage?.content);

    if (await handleReviewTurn(ctx, assistantText)) {
      return;
    }

    const tddTaskId =
      state.currentPhase === "tdd_implement"
        ? getTddTaskCompletionMarkerTaskId(assistantText)
        : undefined;
    if (tddTaskId) {
      await completeTddTask(ctx, tddTaskId);
      return;
    }

    if (hasPhaseCompletionMarker(assistantText)) {
      await handlePhaseCompleteSignal(ctx);
    }
  }

  async function approveHardenedSpec(
    ctx: RalphWorksContext,
    commandArgs: readonly string[] = [],
  ): Promise<boolean> {
    if (
      state?.currentPhase !== "harden_spec" ||
      state.phaseStatus !== HARDEN_APPROVAL_STATUS
    ) {
      return false;
    }

    const nextState = advancePhase(state, {
      renderHtml: commandArgs.includes("--render-html"),
      reason: "hardened spec approved",
    });
    await requestSessionHandoff(ctx, nextState, {
      boundary: "approval",
      reason: `entered ${nextState.currentPhase}`,
    });
    return true;
  }

  async function executePendingHandoff(
    ctx: RalphWorksContext,
    handoffId: string,
  ): Promise<unknown> {
    rememberSessionControlContext(ctx);

    if (!state) {
      notifyNoActivePipeline(ctx);
      return undefined;
    }

    if (isHandoffFailedState(state)) {
      notifyWorkflowBlockedByHandoff(ctx, "session handoff");
      return state;
    }

    try {
      return await executeRalphWorksSessionHandoff(ctx, state, {
        handoffId,
        onStateChange: async (nextState: WorkflowState) => {
          state = nextState;
          persistRalphWorksState(pi, state);
          updateRalphWorksTui(
            ctx,
            state,
            await getActivePhaseModelName(ctx, state),
          );
        },
        withReplacementSession: async (newCtx: RalphWorksContext) => {
          rememberSessionControlContext(newCtx);
          const restoredState = restoreRalphWorksState(newCtx);
          if (
            restoredState?.pendingHandoff?.status ===
            HANDOFF_STATUS_READY_IN_NEW_SESSION
          ) {
            state = restoredState;
            implementationStatus =
              state.implementationStatus ?? createImplementationStatus();
            await resumeReadyHandoff(newCtx);
          }
        },
      });
    } catch (error) {
      ctx.ui?.notify?.(messageForError(error), "error");
      return state;
    }
  }

  async function executePendingHandoffWithSessionControl(
    ctx: RalphWorksContext,
    handoffId: string,
  ): Promise<WorkflowState | unknown> {
    if (!state) {
      notifyNoActivePipeline(ctx);
      return undefined;
    }

    const sessionControlCtx = getRememberedSessionControlContext(ctx);
    if (!sessionControlCtx) {
      state = failSessionHandoff(state, handoffId, {
        error: new Error(
          "RalphWorks session handoff requires an active Pi command context.",
        ),
      });
      persistRalphWorksState(pi, state);
      updateRalphWorksTui(
        ctx,
        state,
        await getActivePhaseModelName(ctx, state),
      );
      const failedHandoff = validatePendingSessionHandoff(state, handoffId);
      ctx.ui?.notify?.(
        failedHandoff.errorMessage ?? "RalphWorks session handoff failed.",
        "error",
      );
      return state;
    }

    return executePendingHandoff(sessionControlCtx, handoffId);
  }

  function validateResumeHandoff(handoffId: string): SessionHandoffDescriptor {
    const currentState = state;
    if (!currentState) {
      throw new Error("No RalphWorks handoff is pending.");
    }

    const descriptor = validatePendingSessionHandoff(currentState, handoffId, {
      expectedStatus: HANDOFF_STATUS_READY_IN_NEW_SESSION,
    });

    if (currentState.phaseStatus !== HANDOFF_PHASE_PENDING_STATUS) {
      throw new Error(
        `RalphWorks handoff phase status mismatch: expected ${HANDOFF_PHASE_PENDING_STATUS}, found ${currentState.phaseStatus}.`,
      );
    }

    if (descriptor.targetPhase !== currentState.currentPhase) {
      throw new Error(
        `RalphWorks handoff target phase mismatch: expected current phase ${currentState.currentPhase}, found ${descriptor.targetPhase}.`,
      );
    }

    return descriptor;
  }

  async function failResumeHandoff(
    ctx: RalphWorksContext,
    handoffId: string,
    error: unknown,
    sourceState: WorkflowState | undefined = state,
  ): Promise<WorkflowState | undefined> {
    if (!sourceState?.pendingHandoff) {
      ctx.ui?.notify?.(messageForError(error), "error");
      return state;
    }

    const failedHandoffId = sourceState.pendingHandoff.id ?? handoffId;
    state = failSessionHandoff(sourceState, failedHandoffId, {
      error,
    });
    persistRalphWorksState(pi, state);
    updateRalphWorksTui(ctx, state, await getActivePhaseModelName(ctx, state));
    const failedHandoff = validatePendingSessionHandoff(state, failedHandoffId);
    ctx.ui?.notify?.(
      failedHandoff.errorMessage ?? "RalphWorks session handoff failed.",
      "error",
    );
    return state;
  }

  function isHardenApprovalResume(
    descriptor: SessionHandoffDescriptor,
  ): boolean {
    return (
      ["approval", "phase"].includes(descriptor.boundary) &&
      descriptor.sourcePhase === "harden_spec" &&
      descriptor.targetPhase === "harden_spec"
    );
  }

  async function resumeHandoff(
    ctx: RalphWorksContext,
    handoffId: string,
  ): Promise<WorkflowState | undefined> {
    if (!state) {
      notifyNoActivePipeline(ctx);
      return undefined;
    }

    let descriptor: SessionHandoffDescriptor;
    try {
      descriptor = validateResumeHandoff(handoffId);
    } catch (error) {
      return failResumeHandoff(ctx, handoffId, error);
    }

    const readyState = state;
    const phaseStatus = isHardenApprovalResume(descriptor)
      ? HARDEN_APPROVAL_STATUS
      : "executing";
    state = completeSessionHandoff(readyState, descriptor.id, { phaseStatus });
    persistRalphWorksState(pi, state);

    if (phaseStatus === HARDEN_APPROVAL_STATUS) {
      updateRalphWorksTui(
        ctx,
        state,
        await getActivePhaseModelName(ctx, state),
      );
      notifyHardenApproval(ctx);
      return state;
    }

    try {
      const activeModel = await routeModelForCurrentPhase(pi, ctx, state);
      updateRalphWorksTui(ctx, state, activeModel);
      await sendUserMessageForContext(
        ctx,
        buildPhasePrompt(state, { extensionRoot }),
        {
          deliverAs: "followUp",
        },
      );
      return state;
    } catch (error) {
      return failResumeHandoff(ctx, descriptor.id, error, readyState);
    }
  }

  async function resumeReadyHandoff(ctx: RalphWorksContext): Promise<void> {
    if (state?.pendingHandoff?.status !== HANDOFF_STATUS_READY_IN_NEW_SESSION) {
      return;
    }

    await resumeHandoff(ctx, state.pendingHandoff.id);
  }

  async function handleCommand(
    args: string,
    ctx: RalphWorksContext,
  ): Promise<void> {
    rememberSessionControlContext(ctx);

    const [command = "status", ...commandArgs] = splitCommandArgs(args);

    if (command === "status") {
      await showStatus(ctx);
      return;
    }
    if (command === "help") {
      ctx.ui?.notify?.(HELP_MESSAGE, "info");
      return;
    }
    if (command === "reset") {
      state = undefined;
      implementationStatus = createImplementationStatus();
      ctx.ui?.setStatus?.("ralph-works", undefined);
      ctx.ui?.setWidget?.("ralph-works", []);
      return;
    }
    if (command === "handoff") {
      const handoffId = commandArgs[0];
      if (!handoffId) {
        throw new Error("Usage: /ralph-works handoff <handoff-id>");
      }
      await executePendingHandoff(ctx, handoffId);
      return;
    }
    if (command === "resume-handoff") {
      const handoffId = commandArgs[0];
      if (!handoffId) {
        throw new Error("Usage: /ralph-works resume-handoff <handoff-id>");
      }
      await resumeHandoff(ctx, handoffId);
      return;
    }

    if (blockIfHandoffActive(ctx, command)) {
      return;
    }

    if (command === "start") {
      await startWorkflow(ctx, commandArgs);
      return;
    }
    if (command === "next") {
      await advanceWorkflow(ctx, commandArgs);
      return;
    }
    if (command === "gates") {
      await runGates(ctx);
      return;
    }
    if (command === "tdd-complete") {
      const taskId = commandArgs[0];
      if (!taskId) {
        throw new Error("Usage: /ralph-works tdd-complete <task-id>");
      }
      await completeTddTask(ctx, taskId);
      return;
    }
    if (command === "artifact") {
      await recordWorkflowArtifact(ctx, commandArgs);
      return;
    }
    if (command === "approve") {
      if (!state) {
        notifyNoActivePipeline(ctx);
        return;
      }
      if (await approveHardenedSpec(ctx, commandArgs)) {
        return;
      }
      if (state.currentPhase === "review") {
        await completePipeline(ctx, "LGTM");
        return;
      }
      ctx.ui?.notify?.(
        "Nothing to approve in the current ralph-works phase.",
        "info",
      );
      return;
    }
    if (command === "loopback") {
      await requestReviewLoopback(
        ctx,
        commandArgs.join(" ") || "review-critical-bugs",
      );
      return;
    }

    throw new Error(`Unknown /ralph-works command: ${command}`);
  }

  pi.on("session_start", async (_event: unknown, ctx: RalphWorksContext) => {
    state = restoreRalphWorksState(ctx);
    implementationStatus =
      state?.implementationStatus ?? createImplementationStatus();
    if (state) {
      await showStatus(ctx);
      await resumeReadyHandoff(ctx);
    }
  });

  pi.on("agent_end", async (event: unknown, ctx: RalphWorksContext) => {
    await handleAgentEnd(event as AgentEndEvent, ctx);
  });

  pi.on("resources_discover", async () => ({
    skillPaths: [path.join(extensionRoot, "skills")],
  }));

  pi.registerCommand("ralph-works", {
    description: "Show and advance the RalphWorks workflow.",
    getArgumentCompletions(prefix: string) {
      const commands = [
        "start",
        "status",
        "next",
        "next --render-html",
        "gates",
        "tdd-complete",
        "artifact",
        "loopback",
        "approve",
        "approve --render-html",
        "reset",
        "help",
      ];
      return commands
        .filter((command) => command.startsWith(prefix))
        .map((command) => ({ value: command, label: command }));
    },
    handler: handleCommand,
  });

  pi.registerTool({
    name: "ralph_works_status",
    label: "RalphWorks Status",
    description: "Return the current ralph-works workflow state.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      await showStatus(ctx);
      return createToolResult(
        state
          ? `ralph-works phase: ${state.currentPhase}`
          : "ralph-works pipeline not started",
        state,
      );
    },
  });

  pi.registerTool({
    name: "ralph_works_transition",
    label: "RalphWorks Transition",
    description: "Advance ralph-works to the next legal workflow phase.",
    parameters: {
      type: "object",
      properties: {
        renderHtml: { type: "boolean" },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!state) {
        return createToolResult("ralph-works pipeline not started", undefined);
      }

      await advanceToNextPhase(
        ctx,
        params.renderHtml ? ["--render-html"] : [],
        "command:next",
      );
      return createToolResult(formatTransitionToolResultText(), state);
    },
  });

  pi.registerTool({
    name: "ralph_works_record_artifact",
    label: "RalphWorks Artifact",
    description: "Record a ralph-works workflow artifact path.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string" },
        path: { type: "string" },
      },
      required: ["key", "path"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!state) {
        return createToolResult("ralph-works pipeline not started", undefined);
      }

      if (blockIfHandoffActive(ctx, "artifact recording")) {
        return createToolResult(formatTransitionToolResultText(), state);
      }

      state = recordArtifact(state, params.key, params.path);
      persistRalphWorksState(pi, state);
      await showStatus(ctx);
      return createToolResult(`recorded ${params.key}: ${params.path}`, state);
    },
  });
}
