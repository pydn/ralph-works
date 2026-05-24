export function parseModelReference(rawModel) {
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

export function resolvePhaseModel(config, phaseId) {
  const rawModel = config.phase_models?.[phaseId] ?? config.default_model;

  if (typeof rawModel !== "string" || rawModel.trim() === "") {
    return undefined;
  }

  return parseModelReference(rawModel);
}
