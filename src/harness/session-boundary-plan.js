import { listArtifactReferences } from "../artifacts/artifact-tracker.js";
import {
  HARDEN_APPROVAL_STATUS,
  PHASE_COMPLETE_MARKER,
} from "../state/phase-completion.js";

export const RALPH_WORKS_SESSION_BOUNDARY_MESSAGE_TYPE =
  "ralph-works-session-boundary";

const MAX_GATE_RESULTS = 10;
const MAX_BOUNDARY_EVENTS = 20;
const MAX_TRANSITIONS = 5;
const MAX_TEXT_LENGTH = 2000;
const REVIEW_CHANGES_REQUESTED_MARKER = "RALPH_REVIEW_CHANGES_REQUESTED";

function boundedString(value, maxLength = MAX_TEXT_LENGTH) {
  if (typeof value !== "string") {
    return undefined;
  }

  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}…[truncated]`;
}

function serializableNumber(value) {
  return Number.isFinite(value) ? value : undefined;
}

function omitUndefined(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined),
  );
}

function toJsonCompatible(value) {
  if (value === undefined || typeof value === "function") {
    return undefined;
  }

  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => toJsonCompatible(item))
      .filter((item) => item !== undefined);
  }

  if (typeof value === "object") {
    return omitUndefined(
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          toJsonCompatible(item),
        ]),
      ),
    );
  }

  return undefined;
}

function redactSensitiveText(value) {
  return String(value ?? "")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(
      /\b(?:api[_-]?key|secret|token|password|credential)[\w.-]*\s*[:=]\s*[^\s,;]+/gi,
      "[redacted secret]",
    );
}

export function normalizeReviewFeedback(reviewFeedback) {
  if (typeof reviewFeedback !== "string") {
    return undefined;
  }

  const normalized = redactSensitiveText(reviewFeedback)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(
      (line) =>
        line !== REVIEW_CHANGES_REQUESTED_MARKER &&
        line !== PHASE_COMPLETE_MARKER,
    )
    .join("\n");

  return normalized ? boundedString(normalized) : undefined;
}

function summarizeTransition(entry) {
  return toJsonCompatible({
    from: entry.from,
    to: entry.to,
    reason: boundedString(entry.reason, 300),
    kind: entry.kind,
    at: entry.at,
  });
}

function summarizeBoundaryEvent(event) {
  return toJsonCompatible({
    id: event.id,
    boundaryType: event.boundaryType,
    reason: boundedString(event.reason, 300),
    fromPhase: event.fromPhase,
    toPhase: event.toPhase,
    taskId: event.taskId,
    nextTaskId: event.nextTaskId,
    reviewFeedback: normalizeReviewFeedback(event.reviewFeedback),
    timestamp: event.timestamp,
    status: event.status,
    freshSessionAttempted: event.freshSessionAttempted,
    freshSessionCreated: event.freshSessionCreated,
    fallbackUsed: event.fallbackUsed,
    elapsedMs: serializableNumber(event.elapsedMs),
    previousSessionId: event.previousSessionId,
    replacementSessionId: event.replacementSessionId,
  });
}

function summarizeCompactionEvent(event) {
  return toJsonCompatible({
    boundary: event.boundary,
    reason: boundedString(event.reason, 300),
    at: event.at,
  });
}

function summarizeImplementationStatus(status = {}) {
  return toJsonCompatible({
    completedTaskIds: Array.isArray(status.completedTaskIds)
      ? status.completedTaskIds
      : [],
    claimedTaskIds: Array.isArray(status.claimedTaskIds)
      ? status.claimedTaskIds
      : [],
    gateResultsByTask: status.gateResultsByTask
      ? Object.fromEntries(
          Object.entries(status.gateResultsByTask).map(([taskId, results]) => [
            taskId,
            summarizeGateResults(results).results,
          ]),
        )
      : {},
  });
}

export function summarizeGateResults(gateResults = []) {
  const results = (Array.isArray(gateResults) ? gateResults : [])
    .slice(-MAX_GATE_RESULTS)
    .map((result) =>
      toJsonCompatible({
        name: result.name,
        command: boundedString(result.command, 300),
        required: result.required !== false,
        passed: result.passed === true,
        code: serializableNumber(result.code),
        blocksTransition: result.blocksTransition === true,
        killed: result.killed === true,
      }),
    );

  return toJsonCompatible({
    total: results.length,
    passed: results.every(
      (result) => result.required === false || result.passed,
    ),
    blockingFailures: results
      .filter((result) => result.blocksTransition)
      .map((result) => result.name),
    results,
  });
}

function buildStateSnapshot(state) {
  return toJsonCompatible({
    extensionName: state.extensionName,
    feature: state.feature,
    promptText: boundedString(state.promptText),
    pipelineStatus: state.pipelineStatus,
    phaseStatus: state.phaseStatus,
    currentPhase: state.currentPhase,
    completedPhases: Array.isArray(state.completedPhases)
      ? state.completedPhases
      : [],
    transitionHistory: Array.isArray(state.transitionHistory)
      ? state.transitionHistory.slice(-MAX_TRANSITIONS).map(summarizeTransition)
      : [],
    phases: Array.isArray(state.phases)
      ? state.phases.map((phase) =>
          toJsonCompatible({
            id: phase.id,
            label: phase.label,
            skillDirectory: phase.skillDirectory,
            artifactKey: phase.artifactKey,
            artifactPath: phase.artifactPath,
          }),
        )
      : [],
    loopbackCount: serializableNumber(state.loopbackCount) ?? 0,
    gateResults: summarizeGateResults(state.gateResults).results,
    artifacts: state.artifacts ?? {},
    implementationStatus: summarizeImplementationStatus(
      state.implementationStatus,
    ),
    tddCompletedTasks: serializableNumber(state.tddCompletedTasks) ?? 0,
    sessionBoundaryEvents: Array.isArray(state.sessionBoundaryEvents)
      ? state.sessionBoundaryEvents
          .slice(-MAX_BOUNDARY_EVENTS)
          .map(summarizeBoundaryEvent)
      : [],
    compactionEvents: Array.isArray(state.compactionEvents)
      ? state.compactionEvents
          .slice(-MAX_BOUNDARY_EVENTS)
          .map(summarizeCompactionEvent)
      : [],
  });
}

function normalizeArtifactPaths(state, artifactPaths) {
  if (Array.isArray(artifactPaths)) {
    return toJsonCompatible(
      artifactPaths.map((artifact) => ({
        key: artifact.key,
        path: artifact.path,
      })),
    );
  }

  return toJsonCompatible(listArtifactReferences(state));
}

function normalizeModelTarget(selectedModelTarget) {
  if (!selectedModelTarget) {
    return undefined;
  }

  if (typeof selectedModelTarget === "string") {
    return { raw: selectedModelTarget };
  }

  return toJsonCompatible({
    provider: selectedModelTarget.provider,
    id: selectedModelTarget.id ?? selectedModelTarget.modelId,
    modelId: selectedModelTarget.modelId,
    raw: selectedModelTarget.raw,
  });
}

function normalizeTaskDetails(task) {
  if (!task) {
    return undefined;
  }

  return toJsonCompatible({
    id: task.id,
    title: boundedString(task.title, 500),
    priority: serializableNumber(task.priority),
    lineNumber: serializableNumber(task.lineNumber),
    text: boundedString(task.text ?? task.raw ?? task.title),
    acceptanceCriteria: Array.isArray(task.acceptanceCriteria)
      ? task.acceptanceCriteria.map((criterion) =>
          boundedString(criterion, 500),
        )
      : undefined,
  });
}

function approvalInstruction(state) {
  if (state.phaseStatus !== HARDEN_APPROVAL_STATUS) {
    return undefined;
  }

  return "Run `/ralph-works approve` to continue, or `/ralph-works approve --render-html` to render HTML first.";
}

function buildResumeContext({
  state,
  boundaryId,
  boundaryType,
  reason,
  nextActionType,
  artifactPaths,
  taskDetails,
  latestGateSummary,
  reviewFeedback,
}) {
  return toJsonCompatible({
    workflowName: state.extensionName ?? "ralph-works",
    feature: state.feature,
    currentPhase: state.currentPhase,
    phaseStatus: state.phaseStatus,
    boundaryId,
    boundaryType,
    boundaryReason: reason,
    nextActionType,
    artifactPaths,
    task: taskDetails,
    latestGateSummary,
    reviewFeedback,
    pendingApprovalInstruction: approvalInstruction(state),
    authoritativeInstruction:
      "Repository files and RalphWorks artifacts are authoritative. Inspect them before continuing.",
  });
}

function formatGateSummary(summary) {
  if (!summary.results.length) {
    return ["- none recorded"];
  }

  return summary.results.map((result) => {
    const status = result.passed ? "passed" : "failed";
    const required = result.required ? "required" : "optional";
    return `- ${result.name}: ${status} (${required})`;
  });
}

function formatArtifacts(artifactPaths) {
  if (!artifactPaths.length) {
    return ["- none recorded"];
  }

  return artifactPaths.map((artifact) => `- ${artifact.key}: ${artifact.path}`);
}

function formatResumeContext(context) {
  const lines = [
    "",
    "Resume context:",
    `- Workflow: ${context.workflowName}`,
    `- Feature: ${context.feature ?? "unspecified"}`,
    `- Current phase: ${context.currentPhase}`,
    `- Phase status: ${context.phaseStatus ?? "unspecified"}`,
    `- Boundary ID: ${context.boundaryId}`,
    `- Boundary reason: ${context.boundaryReason}`,
    `- Next action: ${context.nextActionType}`,
  ];

  if (context.pendingApprovalInstruction) {
    lines.push(`- Action required: ${context.pendingApprovalInstruction}`);
  }

  if (context.reviewFeedback) {
    lines.push("", "Review context:", context.reviewFeedback);
  }

  if (context.task) {
    lines.push("", "Next task:");
    lines.push(`- ${context.task.id}: ${context.task.title}`);
    if (context.task.text) {
      lines.push(`- Task text: ${context.task.text}`);
    }
    if (context.task.acceptanceCriteria?.length) {
      lines.push("- Acceptance criteria:");
      for (const criterion of context.task.acceptanceCriteria) {
        lines.push(`  - ${criterion}`);
      }
    }
  }

  lines.push("", "Artifacts:", ...formatArtifacts(context.artifactPaths));
  lines.push(
    "",
    "Latest gate summary:",
    ...formatGateSummary(context.latestGateSummary),
  );
  lines.push("", context.authoritativeInstruction);

  return lines.join("\n");
}

export function buildSessionBoundaryAnnouncement(boundaryType) {
  return `RalphWorks is starting a new session for ${boundaryType}. Repository files and RalphWorks artifacts are authoritative.`;
}

function buildCustomMessage(plan) {
  const announcement = buildSessionBoundaryAnnouncement(plan.boundaryType);
  return toJsonCompatible({
    customType: RALPH_WORKS_SESSION_BOUNDARY_MESSAGE_TYPE,
    content: `${announcement}\n${formatResumeContext(plan.resumeContext)}`,
    display: true,
    details: {
      boundaryId: plan.boundaryId,
      boundaryType: plan.boundaryType,
      reason: plan.reason,
      nextActionType: plan.nextActionType,
    },
  });
}

export function buildSessionBoundaryPlan(
  state,
  {
    boundaryId,
    boundaryType,
    reason = "workflow boundary",
    nextActionType,
    kickoffPrompt,
    artifactPaths,
    selectedModelTarget,
    task,
    gateResults,
    reviewFeedback,
  } = {},
) {
  if (!boundaryId) {
    throw new Error("Session boundary plan requires a boundaryId.");
  }
  if (!boundaryType) {
    throw new Error("Session boundary plan requires a boundaryType.");
  }
  if (!nextActionType) {
    throw new Error("Session boundary plan requires a nextActionType.");
  }

  const normalizedArtifactPaths = normalizeArtifactPaths(state, artifactPaths);
  const taskDetails = normalizeTaskDetails(task);
  const latestGateSummary = summarizeGateResults(
    gateResults ?? state.gateResults,
  );
  const normalizedReviewFeedback = normalizeReviewFeedback(reviewFeedback);
  const resumeContext = buildResumeContext({
    state,
    boundaryId,
    boundaryType,
    reason,
    nextActionType,
    artifactPaths: normalizedArtifactPaths,
    taskDetails,
    latestGateSummary,
    reviewFeedback: normalizedReviewFeedback,
  });

  const plan = toJsonCompatible({
    boundaryId,
    boundaryType,
    reason,
    nextState: buildStateSnapshot(state),
    nextActionType,
    kickoffPrompt:
      typeof kickoffPrompt === "string" ? kickoffPrompt : undefined,
    artifactPaths: normalizedArtifactPaths,
    selectedModelTarget: normalizeModelTarget(selectedModelTarget),
    taskDetails,
    latestGateSummary,
    reviewFeedback: normalizedReviewFeedback,
    resumeContext,
  });

  return {
    ...plan,
    customMessage: buildCustomMessage(plan),
  };
}
