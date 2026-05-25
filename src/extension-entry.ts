import { registerRalphWorksExtension } from "./harness/pi-harness-adapter.ts";
import type { RalphWorksPiApi } from "./harness/pi-harness-types.ts";

export default function ralphWorksExtension(pi: RalphWorksPiApi) {
  registerRalphWorksExtension(pi);
}
