import { buildCompactionSummary } from "../artifacts/compaction-summary.js";

export function triggerRalphWorksCompaction(
  ctx,
  state,
  boundary,
  reason,
  { onComplete, onError } = {},
) {
  if (!ctx.compact) {
    return false;
  }

  const summary = buildCompactionSummary(state, { boundary, reason });
  ctx.compact({
    customInstructions: summary,
    onComplete,
    onError: (error) => {
      ctx.ui?.notify?.(`ralph-works compaction failed: ${error.message}`, "error");
      onError?.(error);
    },
  });
  return true;
}
