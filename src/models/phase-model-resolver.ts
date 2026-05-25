import type { RalphWorksPhaseId } from "../state/phase-types.ts";

export interface ModelReference {
  raw: string;
  provider?: string;
  id: string;
}

export interface PhaseModelResolutionConfig {
  default_model?: unknown;
  phase_models?: Record<string, unknown> | null;
}

export function parseModelReference(rawModel: string): ModelReference {
  const raw = rawModel.trim();
  const slashIndex = raw.indexOf("/");

  if (slashIndex === -1) {
    return {
      raw,
      provider: undefined,
      id: raw,
    };
  }

  return {
    raw,
    provider: raw.slice(0, slashIndex),
    id: raw.slice(slashIndex + 1),
  };
}

export function resolvePhaseModel(
  config: PhaseModelResolutionConfig,
  phaseId: RalphWorksPhaseId | string,
): ModelReference | undefined {
  const rawModel = config.phase_models?.[phaseId] ?? config.default_model;

  if (typeof rawModel !== "string" || rawModel.trim() === "") {
    return undefined;
  }

  return parseModelReference(rawModel);
}
