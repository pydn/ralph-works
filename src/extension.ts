/**
 * Ralph Loop Extension — Phase-state-machine pipeline inside pi.
 *
 * Deterministic state machine with pre-hook → execution → post-hook lifecycle.
 * Single-skill injection, structured review decisions, crash recovery.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import {
  checkPipelineLock,
  createPipelineLock,
  phaseCompletionMarkerExists,
  removePipelineLock,
  writeDevCycleSummary,
  writeMetrics,
  writePhaseCompletionMarker,
} from "./artifacts";
import {
  GATE_PHASES,
  GATE_THRESHOLD,
  IMPLEMENT_CHECKPOINT_WAIT_REASON,
  MAX_PHASE_ATTEMPTS,
  RENDER_HTML_FLAG,
  RENDER_PHASE,
  SKILL_BASE,
  UI_WIDGET_ID,
  WAITING_FOR_USER_PHASE_STATUS,
  YOLO_FLAG,
} from "./config";
import type { PipelineState } from "./domain";
import { formatGateResults, runLintGates } from "./gates";
import {
  sendDedupedPipelineUserMessage,
  sendPhasePrompt,
  sendPipelineUserMessage,
  withoutPendingSteer,
} from "./messaging";
import {
  PHASE_CONFIGS,
  formatMissingPhaseSkillPrerequisites,
  getMissingPhaseSkillPrerequisites,
  runPostHook,
  runPreHook,
} from "./phaseConfig";
import {
  addRenderPhase,
  buildPhasePrompt,
  canAddRenderBeforeCurrentPhase,
  parseCommandArgs,
  parseRalphFlags,
  resolveCurrentPhaseIndex,
  resolvePromptInput,
} from "./prompts";
import { getState, saveState } from "./stateStore";
import {
  validatePhaseOrder,
  PHASE_META,
  PHASE_ORDER,
  DEFAULT_PHASES,
  resolvePhaseCompletion,
  resolveSessionStartAction,
  hasPhaseCompletionMarker,
} from "./stateMachine";
import {
  wrapSteerMessage,
  MAX_STEER_SIZE,
  validatePhaseIndex,
  canClearContext,
  buildReorientationPrompt,
  resolveArtifactPaths,
} from "./steer";
import {
  clearPipelineWidgetCache,
  refreshWidget,
  setPipelineCompactingUi,
  setPipelineWaitingUi,
  setPipelineWorkingUi,
} from "./widget";

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const textParts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const block = part as { type?: string; text?: string };
    if (block.type === "text" && typeof block.text === "string") textParts.push(block.text);
  }
  return textParts.join("\n").trim();
}

function enterWaitingForUser(pi: ExtensionAPI, ctx: ExtensionContext, st: PipelineState): void {
  if (st.pipelineStatus !== "running") return;
  if (st.phaseStatus !== "executing" && st.phaseStatus !== WAITING_FOR_USER_PHASE_STATUS) return;
  const waitingState: PipelineState = { ...st, phaseStatus: WAITING_FOR_USER_PHASE_STATUS, turnWriteCount: 0 };
  saveState(pi, waitingState);
  setPipelineWaitingUi(ctx, waitingState);
  refreshWidget(ctx, waitingState);
}

function shouldPauseBeforeImplementCheckpoint(
  state: PipelineState,
  phases: string[],
  currentIdx: number,
  nextIdx: number,
  nextPhase: string,
): boolean {
  if (nextPhase !== "implement") return false;
  if (state.yoloMode || state.implementCheckpointApproved) return false;
  if (nextIdx <= 0) return false;
  if (phases[currentIdx] === "review") return false;
  return true;
}

function enterImplementCheckpoint(pi: ExtensionAPI, ctx: ExtensionContext, st: PipelineState): void {
  const checkpointState: PipelineState = {
    ...st,
    phaseStatus: WAITING_FOR_USER_PHASE_STATUS,
    waitingReason: IMPLEMENT_CHECKPOINT_WAIT_REASON,
    turnWriteCount: 0,
    readyToAdvancePhase: undefined,
  };
  saveState(pi, checkpointState);
  setPipelineWaitingUi(ctx, checkpointState);
  refreshWidget(ctx, checkpointState);
  ctx.ui.notify(
    "Review the completed planning phases before TDD implementation. Run /ralph continue to approve, or start with --yolo to run straight through.",
    "warning",
  );
}

function launchPhase(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: PipelineState,
  options?: { asSteer?: boolean; asFollowUp?: boolean; prefixText?: string },
): void {
  const pk = state.currentPhase;
  if (!pk) return;
  if (!runPreHook(pk, state)) {
    ctx.ui.notify(`Pre-hook failed for phase "${pk}". Fix prerequisites and /ralph resume.`, "error");
    const failedState: PipelineState = { ...state, pipelineStatus: "failed", phaseStatus: "pre_hook" };
    saveState(pi, failedState);
    refreshWidget(ctx, failedState);
    return;
  }

  const executingState: PipelineState = {
    ...state,
    phaseStatus: "executing",
    phaseAttempts: 0,
    turnWriteCount: 0,
    waitingReason: undefined,
    readyToAdvancePhase: undefined,
  };
  saveState(pi, executingState);
  setPipelineWorkingUi(ctx, executingState);
  refreshWidget(ctx, executingState);
  sendPhasePrompt(pi, ctx, executingState, options);
}

function advancePhase(pi: ExtensionAPI, ctx: ExtensionContext, state: PipelineState) {
  const phases = state.phases?.length ? state.phases : DEFAULT_PHASES;
  const idx = state.currentPhaseIndex ?? 0;
  const completion = resolvePhaseCompletion(phases, idx, "explicit_signal");
  if (completion.action === "complete_pipeline") {
    const u = { ...state, pipelineStatus: "completed", phaseStatus: "post_hook" };
    saveState(pi, u);
    refreshWidget(ctx, u);
    ctx.ui.notify(`✅ Ralph loop complete for "${state.feature}"`, "info");
    ctx.ui.setStatus(UI_WIDGET_ID, `✅ Done | ${state.feature}`);
    writeDevCycleSummary(state);
    writeMetrics(state);
    return;
  }

  const nextIdx = completion.nextPhaseIndex ?? Math.min(idx + 1, phases.length - 1);
  const nextPhase = completion.nextPhase ?? phases[nextIdx];
  const meta = PHASE_META[nextPhase];
  const u: PipelineState = {
    ...state,
    currentPhaseIndex: nextIdx,
    currentPhase: nextPhase,
    phaseStatus: "pre_hook",
    phaseAttempts: 0,
    turnWriteCount: 0,
    waitingReason: undefined,
    readyToAdvancePhase: undefined,
  };

  if (shouldPauseBeforeImplementCheckpoint(state, phases, idx, nextIdx, nextPhase)) {
    enterImplementCheckpoint(pi, ctx, u);
    return;
  }

  saveState(pi, u);
  refreshWidget(ctx, u);

  // Auto-clear at phase boundary (except implement→review transition)
  // Check BEFORE pre_hook blocks it: pass "executing" so cooldown/status gates still apply
  const prevPhase = phases[idx];
  if (state.autoClearContext && !(prevPhase === "implement" && nextPhase === "review")) {
    const autoCheckState = { ...u, phaseStatus: "executing" } as PipelineState;
    const autoCheck = canClearContext(autoCheckState);
    if (autoCheck.ok) {
      setPipelineCompactingUi(ctx, u);
      ctx.compact({
        customInstructions: "Preserve pipeline phase context. Focus on transitioning to the new phase.",
        onComplete: () => {
          try {
            // Re-validate cooldown before committing (race guard)
            if (!canClearContext(autoCheckState).ok) {
              setPipelineWorkingUi(ctx, u);
              refreshWidget(ctx, u);
              return; // skip — manual clear raced ahead
            }
            const updated = { ...u, contextClearCount: (u.contextClearCount ?? 0) + 1, lastContextClearAt: Date.now() };
            launchPhase(pi, ctx, updated, {
              asFollowUp: true,
              prefixText: `⛔ CONTEXT RESET — Continue with Phase ${nextIdx + 1}: ${meta?.name ?? nextPhase}.`,
            });
          } catch {
            // Silent failure — auto-clear is best-effort
          }
        },
        onError: () => {
          launchPhase(pi, ctx, u, { asFollowUp: true });
        },
      });
      return;
    }
  }

  launchPhase(pi, ctx, u, { asFollowUp: true });
}

function handleReviewDecision(pi: ExtensionAPI, ctx: ExtensionContext, params: { status: string; issues?: string[] }) {
  const state = getState(ctx);
  if (!state) return;
  // Phase gate — reject decisions from non-review phases
  if (state.currentPhase !== "review") {
    ctx.ui.notify(
      `ERROR: ralph_review_decision can only be called during review phase (current: ${state.currentPhase}).`,
      "error",
    );
    return;
  }
  const status = params.status as "LGTM" | "CRITICAL";
  const iter = state.reviewIterations ?? 0;
  if (status === "LGTM") {
    const u = { ...state, pipelineStatus: "completed", phaseStatus: "post_hook" };
    saveState(pi, u);
    refreshWidget(ctx, u);
    ctx.ui.notify(`✅ Ralph loop complete for "${state.feature}"`, "info");
    ctx.ui.setStatus(UI_WIDGET_ID, `✅ Done | ${state.feature}`);
    writeDevCycleSummary(state);
    writeMetrics(state);
  } else if (status === "CRITICAL") {
    const maxIters = state.maxIterations ?? 10;
    if (iter >= maxIters) {
      ctx.ui.notify(`Max review iterations (${maxIters}) reached — halted.`, "error");
      saveState(pi, { ...state, pipelineStatus: "halted" });
      return;
    }
    const phases = state.phases ?? DEFAULT_PHASES;
    const implIdx = phases.indexOf("implement");
    const u: PipelineState = {
      ...state,
      currentPhaseIndex: implIdx >= 0 ? implIdx : 3,
      currentPhase: "implement",
      phaseStatus: "pre_hook",
      reviewIterations: iter + 1,
      phaseAttempts: 0,
      turnWriteCount: 0,
      waitingReason: undefined,
      implementCheckpointApproved: true,
      readyToAdvancePhase: undefined,
    };
    saveState(pi, u);
    refreshWidget(ctx, u);
    ctx.ui.notify(`⚠️ Review CRITICAL (iteration ${iter + 1}/${maxIters}) — backtracking to implement`, "warning");
    const steerText = params.issues?.length
      ? `\n\nCRITICAL issues:\n${params.issues.map((i) => `- ${i}`).join("\n")}`
      : "";
    launchPhase(pi, ctx, u, {
      asSteer: true,
      prefixText: `⛔ REVIEW CRITICAL — Backtrack to implement.${steerText}`,
    });
  }
}

function handlePhaseCompletion(pi: ExtensionAPI, ctx: ExtensionContext): { ok: boolean; message: string } {
  const state = getState(ctx);
  if (!state) return { ok: false, message: "No active pipeline." };
  if (state.pipelineStatus !== "running")
    return { ok: false, message: `Pipeline is not running (status: ${state.pipelineStatus ?? "unknown"}).` };
  if (state.currentPhase === "review")
    return { ok: false, message: "Review phase must end via `ralph_review_decision`, not the completion marker." };
  if (state.phaseStatus !== "executing")
    return { ok: false, message: `Current phase is not executing (status: ${state.phaseStatus ?? "unknown"}).` };

  const phases = state.phases?.length ? state.phases : DEFAULT_PHASES;
  const idx = state.currentPhaseIndex ?? 0;
  const pk = phases[idx];
  if (!pk) return { ok: false, message: "Current phase is invalid." };

  const result = runPostHook(pk, state);
  if (!result.pass) {
    const attempts = state.phaseAttempts ?? 0;
    if (attempts >= MAX_PHASE_ATTEMPTS) {
      const failedState: PipelineState = { ...state, pipelineStatus: "failed", phaseStatus: "post_hook" };
      saveState(pi, failedState);
      refreshWidget(ctx, failedState);
      ctx.ui.notify(`Phase "${pk}" failed ${MAX_PHASE_ATTEMPTS} times — halted.`, "error");
      return { ok: false, message: `Phase "${pk}" failed validation too many times.` };
    }

    const errList = result.errors?.map((e) => `- ${e}`).join("\n") || "Unknown error";
    ctx.ui.notify(`Post-hook failed for "${pk}" (attempt ${attempts + 1}/${MAX_PHASE_ATTEMPTS})`, "warning");
    sendPipelineUserMessage(
      pi,
      ctx,
      `⛔ Phase validation failed:\n\n${errList}\nFix and retry. Call the registered \`ralph_gate_check\` tool after; do not run it in \`bash\`.`,
      { deliverAs: "steer" },
    );
    const updatedState: PipelineState = { ...state, phaseAttempts: attempts + 1, turnWriteCount: 0 };
    saveState(pi, updatedState);
    refreshWidget(ctx, updatedState);
    return { ok: false, message: `Phase "${pk}" failed validation.` };
  }

  writePhaseCompletionMarker(pk, state.workDir);
  advancePhase(pi, ctx, {
    ...state,
    pipelineStatus: "running",
    phaseStatus: "post_hook",
    turnWriteCount: 0,
    waitingReason: undefined,
    readyToAdvancePhase: undefined,
  });
  return { ok: true, message: `Phase "${pk}" completion recorded.` };
}

async function handleAgentEnd(
  pi: ExtensionAPI,
  event: { messages: Array<{ role?: string; content?: unknown }> },
  ctx: ExtensionContext,
) {
  const state = getState(ctx);
  if (!state) return;
  if (state.pipelineStatus !== "running") {
    refreshWidget(ctx, state);
    return;
  }
  const lastAssistantMessage = [...event.messages].reverse().find((message) => message.role === "assistant");
  const assistantText = extractMessageText(lastAssistantMessage?.content);
  const phases = state.phases?.length ? state.phases : DEFAULT_PHASES;
  const idx = state.currentPhaseIndex ?? 0;
  if (state.currentPhase !== "review" && hasPhaseCompletionMarker(assistantText)) {
    const completion = resolvePhaseCompletion(phases, idx, "explicit_signal");
    if (completion.action !== "wait_for_explicit_completion") {
      handlePhaseCompletion(pi, ctx);
      return;
    }
  }

  if (
    state.currentPhase === "implement" &&
    state.phaseStatus === "executing" &&
    state.readyToAdvancePhase === "implement"
  ) {
    handlePhaseCompletion(pi, ctx);
    return;
  }

  if (state.currentPhase === "implement" && state.phaseStatus === "executing") {
    sendDedupedPipelineUserMessage(
      pi,
      ctx,
      state,
      "Implementation is still in the TDD phase. Call the registered `ralph_gate_check` tool now if implementation is complete. Do not run `ralph_gate_check` in `bash`; it is a Pi extension tool, not a shell command. If work remains, continue the Red-Green-Refactor cycle and call the tool when ready.",
      { deliverAs: "steer", dedupeKey: `implement-gate:${idx}` },
    );
    return;
  }

  const completion = resolvePhaseCompletion(phases, idx, "agent_end");
  if (completion.action === "wait_for_explicit_completion") enterWaitingForUser(pi, ctx, state);
}

// ── Extension Entry Point ──────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Note: turnWriteCount is tracked in PipelineState, not module-level,
  // to survive page reloads and session compaction.

  pi.on("message_start", async (event, ctx) => {
    const state = getState(ctx);
    if (!state || event.message.role !== "assistant") return;
    if (state.waitingReason === IMPLEMENT_CHECKPOINT_WAIT_REASON) {
      setPipelineWaitingUi(ctx, state);
      refreshWidget(ctx, state);
      return;
    }
    const nextState = withoutPendingSteer(state);
    const updated: PipelineState =
      nextState.phaseStatus === WAITING_FOR_USER_PHASE_STATUS
        ? { ...nextState, phaseStatus: "executing", turnWriteCount: 0 }
        : { ...nextState, turnWriteCount: 0 };
    saveState(pi, updated);
    setPipelineWorkingUi(ctx, updated);
  });

  pi.on("message_update", async (_event, ctx) => {
    const state = getState(ctx);
    if (!state || _event.message.role !== "assistant") return;
    refreshWidget(ctx, state);
  });

  pi.on("input", async (event, ctx) => {
    const state = getState(ctx);
    if (!state || state.pipelineStatus !== "running") return;
    if (state.phaseStatus !== WAITING_FOR_USER_PHASE_STATUS) return;
    if (event.text.trim().startsWith("/")) return;
    if (state.waitingReason === IMPLEMENT_CHECKPOINT_WAIT_REASON) {
      ctx.ui.notify("TDD implementation is waiting for review approval. Run /ralph continue to launch it.", "warning");
      setPipelineWaitingUi(ctx, state);
      refreshWidget(ctx, state);
      return;
    }
    const updated: PipelineState = { ...state, phaseStatus: "executing", turnWriteCount: 0 };
    saveState(pi, updated);
    setPipelineWorkingUi(ctx, updated);
    refreshWidget(ctx, updated);
  });

  pi.on("session_start", async (_event, ctx) => {
    const state = getState(ctx);
    if (!state) return;
    const phases = state.phases?.length ? state.phases : DEFAULT_PHASES;
    ctx.ui.notify(`Ralph loop: ${state.feature} (${phases.join(", ")})`, "info");
    if (state.phaseStatus === WAITING_FOR_USER_PHASE_STATUS) setPipelineWaitingUi(ctx, state);
    else setPipelineWorkingUi(ctx, state);
    refreshWidget(ctx, state);

    const currentIdx = state.currentPhaseIndex ?? 0;

    // Guard against corrupted phase index from aggressive compaction
    if (!validatePhaseIndex(currentIdx, phases)) {
      ctx.ui.notify(
        `⛔ Pipeline state corrupted: currentPhaseIndex=${currentIdx} out of bounds. Run /ralph cancel to reset.`,
        "error",
      );
      saveState(pi, { ...state, pipelineStatus: "failed", phaseStatus: "corrupted" });
      return;
    }

    const action = resolveSessionStartAction(state);
    if (action === "resume_execution") {
      const pk = phases[currentIdx];
      const phasePrompt = buildPhasePrompt(pk, state);
      const steerText = wrapSteerMessage(
        `⛔ SESSION RELOAD — Resuming Phase ${currentIdx + 1}: ${PHASE_META[pk]?.name}.

You were interrupted mid-phase. The phase-specific instructions are below — follow them completely before the extension advances you to the next phase.

---

${phasePrompt}`,
        MAX_STEER_SIZE,
      );
      ctx.ui.notify(`Resuming Phase ${currentIdx + 1} (${PHASE_META[pk]?.name})`, "warning");
      sendDedupedPipelineUserMessage(pi, ctx, state, steerText, {
        deliverAs: "steer",
        wrapSteer: false,
      });
      return;
    }

    if (action === "launch_pending_phase") {
      const pk = phases[currentIdx];
      ctx.ui.notify(`Launching queued Phase ${currentIdx + 1} (${PHASE_META[pk]?.name ?? pk})`, "warning");
      launchPhase(pi, ctx, state, {
        asSteer: true,
        prefixText: `⛔ SESSION RELOAD — Launch queued Phase ${currentIdx + 1}: ${PHASE_META[pk]?.name ?? pk}.`,
      });
    }
  });

  // Auto-gate on write operations during gate phases
  pi.on("tool_result", async (event, ctx) => {
    const state = getState(ctx);
    if (!state) return;
    if (!GATE_PHASES.has(state.currentPhase ?? "")) return;
    const currentCount = state.turnWriteCount ?? 0;
    if (event.toolName === "write" || event.toolName === "edit") {
      const newCount = currentCount + 1;
      if (newCount >= GATE_THRESHOLD) {
        saveState(pi, { ...state, turnWriteCount: 0 });
        ctx.ui.notify("🚧 Auto-gate: running lint checks...", "info");
        const results = runLintGates(state.workDir);
        if (results.every((r) => r.pass)) {
          ctx.ui.notify("✅ All gates passed", "info");
          if (state.currentPhase === "implement")
            saveState(pi, { ...state, turnWriteCount: 0, readyToAdvancePhase: "implement" });
        } else {
          ctx.ui.notify(
            `❌ Gate failure: ${results
              .filter((r) => !r.pass)
              .map((r) => r.name)
              .join(", ")}`,
            "error",
          );
          if (state.readyToAdvancePhase) saveState(pi, { ...state, turnWriteCount: 0, readyToAdvancePhase: undefined });
          sendPipelineUserMessage(pi, ctx, `${formatGateResults(results)}\n\nFix and re-check.`, {
            deliverAs: "steer",
          });
        }
        return;
      }
      saveState(pi, { ...state, turnWriteCount: newCount });
    } else {
      saveState(pi, { ...state, turnWriteCount: 0 });
    }
  });

  // Agent end → post-hook → state machine advance
  pi.on("agent_end", async (event, ctx) => {
    const state = getState(ctx);
    if (!state) return;
    saveState(pi, { ...state, turnWriteCount: 0 });
    await handleAgentEnd(pi, event as { messages: Array<{ role?: string; content?: unknown }> }, ctx);
  });

  // ── Tool: ralph_gate_check ──────────────────────────────
  pi.registerTool({
    name: "ralph_gate_check",
    label: "Ralph Gate Check",
    description: "Run quality gates (tsc --noEmit, vitest run). Use after every implementation step.",
    promptSnippet: "Run lint gates — use after implementation/remediation",
    parameters: Type.Object({ paths: Type.Optional(Type.Array(Type.String())) }),
    async execute(_id, params, _sig, onUpdate, ctx) {
      const state = getState(ctx);
      if (!state) return { content: [{ type: "text", text: "No active pipeline." }], details: {} };
      const update = onUpdate as undefined | ((value: { content: Array<{ type: "text"; text: string }> }) => void);
      update?.({ content: [{ type: "text", text: "🚧 Running lint gates..." }] });
      const results = runLintGates(state.workDir, params.paths);
      const allPass = results.every((r) => r.pass);
      saveState(pi, {
        ...state,
        turnWriteCount: 0,
        readyToAdvancePhase: allPass && state.currentPhase === "implement" ? "implement" : undefined,
      });
      const failed = results.filter((r) => !r.pass);
      const report = [
        `## ${allPass ? "✅ All Gates Passed" : "❌ Gate Failures"}`,
        "",
        `| Gate | Status |`,
        `|------|--------|`,
        ...results.map((r) => `| ${r.name} | ${r.pass ? "✅ PASS" : "❌ FAIL"} |`),
        "",
      ];
      for (const f of failed) report.push(`\`${f.output.slice(0, 3000)}\``);
      report.push(allPass ? "All gates passed. Proceed to next phase." : "Fix failures and re-run ralph_gate_check.");
      ctx.ui.setStatus(UI_WIDGET_ID, allPass ? `✅ Gates clear` : `❌ Gates: ${failed.map((f) => f.name).join(", ")}`);
      return { content: [{ type: "text", text: report.join("\n") }], details: { results, allPass } };
    },
  });

  // ── Tool: ralph_review_decision ────────────────────────
  pi.registerTool({
    name: "ralph_review_decision",
    label: "Ralph Review Decision",
    description: "Submit final review verdict. Only call during review phase.",
    parameters: Type.Object({
      status: Type.Union([Type.Literal("LGTM"), Type.Literal("CRITICAL")]),
      issues: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id, params, _sig, onUpdate, ctx) {
      const state = getState(ctx);
      if (!state) return { content: [{ type: "text", text: "No active pipeline." }], details: {} };
      // Phase gate — reject decisions from non-review phases
      if (state.currentPhase !== "review")
        return {
          content: [
            {
              type: "text",
              text: `ERROR: ralph_review_decision can only be called during review phase (current: ${state.currentPhase}).`,
            },
          ],
          details: {},
        };
      handleReviewDecision(pi, ctx, params as { status: string; issues?: string[] });
      return { content: [{ type: "text", text: `Decision recorded: ${params.status}` }], details: {} };
    },
  });

  // ── Command: /ralph ────────────────────────────────────
  pi.registerCommand("ralph", {
    description: "Dev-cycle pipeline (start | status | cancel | gate | continue | resume | pause)",
    getArgumentCompletions: (prefix: string) => {
      const items = [
        "start",
        "status",
        "cancel",
        "gate",
        "continue",
        "resume",
        "pause",
        "clear-context",
        RENDER_HTML_FLAG,
        YOLO_FLAG,
        "spec",
        "redteam",
        "harden",
        "render",
        "implement",
        "review",
      ].map((v) => ({ value: v, label: v }));
      return items.filter((i) => i.value.startsWith(prefix));
    },
    handler: async (args, ctx) => {
      const parts = parseCommandArgs(args.trim());
      const cmd = parts[0]?.toLowerCase();
      switch (cmd) {
        case "start": {
          if (getState(ctx)) {
            ctx.ui.notify("Pipeline already running. /ralph cancel first.", "error");
            return;
          }
          const feature = parts[1];
          if (!feature) {
            ctx.ui.notify("Usage: /ralph start <feature> [prompt] [phases] [--render-html] [--yolo]", "error");
            return;
          }
          const validPhases = new Set<string>(PHASE_ORDER);
          let phases: string[] = [...DEFAULT_PHASES];
          let promptArg: string | undefined;
          const parsedStartArgs = parseRalphFlags(parts.slice(2));
          if (parsedStartArgs.args[0]) {
            const mp = parsedStartArgs.args[0].split(",").map((p) => p.trim());
            if (mp.every((p) => validPhases.has(p))) {
              phases = mp;
            } else {
              promptArg = parsedStartArgs.args[0];
              if (parsedStartArgs.args[1]) {
                const rp = parsedStartArgs.args[1]
                  .split(",")
                  .map((p) => p.trim())
                  .filter((p) => validPhases.has(p));
                if (rp.length) phases = rp;
              }
            }
          }
          if (parsedStartArgs.renderHtml) phases = addRenderPhase(phases);
          // Validate phase order
          const validation = validatePhaseOrder(phases);
          if (!validation.valid) {
            ctx.ui.notify(`Invalid phase order: ${validation.error}`, "error");
            return;
          }
          const missingSkills = getMissingPhaseSkillPrerequisites(phases);
          if (missingSkills.length) {
            ctx.ui.notify(formatMissingPhaseSkillPrerequisites(missingSkills), "error");
            return;
          }
          const promptText = promptArg ? resolvePromptInput(promptArg, ctx.cwd) : undefined;
          // Check pipeline lock
          const lockCheck = checkPipelineLock(feature, ctx.cwd);
          if (lockCheck.locked && !lockCheck.stale) {
            ctx.ui.notify("Pipeline already running — /ralph cancel first.", "error");
            return;
          }
          createPipelineLock(feature, ctx.cwd);
          const state: PipelineState = {
            feature,
            workDir: ctx.cwd,
            phases,
            maxIterations: 10,
            startedAt: Date.now(),
            currentPhaseIndex: 0,
            currentPhase: phases[0],
            phaseStatus: "pre_hook",
            pipelineStatus: "running",
            reviewIterations: 0,
            phaseAttempts: 0,
            turnWriteCount: 0,
            promptText,
            autoClearContext: true,
            yoloMode: parsedStartArgs.yolo,
          };
          saveState(pi, state);
          refreshWidget(ctx, state);
          ctx.ui.notify(`Starting pipeline for "${feature}" (${phases.join(", ")})`, "info");
          ctx.ui.setStatus(UI_WIDGET_ID, `🔄 Starting | ${feature}`);
          launchPhase(pi, ctx, state);
          if (getState(ctx)?.pipelineStatus === "failed") removePipelineLock(feature, ctx.cwd);
          break;
        }
        case "continue": {
          const state = getState(ctx);
          if (!state) {
            ctx.ui.notify("No pipeline to continue.", "error");
            return;
          }
          if (state.pipelineStatus === "completed") {
            ctx.ui.notify("Pipeline already completed.", "info");
            return;
          }
          if (state.pipelineStatus === "cancelled") {
            ctx.ui.notify("Pipeline was cancelled. Start a new pipeline with /ralph start.", "error");
            return;
          }

          const continueArgs = parseRalphFlags(parts.slice(1));
          const basePhases = state.phases?.length ? state.phases : DEFAULT_PHASES;
          let phases = [...basePhases];
          let targetIdx = state.currentPhaseIndex ?? 0;
          if (!validatePhaseIndex(targetIdx, phases)) {
            ctx.ui.notify(
              `⛔ Pipeline state corrupted: currentPhaseIndex=${targetIdx} out of bounds. Run /ralph cancel to reset.`,
              "error",
            );
            saveState(pi, { ...state, pipelineStatus: "failed", phaseStatus: "corrupted" });
            return;
          }
          if (continueArgs.renderHtml && !phases.includes(RENDER_PHASE)) {
            if (!canAddRenderBeforeCurrentPhase(phases, targetIdx)) {
              ctx.ui.notify(
                `Cannot enable HTML rendering after the render point has passed. Current phase: ${phases[targetIdx] ?? "unknown"}.`,
                "error",
              );
              return;
            }
            phases = addRenderPhase(phases);
            targetIdx = resolveCurrentPhaseIndex(state, phases, targetIdx);
          }
          const validation = validatePhaseOrder(phases);
          if (!validation.valid) {
            ctx.ui.notify(`Invalid phase order: ${validation.error}`, "error");
            return;
          }

          const pk = phases[targetIdx];
          const yoloMode = state.yoloMode || continueArgs.yolo;
          const approvingImplementCheckpoint =
            state.waitingReason === IMPLEMENT_CHECKPOINT_WAIT_REASON && pk === "implement";
          removePipelineLock(state.feature, state.workDir);
          createPipelineLock(state.feature, state.workDir);
          const updated: PipelineState = {
            ...state,
            phases,
            currentPhaseIndex: targetIdx,
            currentPhase: pk,
            phaseStatus: "pre_hook",
            pipelineStatus: "running",
            phaseAttempts: 0,
            turnWriteCount: 0,
            waitingReason: undefined,
            yoloMode,
            implementCheckpointApproved: state.implementCheckpointApproved || approvingImplementCheckpoint || yoloMode,
            readyToAdvancePhase: undefined,
          };
          saveState(pi, updated);
          refreshWidget(ctx, updated);
          ctx.ui.notify(`Continuing Phase ${targetIdx + 1} (${PHASE_META[pk]?.name ?? pk})`, "info");
          ctx.ui.setStatus(UI_WIDGET_ID, `🔄 Continuing | ${state.feature}`);
          launchPhase(pi, ctx, updated);
          break;
        }
        case "resume": {
          const state = getState(ctx);
          if (!state) {
            ctx.ui.notify("No pipeline to resume.", "error");
            return;
          }
          if (state.pipelineStatus === "completed") {
            ctx.ui.notify("Pipeline already completed.", "info");
            return;
          }
          // Remove stale lock or keep existing
          removePipelineLock(state.feature, state.workDir);
          createPipelineLock(state.feature, state.workDir);
          const phases = state.phases?.length ? state.phases : DEFAULT_PHASES;
          const resumePhase = parts[1];
          let targetIdx = state.currentPhaseIndex ?? 0;
          if (resumePhase) {
            const ri = phases.indexOf(resumePhase);
            if (ri >= 0) targetIdx = ri;
          }
          // Check completion markers for crash recovery
          if (phaseCompletionMarkerExists(state, phases[targetIdx])) {
            targetIdx = Math.min(targetIdx + 1, phases.length - 1);
          }
          const pk = phases[targetIdx];
          ctx.ui.notify(`Resuming at Phase ${targetIdx + 1} (${PHASE_META[pk]?.name ?? pk})`, "info");
          const updated: PipelineState = {
            ...state,
            currentPhaseIndex: targetIdx,
            currentPhase: pk,
            phaseStatus: "pre_hook",
            pipelineStatus: "running",
            phaseAttempts: 0,
            waitingReason: undefined,
            implementCheckpointApproved: state.implementCheckpointApproved || pk === "implement",
            readyToAdvancePhase: undefined,
          };
          saveState(pi, updated);
          refreshWidget(ctx, updated);
          ctx.ui.setStatus(UI_WIDGET_ID, `🔄 Resuming | ${state.feature}`);
          launchPhase(pi, ctx, updated);
          break;
        }
        case "pause": {
          const state = getState(ctx);
          if (!state) {
            ctx.ui.notify("No active pipeline.", "info");
            return;
          }
          saveState(pi, { ...state, pipelineStatus: "paused", phaseStatus: "post_hook" });
          ctx.ui.setStatus(UI_WIDGET_ID, `⏸ Paused | ${state.feature}`);
          ctx.ui.notify(`Pipeline paused. Use /ralph resume to continue.`, "warning");
          break;
        }
        case "gate": {
          const state = getState(ctx) || { workDir: ctx.cwd };
          const results = runLintGates(state.workDir, parts.slice(1));
          ctx.ui.notify(
            results.every((r) => r.pass)
              ? "✅ All gates passed"
              : `❌ Failed: ${results
                  .filter((r) => !r.pass)
                  .map((r) => r.name)
                  .join(", ")}`,
            results.every((r) => r.pass) ? "info" : "error",
          );
          break;
        }
        case "status": {
          const state = getState(ctx);
          if (!state) {
            ctx.ui.notify("No active pipeline.", "info");
            return;
          }
          const phases = state.phases?.length ? state.phases : DEFAULT_PHASES;
          const idx = state.currentPhaseIndex ?? 0;
          const pk = phases[idx];
          ctx.ui.notify(
            [
              `Feature: ${state.feature}`,
              `Status: ${state.pipelineStatus ?? "running"}`,
              `phaseStatus: ${state.phaseStatus ?? "executing"}`,
              `Current: Phase ${idx + 1} — ${PHASE_META[pk]?.name ?? pk}`,
              `Phases: ${phases.join(" → ")}`,
              `reviewIterations: ${state.reviewIterations ?? 0}`,
              `phaseAttempts: ${state.phaseAttempts ?? 0}`,
              `Context clears: ${state.contextClearCount ?? 0}`,
              `Auto clear: ${(state.autoClearContext ?? false) ? "ON" : "OFF"}`,
              `Yolo mode: ${(state.yoloMode ?? false) ? "ON" : "OFF"}`,
              `Started: ${new Date(state.startedAt).toISOString()}`,
            ].join("\n"),
            "info",
          );
          break;
        }
        case "cancel": {
          const state = getState(ctx);
          if (state) removePipelineLock(state.feature, state.workDir);
          clearPipelineWidgetCache();
          ctx.ui.setStatus(UI_WIDGET_ID, "");
          ctx.ui.setWidget(UI_WIDGET_ID, []);
          ctx.ui.notify("Pipeline cancelled", "warning");
          break;
        }
        case "clear-context": {
          const cs = getState(ctx);
          if (!cs) {
            ctx.ui.notify("No active pipeline.", "error");
            return;
          }
          // Parse flags
          const flag = parts[1];
          if (flag && flag !== "--auto") {
            ctx.ui.notify("Unknown flag. Usage: /ralph clear-context [--auto]", "error");
            return;
          }
          const clearState = flag === "--auto" ? { ...cs, autoClearContext: true } : cs;
          if (flag === "--auto") {
            saveState(pi, clearState);
          }
          // Validate clear
          const check = canClearContext(clearState);
          if (!check.ok) {
            ctx.ui.notify("Cannot clear context: " + (check.reason ?? "unknown"), "error");
            return;
          }
          // Build artifact list for prompt augmentation
          const artifacts = resolveArtifactPaths(clearState);
          let artList = "";
          if (artifacts.length > 0) artList = "\nArtifacts on disk:\n" + artifacts.map((a) => "- " + a).join("\n");
          // Trigger compaction via ctx, then send steer message in onComplete
          setPipelineCompactingUi(ctx, clearState);
          ctx.compact({
            customInstructions:
              "Preserve pipeline phase context and file operations. Focus on current task instructions.",
            onComplete: (_result) => {
              try {
                // Re-validate cooldown before committing (race guard)
                if (!canClearContext(clearState).ok) {
                  setPipelineWorkingUi(ctx, clearState);
                  refreshWidget(ctx, clearState);
                  ctx.ui.notify("Context clear skipped — cooldown active", "info");
                  return;
                }
                const prompt = buildReorientationPrompt(clearState);
                const fullMsg = wrapSteerMessage(prompt + artList, MAX_STEER_SIZE);
                sendPipelineUserMessage(pi, ctx, fullMsg, { deliverAs: "steer", wrapSteer: false });
                // Increment counter only after successful send (not before)
                const updated = {
                  ...clearState,
                  contextClearCount: (clearState.contextClearCount ?? 0) + 1,
                  lastContextClearAt: Date.now(),
                };
                saveState(pi, updated);
                setPipelineWorkingUi(ctx, updated);
                refreshWidget(ctx, updated);
                ctx.ui.notify(
                  "Context cleared — Phase " +
                    ((clearState.currentPhaseIndex ?? 0) + 1) +
                    "/" +
                    (clearState.phases?.length ?? "?") +
                    " resumed",
                  "info",
                );
              } catch (e) {
                setPipelineWorkingUi(ctx, clearState);
                refreshWidget(ctx, clearState);
                ctx.ui.notify("Steer failed: " + String(e), "error");
              }
            },
            onError: (_err) => {
              // Fallback: send steer-only without compaction
              try {
                const prompt = buildReorientationPrompt(clearState);
                sendPipelineUserMessage(pi, ctx, prompt, { deliverAs: "steer" });
                const updated = {
                  ...clearState,
                  contextClearCount: (clearState.contextClearCount ?? 0) + 1,
                  lastContextClearAt: Date.now(),
                };
                saveState(pi, updated);
                setPipelineWorkingUi(ctx, updated);
                refreshWidget(ctx, updated);
                ctx.ui.notify("Context cleared (compaction fallback)", "warning");
              } catch (e) {
                setPipelineWorkingUi(ctx, clearState);
                refreshWidget(ctx, clearState);
                ctx.ui.notify("Clear failed entirely: " + String(e), "error");
              }
            },
          });
          break;
        }
        default: {
          if (cmd && !cmd.startsWith("-")) {
            // Shorthand: /ralph <feature>
            if (!getState(ctx)) {
              const feature = cmd;
              const state: PipelineState = {
                feature,
                workDir: ctx.cwd,
                phases: [...DEFAULT_PHASES],
                maxIterations: 10,
                startedAt: Date.now(),
                currentPhaseIndex: 0,
                currentPhase: "spec",
                phaseStatus: "executing",
                pipelineStatus: "running",
                reviewIterations: 0,
                phaseAttempts: 0,
                turnWriteCount: 0,
                autoClearContext: true,
              };
              saveState(pi, state);
              refreshWidget(ctx, state);
              createPipelineLock(feature, ctx.cwd);
              sendPipelineUserMessage(pi, ctx, buildPhasePrompt("spec", state));
            }
          } else {
            ctx.ui.notify(
              "Usage: /ralph start <feature> [--render-html] [--yolo] | status | cancel | gate | continue [--render-html] [--yolo] | resume | pause | clear-context [--auto]",
              "info",
            );
          }
        }
      }
    },
  });

  // ── Resources discovery ─────────────────────────────────
  pi.on("resources_discover", async () => ({ skillPaths: [SKILL_BASE] }));

  // ── Single-skill injection per phase ────────────────────
  pi.on("before_agent_start", async (event, ctx) => {
    const state = getState(ctx);
    if (!state) return;
    const pk = state.currentPhase;
    if (!pk || !PHASE_CONFIGS[pk]) return;
    const skillPath = PHASE_CONFIGS[pk].skillPath;
    if (!fs.existsSync(skillPath)) return;
    try {
      const content = fs.readFileSync(skillPath, "utf-8");
      if (!event.systemPrompt.includes(pk + "-skill")) {
        return { systemPrompt: event.systemPrompt + `\n\n<ralph-${pk}-skill>\n${content}\n</ralph-${pk}-skill>` };
      }
    } catch {}
  });
}
