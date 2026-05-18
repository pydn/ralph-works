import * as fs from "node:fs";
import * as path from "node:path";
import { RENDER_HTML_ALIASES, YOLO_FLAG } from "./config";
import type {
  ModelSwitchEvent,
  ModelThinkingLevel,
  PipelineState,
  RalphModelPlan,
  RalphModelSelector,
  RalphModelSelectorSource,
} from "./domain";

const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const THINKING_LEVEL_SET = new Set<string>(THINKING_LEVELS);
const PROVIDER_RE = /^[A-Za-z0-9._-]{1,64}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
const ANSI_RE = /\u001b\[[0-9;]*m/;
const CONTROL_GLOBAL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
const ANSI_GLOBAL_RE = /\u001b\[[0-9;]*m/g;
const AUTHORIZATION_BEARER_RE = /\bAuthorization\s*:\s*Bearer\s+[^\s,;]+/gi;
const BEARER_RE = /\bBearer\s+[^\s,;]+/gi;
const SECRET_KEY_VALUE_RE = /\b(api[-_ ]?key|authorization|token)\b\s*[:=]\s*[^\s,;]+/gi;
const MAX_MODEL_ID_LENGTH = 200;
const MAX_HISTORY_EVENTS = 20;

export interface ModelSelectorParseOk {
  ok: true;
  selector: RalphModelSelector;
}

export interface ModelSelectorParseError {
  ok: false;
  error: string;
}

export type ModelSelectorParseResult = ModelSelectorParseOk | ModelSelectorParseError;

export interface ParsedRalphFlags {
  args: string[];
  renderHtml: boolean;
  yolo: boolean;
  model?: string;
  models?: string;
  trustModelPlan: boolean;
  allowWeakModel: boolean;
  errors: string[];
}

export interface BuildModelPlanResult {
  plan?: RalphModelPlan;
  errors: string[];
  warnings: string[];
}

function hasUnsafeText(value: string): boolean {
  return CONTROL_RE.test(value) || ANSI_RE.test(value);
}

function normalizeSource(source: RalphModelSelectorSource | undefined): RalphModelSelectorSource {
  return source ?? "cli";
}

function sanitizeDisplayText(value: string, maxLength: number): string {
  return value.normalize("NFC").replace(ANSI_GLOBAL_RE, "").replace(CONTROL_GLOBAL_RE, " ").trim().slice(0, maxLength);
}

function sanitizeReason(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  return sanitizeDisplayText(reason, 300)
    .replace(AUTHORIZATION_BEARER_RE, "Authorization [REDACTED]")
    .replace(BEARER_RE, "Bearer [REDACTED]")
    .replace(SECRET_KEY_VALUE_RE, "$1 [REDACTED]");
}

export function parseModelSelector(
  rawValue: string,
  source?: RalphModelSelectorSource,
  explicit = true,
): ModelSelectorParseResult {
  const value = rawValue.normalize("NFC").trim();
  if (!value) return { ok: false, error: "Model selector is empty" };
  if (hasUnsafeText(value)) return { ok: false, error: "Model selector contains control characters" };

  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return { ok: false, error: "Model selector must be provider/model" };

  const provider = value.slice(0, slash);
  let model = value.slice(slash + 1);
  if (!PROVIDER_RE.test(provider)) return { ok: false, error: `Invalid provider id: ${provider}` };
  if (!model) return { ok: false, error: "Model id is empty" };
  if (model.length > MAX_MODEL_ID_LENGTH) return { ok: false, error: "Model id exceeds 200 characters" };
  if (hasUnsafeText(model)) return { ok: false, error: "Model id contains control characters" };

  let thinkingLevel: ModelThinkingLevel | undefined;
  const colon = model.lastIndexOf(":");
  if (colon > 0 && colon < model.length - 1) {
    const suffix = model.slice(colon + 1);
    if (THINKING_LEVEL_SET.has(suffix)) {
      thinkingLevel = suffix as ModelThinkingLevel;
      model = model.slice(0, colon);
    } else if (/^[A-Za-z]+$/.test(suffix)) {
      return { ok: false, error: `Unsupported thinking level: ${suffix}` };
    }
  }

  return {
    ok: true,
    selector: {
      provider,
      model,
      thinkingLevel,
      source: normalizeSource(source),
      explicit,
    },
  };
}

export function formatModelSelector(selector: RalphModelSelector | undefined): string {
  if (!selector) return "(current model)";
  const thinking = selector.thinkingLevel ? `:${selector.thinkingLevel}` : "";
  return `${selector.provider}/${selector.model}${thinking}`;
}

export function parseRalphFlags(args: string[]): ParsedRalphFlags {
  const filtered: string[] = [];
  const errors: string[] = [];
  let model: string | undefined;
  let models: string | undefined;
  let renderHtml = false;
  let yolo = false;
  let trustModelPlan = false;
  let allowWeakModel = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (RENDER_HTML_ALIASES.has(arg)) {
      renderHtml = true;
    } else if (arg === YOLO_FLAG) {
      yolo = true;
    } else if (arg === "--trust-model-plan") {
      trustModelPlan = true;
    } else if (arg === "--allow-weak-model") {
      allowWeakModel = true;
    } else if (arg === "--model") {
      const value = args[i + 1];
      if (!value) errors.push("--model requires provider/model[:thinking]");
      else {
        model = value;
        i += 1;
      }
    } else if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length);
    } else if (arg === "--models") {
      const value = args[i + 1];
      if (!value) errors.push("--models requires phase=provider/model[:thinking],...");
      else {
        models = value;
        i += 1;
      }
    } else if (arg.startsWith("--models=")) {
      models = arg.slice("--models=".length);
    } else {
      filtered.push(arg);
    }
  }

  return { args: filtered, renderHtml, yolo, model, models, trustModelPlan, allowWeakModel, errors };
}

function parsePhaseSelectors(
  rawMap: string,
  validPhases: string[],
): { phases: Record<string, RalphModelSelector>; errors: string[] } {
  const phases: Record<string, RalphModelSelector> = {};
  const errors: string[] = [];
  const valid = new Set(validPhases);
  for (const rawPair of rawMap.split(",")) {
    const pair = rawPair.trim();
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq <= 0 || eq === pair.length - 1) {
      errors.push(`Invalid --models entry: ${pair}`);
      continue;
    }
    const phase = pair.slice(0, eq).trim();
    if (!valid.has(phase)) {
      errors.push(`Unknown model phase: ${phase}`);
      continue;
    }
    const parsed = parseModelSelector(pair.slice(eq + 1).trim(), "cli", true);
    if (!parsed.ok) errors.push(`${phase}: ${parsed.error}`);
    else phases[phase] = parsed.selector;
  }
  return { phases, errors };
}

function coerceConfigSelector(value: unknown, source: RalphModelSelectorSource): ModelSelectorParseResult {
  if (!value || typeof value !== "object") return { ok: false, error: "Config selector must be an object" };
  const raw = value as { provider?: unknown; model?: unknown; thinkingLevel?: unknown };
  if (typeof raw.provider !== "string" || typeof raw.model !== "string") {
    return { ok: false, error: "Config selector requires provider and model" };
  }
  const thinking = typeof raw.thinkingLevel === "string" ? `:${raw.thinkingLevel}` : "";
  return parseModelSelector(`${raw.provider}/${raw.model}${thinking}`, source, false);
}

function loadTrustedWorkspaceConfig(workDir: string, validPhases: string[]): BuildModelPlanResult {
  const configPath = path.join(workDir, ".ralph", "model-plan.json");
  if (!fs.existsSync(configPath)) return { errors: [], warnings: [] };

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch (error) {
    return { errors: [`Invalid .ralph/model-plan.json: ${String(error)}`], warnings: [] };
  }

  const config = parsedJson as {
    default?: unknown;
    phases?: Record<string, unknown>;
    restoreOriginalOnComplete?: unknown;
    strict?: unknown;
  };
  const errors: string[] = [];
  const plan: RalphModelPlan = {
    phases: {},
    restoreOriginalOnComplete:
      typeof config.restoreOriginalOnComplete === "boolean" ? config.restoreOriginalOnComplete : true,
    strict: typeof config.strict === "boolean" ? config.strict : true,
    trustApproved: true,
    trustSource: "cli-flag",
  };

  if (config.default) {
    const parsed = coerceConfigSelector(config.default, "workspace-config");
    if (!parsed.ok) errors.push(`default: ${parsed.error}`);
    else plan.default = parsed.selector;
  }

  const valid = new Set(validPhases);
  if (config.phases && typeof config.phases === "object") {
    for (const [phase, selector] of Object.entries(config.phases)) {
      if (!valid.has(phase)) {
        errors.push(`Unknown config model phase: ${phase}`);
        continue;
      }
      const parsed = coerceConfigSelector(selector, "workspace-config");
      if (!parsed.ok) errors.push(`${phase}: ${parsed.error}`);
      else plan.phases = { ...(plan.phases ?? {}), [phase]: parsed.selector };
    }
  }

  const hasPlan = Boolean(plan.default || Object.keys(plan.phases ?? {}).length > 0);
  return { plan: hasPlan ? plan : undefined, errors, warnings: [] };
}

export function buildModelPlanFromOptions(
  options: ParsedRalphFlags,
  validPhases: string[],
  workDir: string,
  existing?: RalphModelPlan,
): BuildModelPlanResult {
  const errors = [...options.errors];
  const warnings: string[] = [];
  let plan: RalphModelPlan | undefined = existing ? { ...existing, phases: { ...(existing.phases ?? {}) } } : undefined;

  const configPath = path.join(workDir, ".ralph", "model-plan.json");
  if (options.trustModelPlan) {
    const trusted = loadTrustedWorkspaceConfig(workDir, validPhases);
    errors.push(...trusted.errors);
    warnings.push(...trusted.warnings);
    if (trusted.plan) plan = { ...trusted.plan, phases: { ...(trusted.plan.phases ?? {}) } };
  } else if (!options.model && !options.models && fs.existsSync(configPath)) {
    warnings.push("Workspace model plan ignored because --trust-model-plan was not provided.");
  }

  if (options.model) {
    const parsed = parseModelSelector(options.model, "cli", true);
    if (!parsed.ok) errors.push(parsed.error);
    else {
      plan = {
        ...(plan ?? {}),
        phases: { ...(plan?.phases ?? {}) },
        default: parsed.selector,
        strict: plan?.strict ?? true,
        restoreOriginalOnComplete: plan?.restoreOriginalOnComplete ?? true,
      };
    }
  }

  if (options.models) {
    const parsedMap = parsePhaseSelectors(options.models, validPhases);
    errors.push(...parsedMap.errors);
    if (Object.keys(parsedMap.phases).length > 0) {
      plan = {
        ...(plan ?? {}),
        phases: { ...(plan?.phases ?? {}), ...parsedMap.phases },
        strict: plan?.strict ?? true,
        restoreOriginalOnComplete: plan?.restoreOriginalOnComplete ?? true,
      };
    }
  }

  if (plan) {
    plan.strict = plan.strict ?? true;
    plan.restoreOriginalOnComplete = plan.restoreOriginalOnComplete ?? true;
    plan.allowWeakModel = options.allowWeakModel || plan.allowWeakModel || false;
    plan.trustApproved = plan.trustApproved ?? false;
  }

  return { plan, errors, warnings };
}

export function resolvePhaseModelSelector(
  plan: RalphModelPlan | undefined,
  phaseKey: string,
): RalphModelSelector | undefined {
  return plan?.phases?.[phaseKey] ?? plan?.default;
}

export function selectorFromCurrentModel(
  model: unknown,
  thinkingLevel?: ModelThinkingLevel,
): RalphModelSelector | undefined {
  if (!model || typeof model !== "object") return undefined;
  const m = model as { provider?: unknown; id?: unknown; name?: unknown };
  if (typeof m.provider !== "string" || typeof m.id !== "string") return undefined;
  return {
    provider: m.provider,
    model: m.id,
    displayName: typeof m.name === "string" ? sanitizeDisplayText(m.name, 128) : undefined,
    thinkingLevel,
    source: "current",
    explicit: false,
  };
}

export function appendModelSwitchHistory(state: PipelineState, event: ModelSwitchEvent): PipelineState {
  const modelSwitchHistory = [...(state.modelSwitchHistory ?? []), event].slice(-MAX_HISTORY_EVENTS);
  return { ...state, modelSwitchHistory };
}

export function createModelSwitchEvent(
  event: ModelSwitchEvent["event"],
  selector: RalphModelSelector | undefined,
  result: ModelSwitchEvent["result"],
  options?: { phaseKey?: string; reason?: string; nonce?: string },
): ModelSwitchEvent {
  return {
    event,
    phaseKey: options?.phaseKey,
    provider: selector?.provider,
    model: selector?.model,
    thinkingLevel: selector?.thinkingLevel,
    source: selector?.source,
    result,
    reason: sanitizeReason(options?.reason),
    nonce: options?.nonce,
    occurredAt: Date.now(),
  };
}

export function activeModelMatchesSelector(model: unknown, selector: RalphModelSelector | undefined): boolean {
  if (!selector || !model || typeof model !== "object") return false;
  const m = model as { provider?: unknown; id?: unknown };
  return m.provider === selector.provider && m.id === selector.model;
}

export function selectedModelIds(plan: RalphModelPlan | undefined): RalphModelSelector[] {
  if (!plan) return [];
  const selectors: RalphModelSelector[] = [];
  if (plan.default) selectors.push(plan.default);
  for (const selector of Object.values(plan.phases ?? {})) {
    if (selector) selectors.push(selector);
  }
  return selectors;
}
