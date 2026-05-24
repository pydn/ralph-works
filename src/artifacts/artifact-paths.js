export const ARTIFACT_DIRECTORY = "docs";
const DEFAULT_ARTIFACT_PREFIX = "feature";
const MAX_PREFIX_LENGTH = 80;

export function sanitizeArtifactPrefix(feature) {
  const cleaned = String(feature ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_PREFIX_LENGTH)
    .replace(/-+$/g, "");

  return cleaned || DEFAULT_ARTIFACT_PREFIX;
}

function sanitizeArtifactFileName(artifactName) {
  const rawName = String(artifactName ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .at(-1) ?? "artifact.md";
  const match = rawName.match(/^(.+?)(\.[^.]+)?$/);
  const stem = sanitizeArtifactPrefix(match?.[1]);
  const extension = String(match?.[2] ?? ".md")
    .toLowerCase()
    .replace(/[^.a-z0-9]/g, "");

  return `${stem}${extension || ".md"}`;
}

export function buildArtifactPath(feature, artifactName) {
  const prefix = sanitizeArtifactPrefix(feature);
  const fileName = sanitizeArtifactFileName(artifactName);
  const prefixedName = fileName.startsWith(`${prefix}-`)
    ? fileName
    : `${prefix}-${fileName}`;

  return `${ARTIFACT_DIRECTORY}/${prefixedName}`;
}
