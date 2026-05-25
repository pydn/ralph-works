import {
  type GateConfig,
  loadGateConfig,
} from "../gates/gate-config-loader.ts";
import {
  isGateConfig,
  validateGateConfig,
} from "../gates/gate-config-validator.ts";
import type { GateResult } from "../gates/gate-result.ts";
import { runConfiguredGates } from "../gates/gate-runner.ts";
import type { RalphWorksContext, RalphWorksPiApi } from "./pi-harness-types.ts";

export async function loadValidGateConfig(
  ctx: RalphWorksContext,
): Promise<GateConfig> {
  const config = await loadGateConfig(ctx.cwd);
  const errors = validateGateConfig(config);
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
  if (!isGateConfig(config)) {
    throw new Error("gate.config.json must contain a valid gate config.");
  }
  return config;
}

export async function runPiConfiguredGates(
  pi: RalphWorksPiApi,
  ctx: RalphWorksContext,
): Promise<GateResult[]> {
  const config = await loadValidGateConfig(ctx);
  return runConfiguredGates(config, {
    executor: (gate) =>
      pi.exec("sh", ["-lc", gate.command], { signal: ctx.signal }),
    signal: ctx.signal,
  });
}
