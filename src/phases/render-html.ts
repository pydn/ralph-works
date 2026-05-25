import type { RalphWorksPhaseDefinition } from "../state/phase-types.ts";

export const renderHtmlPhase = {
  id: "render_html_optional",
  label: "Optional HTML Render",
  skillDirectory: "render-html-optional",
  artifactKey: "hardenedSpecHtml",
  artifactPath: "hardened-spec.html",
} satisfies RalphWorksPhaseDefinition;
