import { buildCompactionSummary } from "../artifacts/compaction-summary.js";

export function triggerRalphWorksCompaction(ctx, state, boundary, reason) {
  const summary = buildCompactionSummary(state, { boundary, reason });
  ctx.compact?.({
    customInstructions: summary,
    onError: (error) => {
      ctx.ui?.notify?.(`ralph-works compaction failed: ${error.message}`, "error");
    },
  });
}
