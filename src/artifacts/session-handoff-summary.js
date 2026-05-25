import {
  closeSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

import { HARDEN_APPROVAL_STATUS } from "../state/phase-completion.js";
import { getPhaseDefinition, RALPH_WORKS_NAME } from "../state/phase-state.js";

export const DEFAULT_ARTIFACT_INVENTORY_LIMITS = {
  perArtifactBytes: 8 * 1024,
  perArtifactLines: 100,
  totalArtifactBytes: 32 * 1024,
};

function normalizeLimits(limits = {}) {
  return {
    ...DEFAULT_ARTIFACT_INVENTORY_LIMITS,
    ...limits,
  };
}

function phaseDefinitions(state) {
  return state?.phases ?? [];
}

function phaseDefinitionFor(state, phaseId) {
  return (
    phaseDefinitions(state).find((phase) => phase.id === phaseId) ??
    getPhaseDefinition(phaseId)
  );
}

function phaseDefinitionForArtifactKey(state, artifactKey) {
  return (
    phaseDefinitions(state).find(
      (phase) => phase.artifactKey === artifactKey,
    ) ??
    getPhaseDefinition(
      phaseDefinitions(state).find((phase) => phase.artifactKey === artifactKey)
        ?.id,
    )
  );
}

function hasOwn(object, key) {
  return Object.hasOwn(object ?? {}, key);
}

function addArtifact(artifacts, seen, artifact) {
  if (!artifact?.key || !artifact?.path) {
    return;
  }

  const dedupeKey = `${artifact.key}\0${artifact.path}`;
  if (seen.has(dedupeKey)) {
    return;
  }

  seen.add(dedupeKey);
  artifacts.push(artifact);
}

function normalizeExplicitArtifact(artifact, index) {
  if (typeof artifact === "string") {
    return {
      key: `currentArtifact${index + 1}`,
      path: artifact,
      source: "explicit",
    };
  }

  return {
    key: artifact.key ?? `currentArtifact${index + 1}`,
    path: artifact.path,
    phaseId: artifact.phaseId,
    phaseLabel: artifact.phaseLabel,
    source: artifact.source ?? "explicit",
  };
}

function artifactCandidates(state, { cwd, currentArtifacts = [] } = {}) {
  const artifacts = [];
  const seen = new Set();
  const recordedArtifacts = state?.artifacts ?? {};

  for (const phaseId of state?.completedPhases ?? []) {
    const phase = phaseDefinitionFor(state, phaseId);
    if (!phase?.artifactKey || !phase?.artifactPath) {
      continue;
    }

    addArtifact(artifacts, seen, {
      key: phase.artifactKey,
      path: recordedArtifacts[phase.artifactKey] ?? phase.artifactPath,
      phaseId: phase.id,
      phaseLabel: phase.label,
      source: "completedPhase",
    });
  }

  for (const key of Object.keys(recordedArtifacts).sort()) {
    const phase = phaseDefinitionForArtifactKey(state, key);
    addArtifact(artifacts, seen, {
      key,
      path: recordedArtifacts[key],
      phaseId: phase?.id,
      phaseLabel: phase?.label,
      source: "recorded",
    });
  }

  const currentPhase = phaseDefinitionFor(state, state?.currentPhase);
  if (
    currentPhase?.artifactKey &&
    currentPhase?.artifactPath &&
    !hasOwn(recordedArtifacts, currentPhase.artifactKey) &&
    artifactPathExists(cwd, currentPhase.artifactPath)
  ) {
    addArtifact(artifacts, seen, {
      key: currentPhase.artifactKey,
      path: currentPhase.artifactPath,
      phaseId: currentPhase.id,
      phaseLabel: currentPhase.label,
      source: "currentPhase",
    });
  }

  currentArtifacts.map(normalizeExplicitArtifact).forEach((artifact) => {
    const phase = artifact.phaseId
      ? phaseDefinitionFor(state, artifact.phaseId)
      : phaseDefinitionForArtifactKey(state, artifact.key);
    addArtifact(artifacts, seen, {
      ...artifact,
      phaseId: artifact.phaseId ?? phase?.id,
      phaseLabel: artifact.phaseLabel ?? phase?.label,
    });
  });

  return artifacts;
}

function resolveArtifactPath(cwd, artifactPath) {
  return path.resolve(cwd, artifactPath);
}

function isInsideWorkspace(workspaceRoot, absolutePath) {
  const relativePath = path.relative(workspaceRoot, absolutePath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

function artifactPathExists(cwd = process.cwd(), artifactPath) {
  const workspaceRoot = path.resolve(cwd);
  const absolutePath = resolveArtifactPath(workspaceRoot, artifactPath);
  if (!isInsideWorkspace(workspaceRoot, absolutePath)) {
    return false;
  }

  try {
    lstatSync(absolutePath);
    return true;
  } catch {
    return false;
  }
}

function skippedArtifact(artifact, absolutePath, reason) {
  return {
    ...artifact,
    absolutePath,
    status: "skipped",
    omissionReason: reason,
  };
}

function missingArtifact(artifact, absolutePath) {
  return {
    ...artifact,
    absolutePath,
    status: "missing",
    omissionReason: "file does not exist",
  };
}

function decodeUtf8Prefix(buffer) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const minimumEnd = buffer.length === 0 ? 0 : Math.max(buffer.length - 4, 1);

  for (let end = buffer.length; end >= minimumEnd; end -= 1) {
    try {
      return {
        text: decoder.decode(buffer.subarray(0, end)),
        decodedBytes: end,
      };
    } catch {
      // Try a shorter prefix in case the bounded read split a multi-byte
      // character. If the content itself is invalid, no short prefix succeeds.
    }
  }

  return undefined;
}

function limitLines(text, perArtifactLines) {
  const lines = text.split("\n");
  if (lines.length <= perArtifactLines) {
    return { text, truncated: false };
  }

  return {
    text: lines.slice(0, perArtifactLines).join("\n"),
    truncated: true,
  };
}

function readBoundedArtifactText(filePath, fileSize, limits, remainingBudget) {
  const bytesToRead = Math.min(
    limits.perArtifactBytes,
    remainingBudget,
    fileSize,
  );

  if (bytesToRead <= 0) {
    return {
      status: "skipped",
      omissionReason: "artifact excerpt budget exhausted",
    };
  }

  const descriptor = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const bytesRead = readSync(descriptor, buffer, 0, bytesToRead, 0);
    const content = buffer.subarray(0, bytesRead);

    if (content.includes(0)) {
      return {
        status: "skipped",
        omissionReason: "binary or non-UTF-8 file",
      };
    }

    const decoded = decodeUtf8Prefix(content);
    if (!decoded) {
      return {
        status: "skipped",
        omissionReason: "binary or non-UTF-8 file",
      };
    }

    const lineLimited = limitLines(decoded.text, limits.perArtifactLines);
    const excerptBytes = Buffer.byteLength(lineLimited.text, "utf8");
    const truncated =
      fileSize > decoded.decodedBytes ||
      decoded.decodedBytes < bytesRead ||
      lineLimited.truncated;

    return {
      status: "present",
      excerpt: lineLimited.text,
      excerptBytes,
      omissionReason: truncated
        ? "excerpt truncated to configured budget"
        : undefined,
    };
  } finally {
    closeSync(descriptor);
  }
}

function inspectArtifact(artifact, workspaceRoot, limits, budget) {
  const absolutePath = resolveArtifactPath(workspaceRoot, artifact.path);
  if (!isInsideWorkspace(workspaceRoot, absolutePath)) {
    return skippedArtifact(artifact, absolutePath, "outside workspace");
  }

  let lstat;
  try {
    lstat = lstatSync(absolutePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return missingArtifact(artifact, absolutePath);
    }

    return skippedArtifact(
      artifact,
      absolutePath,
      `unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let realPath;
  try {
    realPath = realpathSync(absolutePath);
  } catch (error) {
    return skippedArtifact(
      artifact,
      absolutePath,
      `unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!isInsideWorkspace(workspaceRoot, realPath)) {
    return skippedArtifact(
      artifact,
      absolutePath,
      lstat.isSymbolicLink()
        ? "symlink target escapes workspace"
        : "path escapes workspace through symlink",
    );
  }

  let stat;
  try {
    stat = statSync(realPath);
  } catch (error) {
    return skippedArtifact(
      artifact,
      absolutePath,
      `unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!stat.isFile()) {
    return skippedArtifact(artifact, absolutePath, "not a regular file");
  }

  const content = readBoundedArtifactText(
    realPath,
    stat.size,
    limits,
    limits.totalArtifactBytes - budget.usedBytes,
  );

  if (content.status === "present") {
    budget.usedBytes += content.excerptBytes;
  }

  return {
    ...artifact,
    absolutePath,
    status: content.status,
    excerpt: content.excerpt,
    excerptBytes: content.excerptBytes,
    omissionReason: content.omissionReason,
  };
}

export function buildArtifactInventory(
  state,
  {
    cwd = process.cwd(),
    currentArtifacts = [],
    limits: providedLimits = {},
  } = {},
) {
  const workspaceRoot = path.resolve(cwd);
  const limits = normalizeLimits(providedLimits);
  const budget = { usedBytes: 0 };

  return artifactCandidates(state, {
    cwd: workspaceRoot,
    currentArtifacts,
  }).map((artifact) =>
    inspectArtifact(artifact, workspaceRoot, limits, budget),
  );
}

function formatList(values) {
  return values?.length > 0 ? values.join(", ") : "none";
}

function formatImplementationStatus(state) {
  if (state?.implementationStatus?.completedTaskIds?.length > 0) {
    return state.implementationStatus.completedTaskIds.join(", ");
  }

  if (state?.implementationStatus) {
    return JSON.stringify(state.implementationStatus);
  }

  return state?.artifacts?.implementationStatus
    ? `artifact at ${state.artifacts.implementationStatus}`
    : "not recorded";
}

function inferNextExpectedAction(state, { boundary, targetPhase }) {
  if (state?.phaseStatus === HARDEN_APPROVAL_STATUS) {
    return "Wait for hardened spec approval.";
  }

  if (targetPhase === "complete" || state?.currentPhase === "complete") {
    return "Complete the RalphWorks workflow.";
  }

  if (boundary === "task" && targetPhase === "tdd_implement") {
    return "Continue TDD implementation with the next incomplete task.";
  }

  if (boundary === "review_loopback" && targetPhase === "tdd_implement") {
    return "Launch tdd_implement phase prompt with review loopback context.";
  }

  if (targetPhase) {
    return `Launch ${targetPhase} phase prompt.`;
  }

  return "Await the next RalphWorks controller action.";
}

function formatGateResult(result) {
  const status = result.passed ? "passed" : "failed";
  const required = result.required === false ? "optional" : "required";
  return `${result.name}: ${status} (${required}, \`${result.command}\`, code ${result.code})`;
}

function appendArtifactInventory(lines, inventory) {
  lines.push("", "## Artifact Inventory");

  if (inventory.length === 0) {
    lines.push("- none recorded");
    return;
  }

  for (const artifact of inventory) {
    const label = artifact.phaseLabel ? ` (${artifact.phaseLabel})` : "";
    const omission = artifact.omissionReason
      ? `; omitted: ${artifact.omissionReason}`
      : "";
    lines.push(
      `- ${artifact.key}${label}: ${artifact.path} [${artifact.status}]${omission}`,
    );

    if (artifact.excerpt !== undefined) {
      lines.push("  ```text artifact excerpt (untrusted)");
      lines.push(artifact.excerpt);
      lines.push("  ```");
    }
  }
}

export function buildSessionHandoffSummary(
  state,
  {
    cwd = process.cwd(),
    boundary,
    handoffId,
    reason,
    sourcePhase,
    targetPhase,
    currentArtifacts,
    limits,
    nextAction,
  } = {},
) {
  const pendingHandoff = state?.pendingHandoff ?? {};
  const effectiveBoundary =
    boundary ?? pendingHandoff.boundary ?? "unspecified";
  const effectiveReason =
    reason ?? pendingHandoff.reason ?? "workflow boundary";
  const effectiveTargetPhase = targetPhase ?? pendingHandoff.targetPhase;
  const inventory = buildArtifactInventory(state, {
    cwd,
    currentArtifacts,
    limits,
  });

  const lines = [
    "# RalphWorks Session Handoff",
    "",
    "## Workflow State",
    `Extension: ${state?.extensionName ?? RALPH_WORKS_NAME}`,
    `Feature: ${state?.feature ?? "unspecified"}`,
  ];

  if (state?.promptText) {
    lines.push(`Prompt: ${state.promptText}`);
  }

  lines.push(
    `Boundary: ${effectiveBoundary}`,
    `Handoff id: ${handoffId ?? pendingHandoff.id ?? "unspecified"}`,
    `Reason: ${effectiveReason}`,
    `Source phase: ${sourcePhase ?? pendingHandoff.sourcePhase ?? state?.currentPhase ?? "unspecified"}`,
    `Target phase: ${effectiveTargetPhase ?? "unspecified"}`,
    `Handoff status: ${pendingHandoff.status ?? "unspecified"}`,
    `Current phase: ${state?.currentPhase ?? "unspecified"}`,
    `Phase status: ${state?.phaseStatus ?? "unspecified"}`,
    `Pipeline status: ${state?.pipelineStatus ?? "unspecified"}`,
    `Completed phases: ${formatList(state?.completedPhases ?? [])}`,
    `Loopbacks: ${state?.loopbackCount ?? 0}`,
    `TDD completed tasks: ${state?.tddCompletedTasks ?? 0}`,
    `Implementation status: ${formatImplementationStatus(state)}`,
  );

  if (effectiveBoundary === "review_loopback") {
    lines.push(`Review loopback reason: ${effectiveReason}`);
  }

  lines.push("", "## Transition History");
  if ((state?.transitionHistory ?? []).length === 0) {
    lines.push("- none recorded");
  } else {
    for (const entry of state.transitionHistory) {
      const from = entry.from ?? "start";
      lines.push(`- ${from} -> ${entry.to} (${entry.reason})`);
    }
  }

  lines.push("", "## Latest Gate Results");
  if ((state?.gateResults ?? []).length === 0) {
    lines.push("- none recorded");
  } else {
    for (const result of state.gateResults) {
      lines.push(`- ${formatGateResult(result)}`);
    }
  }

  if (state?.phaseStatus === HARDEN_APPROVAL_STATUS) {
    lines.push(
      "",
      "## Action Required",
      "The workflow is paused at harden_spec and must not continue until the user explicitly approves the hardened spec.",
      "- Run `/ralph-works approve` to continue to implementation planning.",
      "- Run `/ralph-works approve --render-html` to render HTML before implementation planning.",
    );
  }

  appendArtifactInventory(lines, inventory);

  lines.push(
    "",
    "## Next Expected Action",
    `Next expected action: ${
      nextAction ??
      inferNextExpectedAction(state, {
        boundary: effectiveBoundary,
        targetPhase: effectiveTargetPhase,
      })
    }`,
  );

  return lines.join("\n");
}
