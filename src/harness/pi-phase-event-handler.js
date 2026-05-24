import { advancePhase, transitionToPhase } from "../state/phase-transitions.js";

export function applyPhaseCommand(state, command, args = []) {
  if (command === "next") {
    return advancePhase(state, {
      renderHtml: args.includes("--render-html"),
      reason: "command:next",
    });
  }

  if (command === "loopback") {
    return transitionToPhase(state, "tdd_implement", {
      reason: args.join(" ") || "review-critical-bugs",
    });
  }

  if (command === "approve") {
    return transitionToPhase(state, "complete", {
      reason: "looks good to me",
    });
  }

  throw new Error(`Unknown ralph-works phase command: ${command}`);
}
