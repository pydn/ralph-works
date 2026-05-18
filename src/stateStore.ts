import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CUSTOM_TYPE } from "./config";
import type { PipelineState } from "./domain";

export function getState(ctx: ExtensionContext): PipelineState | null {
  let latest = null;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === CUSTOM_TYPE && entry.data) {
      latest = entry.data as PipelineState;
    }
  }
  return latest;
}

export function saveState(pi: ExtensionAPI, state: PipelineState): void {
  pi.appendEntry(CUSTOM_TYPE, state);
}
