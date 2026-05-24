import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerRalphWorksExtension } from "./harness/pi-harness-adapter.js";

export default function ralphWorksExtension(pi: ExtensionAPI) {
  registerRalphWorksExtension(pi);
}
