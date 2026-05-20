import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CUSTOM_TYPE } from "./config";
import type { PipelineState } from "./domain";

/**
 * Return the latest ralph-works state by walking the whole branch root-to-tip.
 * Pi sessions can contain multiple custom entries after reloads and compaction;
 * the last matching entry is the controller's source of truth.
 */
export function getState(ctx: ExtensionContext): PipelineState | null {
  let latest = null;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === CUSTOM_TYPE && entry.data) {
      latest = entry.data as PipelineState;
    }
  }
  return latest;
}

/**
 * Persist state as an append-only custom entry. Callers should pass copied state
 * objects so later mutations cannot accidentally rewrite previously loaded data.
 */
export function saveState(pi: ExtensionAPI, state: PipelineState): void {
  pi.appendEntry(CUSTOM_TYPE, state);
}
