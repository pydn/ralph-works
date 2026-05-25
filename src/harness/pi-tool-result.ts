import type { WorkflowState } from "../state/phase-types.ts";
import type { RalphWorksToolResult } from "./pi-harness-types.ts";

export function createToolResult(
  text: string,
  state: WorkflowState | undefined,
): RalphWorksToolResult {
  return {
    content: [{ type: "text", text }],
    details: { state },
  };
}
