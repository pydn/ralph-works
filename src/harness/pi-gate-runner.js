import { loadGateConfig } from "../gates/gate-config-loader.js";
import { validateGateConfig } from "../gates/gate-config-validator.js";
import { runConfiguredGates } from "../gates/gate-runner.js";

export async function loadValidGateConfig(ctx) {
  const config = await loadGateConfig(ctx.cwd);
  const errors = validateGateConfig(config);
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
  return config;
}

export async function runPiConfiguredGates(pi, ctx) {
  const config = await loadValidGateConfig(ctx);
  return runConfiguredGates(config, {
    executor: (gate) => pi.exec("sh", ["-lc", gate.command], { signal: ctx.signal }),
    signal: ctx.signal,
  });
}
