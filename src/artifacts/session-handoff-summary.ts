import {
  closeSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
  statSync,
} from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

import { HARDEN_APPROVAL_STATUS } from "../state/phase-completion.ts";
import { getPhaseDefinition, RALPH_WORKS_NAME } from "../state/phase-state.ts";
import type {
  GateResult,
  ImplementationStatus,
  PhaseDefinition,
  SessionHandoffDescriptor,
  TransitionRecord,
  WorkflowState,
} from "../state/phase-types.ts";

export interface ArtifactInventoryLimits {
  perArtifactBytes: number;
  perArtifactLines: number;
  totalArtifactBytes: number;
}

export const DEFAULT_ARTIFACT_INVENTORY_LIMITS = {
  perArtifactBytes: 8 * 1024,
  perArtifactLines: 100,
  totalArtifactBytes: 32 * 1024,
} satisfies ArtifactInventoryLimits;

type ImplementationStatusSummary =
  | Partial<ImplementationStatus>
  | Record<string, unknown>;

export interface HandoffSummaryState
  extends Partial<
    Omit<
      WorkflowState,
      | "artifacts"
      | "completedPhases"
      | "implementationStatus"
      | "pendingHandoff"
    >
  > {
  artifacts?: Record<string, string>;
  completedPhases?: string[];
  implementationStatus?: ImplementationStatusSummary;
  pendingHandoff?: Partial<SessionHandoffDescriptor>;
}

export interface ArtifactCandidate {
  key: string;
  path: string;
  phaseId?: string;
  phaseLabel?: string;
  source?: string;
}

interface ArtifactCandidateInput {
  key?: string;
  path?: string;
  phaseId?: string;
  phaseLabel?: string;
  source?: string;
}

export type ExplicitArtifact = string | ArtifactCandidateInput;

export type ArtifactInventoryStatus = "missing" | "present" | "skipped";

export interface ArtifactInventoryRecord extends ArtifactCandidate {
  absolutePath: string;
  status: ArtifactInventoryStatus;
  excerpt?: string;
  excerptBytes?: number;
  omissionReason?: string;
}

interface ArtifactCandidateOptions {
  cwd?: string;
  currentArtifacts?: ExplicitArtifact[];
}

interface ArtifactInventoryBudget {
  usedBytes: number;
}

interface DecodedTextPrefix {
  text: string;
  decodedBytes: number;
}

interface LineLimitResult {
  text: string;
  truncated: boolean;
}

type ArtifactTextReadResult =
  | {
      status: "present";
      excerpt: string;
      excerptBytes: number;
      omissionReason?: string;
    }
  | {
      status: "skipped";
      omissionReason: string;
    };

export interface BuildArtifactInventoryOptions {
  cwd?: string;
  currentArtifacts?: ExplicitArtifact[];
  limits?: Partial<ArtifactInventoryLimits>;
}

export interface BuildSessionHandoffSummaryOptions
  extends BuildArtifactInventoryOptions {
  boundary?: string;
  handoffId?: string;
  reason?: string;
  sourcePhase?: string;
  targetPhase?: string;
  nextAction?: string;
}

function normalizeLimits(
  limits: Partial<ArtifactInventoryLimits> = {},
): ArtifactInventoryLimits {
  return {
    ...DEFAULT_ARTIFACT_INVENTORY_LIMITS,
    ...limits,
  };
}

function phaseDefinitions(
  state: HandoffSummaryState | undefined,
): PhaseDefinition[] {
  return state?.phases ?? [];
}

function phaseDefinitionFor(
  state: HandoffSummaryState | undefined,
  phaseId: string | undefined,
): PhaseDefinition | undefined {
  return (
    phaseDefinitions(state).find((phase) => phase.id === phaseId) ??
    getPhaseDefinition(phaseId)
  );
}

function phaseDefinitionForArtifactKey(
  state: HandoffSummaryState | undefined,
  artifactKey: string,
): PhaseDefinition | undefined {
  const matchingPhase = phaseDefinitions(state).find(
    (phase) => phase.artifactKey === artifactKey,
  );
  return matchingPhase ?? getPhaseDefinition(undefined);
}

function hasOwn(object: object | null | undefined, key: PropertyKey): boolean {
  return Object.hasOwn(object ?? {}, key);
}

function addArtifact(
  artifacts: ArtifactCandidate[],
  seen: Set<string>,
  artifact: ArtifactCandidateInput,
): void {
  if (!artifact.key || !artifact.path) {
    return;
  }

  const dedupeKey = `${artifact.key}\0${artifact.path}`;
  if (seen.has(dedupeKey)) {
    return;
  }

  seen.add(dedupeKey);
  artifacts.push({
    ...artifact,
    key: artifact.key,
    path: artifact.path,
  });
}

function normalizeExplicitArtifact(
  artifact: ExplicitArtifact,
  index: number,
): ArtifactCandidateInput {
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

function artifactCandidates(
  state: HandoffSummaryState | undefined,
  { cwd, currentArtifacts = [] }: ArtifactCandidateOptions = {},
): ArtifactCandidate[] {
  const artifacts: ArtifactCandidate[] = [];
  const seen = new Set<string>();
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
      : phaseDefinitionForArtifactKey(state, artifact.key ?? "");
    addArtifact(artifacts, seen, {
      ...artifact,
      phaseId: artifact.phaseId ?? phase?.id,
      phaseLabel: artifact.phaseLabel ?? phase?.label,
    });
  });

  return artifacts;
}

function resolveArtifactPath(cwd: string, artifactPath: string): string {
  return path.resolve(cwd, artifactPath);
}

function isInsideWorkspace(
  workspaceRoot: string,
  absolutePath: string,
): boolean {
  const relativePath = path.relative(workspaceRoot, absolutePath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

function artifactPathExists(
  cwd: string = process.cwd(),
  artifactPath: string,
): boolean {
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

function skippedArtifact(
  artifact: ArtifactCandidate,
  absolutePath: string,
  reason: string,
): ArtifactInventoryRecord {
  return {
    ...artifact,
    absolutePath,
    status: "skipped",
    omissionReason: reason,
  };
}

function missingArtifact(
  artifact: ArtifactCandidate,
  absolutePath: string,
): ArtifactInventoryRecord {
  return {
    ...artifact,
    absolutePath,
    status: "missing",
    omissionReason: "file does not exist",
  };
}

function decodeUtf8Prefix(buffer: Buffer): DecodedTextPrefix | undefined {
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

function limitLines(text: string, perArtifactLines: number): LineLimitResult {
  const lines = text.split("\n");
  if (lines.length <= perArtifactLines) {
    return { text, truncated: false };
  }

  return {
    text: lines.slice(0, perArtifactLines).join("\n"),
    truncated: true,
  };
}

function readBoundedArtifactText(
  filePath: string,
  fileSize: number,
  limits: ArtifactInventoryLimits,
  remainingBudget: number,
): ArtifactTextReadResult {
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

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function inspectArtifact(
  artifact: ArtifactCandidate,
  workspaceRoot: string,
  limits: ArtifactInventoryLimits,
  budget: ArtifactInventoryBudget,
): ArtifactInventoryRecord {
  const absolutePath = resolveArtifactPath(workspaceRoot, artifact.path);
  if (!isInsideWorkspace(workspaceRoot, absolutePath)) {
    return skippedArtifact(artifact, absolutePath, "outside workspace");
  }

  let lstat: Stats;
  try {
    lstat = lstatSync(absolutePath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return missingArtifact(artifact, absolutePath);
    }

    return skippedArtifact(
      artifact,
      absolutePath,
      `unreadable: ${errorMessage(error)}`,
    );
  }

  let realPath: string;
  try {
    realPath = realpathSync(absolutePath);
  } catch (error) {
    return skippedArtifact(
      artifact,
      absolutePath,
      `unreadable: ${errorMessage(error)}`,
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

  let stat: Stats;
  try {
    stat = statSync(realPath);
  } catch (error) {
    return skippedArtifact(
      artifact,
      absolutePath,
      `unreadable: ${errorMessage(error)}`,
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
    excerpt: content.status === "present" ? content.excerpt : undefined,
    excerptBytes:
      content.status === "present" ? content.excerptBytes : undefined,
    omissionReason: content.omissionReason,
  };
}

export function buildArtifactInventory(
  state?: HandoffSummaryState,
  {
    cwd = process.cwd(),
    currentArtifacts = [],
    limits: providedLimits = {},
  }: BuildArtifactInventoryOptions = {},
): ArtifactInventoryRecord[] {
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

function formatList(values: readonly unknown[] | undefined): string {
  return values && values.length > 0 ? values.join(", ") : "none";
}

function formatImplementationStatus(
  state: HandoffSummaryState | undefined,
): string {
  const completedTaskIds = state?.implementationStatus?.completedTaskIds;
  if (Array.isArray(completedTaskIds) && completedTaskIds.length) {
    return completedTaskIds.join(", ");
  }

  if (state?.implementationStatus) {
    return JSON.stringify(state.implementationStatus);
  }

  return state?.artifacts?.implementationStatus
    ? `artifact at ${state.artifacts.implementationStatus}`
    : "not recorded";
}

function inferNextExpectedAction(
  state: HandoffSummaryState | undefined,
  { boundary, targetPhase }: { boundary?: string; targetPhase?: string },
): string {
  if (state?.phaseStatus === HARDEN_APPROVAL_STATUS) {
    return "Wait for hardened spec approval.";
  }

  if (targetPhase === "complete" || state?.currentPhase === "complete") {
    return "Complete the RalphWorks workflow.";
  }

  if (boundary === "task" && targetPhase === "tdd_implement") {
    return "Inspect task list and implementation status artifacts, then continue TDD implementation with the next incomplete task.";
  }

  if (boundary === "review_loopback" && targetPhase === "tdd_implement") {
    return "Launch tdd_implement phase prompt with review loopback context.";
  }

  if (targetPhase) {
    return `Launch ${targetPhase} phase prompt.`;
  }

  return "Await the next RalphWorks controller action.";
}

function formatGateResult(result: GateResult): string {
  const status = result.passed ? "passed" : "failed";
  const required = result.required === false ? "optional" : "required";
  return `${result.name}: ${status} (${required}, \`${result.command}\`, code ${result.code})`;
}

function appendArtifactInventory(
  lines: string[],
  inventory: ArtifactInventoryRecord[],
): void {
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
  state?: HandoffSummaryState,
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
  }: BuildSessionHandoffSummaryOptions = {},
): string {
  const pendingHandoff: Partial<SessionHandoffDescriptor> =
    state?.pendingHandoff ?? {};
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
    `Completed phases: ${formatList(state?.completedPhases)}`,
    `Loopbacks: ${state?.loopbackCount ?? 0}`,
    `TDD completed tasks: ${state?.tddCompletedTasks ?? 0}`,
    `Implementation status: ${formatImplementationStatus(state)}`,
  );

  if (effectiveBoundary === "review_loopback") {
    lines.push(`Review loopback reason: ${effectiveReason}`);
  }

  const transitionHistory: TransitionRecord[] = state?.transitionHistory ?? [];
  lines.push("", "## Transition History");
  if (transitionHistory.length === 0) {
    lines.push("- none recorded");
  } else {
    for (const entry of transitionHistory) {
      const from = entry.from ?? "start";
      lines.push(`- ${from} -> ${entry.to} (${entry.reason})`);
    }
  }

  const gateResults = state?.gateResults ?? [];
  lines.push("", "## Latest Gate Results");
  if (gateResults.length === 0) {
    lines.push("- none recorded");
  } else {
    for (const result of gateResults) {
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
