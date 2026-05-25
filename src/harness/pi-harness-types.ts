import type { GateExecutionResult } from "../gates/gate-result.ts";
import type { WorkflowState } from "../state/phase-types.ts";

export type NotificationLevel = "info" | "warning" | "error" | string;

export interface RalphWorksUi {
  setStatus?: (key: string, value: string | undefined) => void;
  setWidget?: (key: string, value: string[]) => void;
  notify?: (message: string, level?: NotificationLevel) => void;
}

export interface PersistedSessionEntry {
  type?: string;
  customType?: string;
  data?: unknown;
  content?: unknown;
  display?: boolean;
  details?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface RalphWorksSessionManager {
  getEntries?: () => PersistedSessionEntry[];
  getSessionFile?: () => string | undefined;
  appendCustomEntry?: (customType: string, data: WorkflowState) => unknown;
  appendEntry?: (customType: string, data: WorkflowState) => unknown;
  appendCustomMessageEntry?: (
    customType: string,
    content: string,
    display: boolean,
    details?: Record<string, unknown>,
  ) => unknown;
}

export interface RalphWorksNewSessionOptions {
  parentSession?: string;
  setup: (sessionManager: RalphWorksSessionManager) => void | Promise<void>;
  withSession: (ctx: RalphWorksContext) => void | Promise<void>;
}

export interface RalphWorksNewSessionResult {
  cancelled?: boolean;
  [key: string]: unknown;
}

export interface RalphWorksModelRegistry {
  find?: (provider: string, id: string) => unknown;
}

export interface UserMessageOptions {
  deliverAs?: string;
  [key: string]: unknown;
}

export interface RalphWorksContext {
  cwd: string;
  signal?: AbortSignal;
  hasUI?: boolean;
  ui?: RalphWorksUi;
  sessionManager?: RalphWorksSessionManager;
  modelRegistry?: RalphWorksModelRegistry;
  newSession?: (
    options: RalphWorksNewSessionOptions,
  ) => RalphWorksNewSessionResult | Promise<RalphWorksNewSessionResult>;
  sendUserMessage?: (
    content: string,
    options?: UserMessageOptions,
  ) => unknown | Promise<unknown>;
  [key: string]: unknown;
}

export interface RalphWorksCommandCompletion {
  value: string;
  label: string;
}

export interface RalphWorksCommandDefinition {
  description: string;
  getArgumentCompletions?: (prefix: string) => RalphWorksCommandCompletion[];
  handler: (args: string, ctx: RalphWorksContext) => void | Promise<void>;
}

export interface RalphWorksToolResult {
  content: { type: "text"; text: string }[];
  details: { state: WorkflowState | undefined };
}

export interface RalphWorksToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: RalphWorksContext,
  ) => RalphWorksToolResult | Promise<RalphWorksToolResult>;
}

export type RalphWorksEventHandler = (
  event: unknown,
  ctx: RalphWorksContext,
) => unknown | Promise<unknown>;

export interface RalphWorksPiApi {
  on: (eventName: string, handler: RalphWorksEventHandler) => void;
  registerCommand: (
    name: string,
    definition: RalphWorksCommandDefinition,
  ) => void;
  registerTool: (definition: RalphWorksToolDefinition) => void;
  appendEntry?: (customType: string, data: WorkflowState) => unknown;
  sendUserMessage?: (
    content: string,
    options?: UserMessageOptions,
  ) => unknown | Promise<unknown>;
  setModel?: (
    model: unknown,
  ) => boolean | Promise<boolean | undefined> | undefined;
  exec: (
    command: string,
    args: readonly string[],
    options?: { signal?: AbortSignal },
  ) => GateExecutionResult | Promise<GateExecutionResult>;
}
