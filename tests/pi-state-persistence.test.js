import assert from "node:assert/strict";
import test from "node:test";

import {
  RALPH_WORKS_STATE_ENTRY_TYPE,
  restoreRalphWorksState,
} from "../src/harness/pi-state-persistence.js";
import { createPhaseState } from "../src/state/phase-state.js";

test("restored sessions rebuild artifact paths with the feature prefix", () => {
  const saved = {
    ...createPhaseState({ feature: "../Hello World!!" }),
    phases: [
      {
        id: "generate_spec",
        artifactPath: "generated-spec.md",
      },
    ],
  };

  const restored = restoreRalphWorksState({
    sessionManager: {
      getEntries() {
        return [
          {
            type: "custom",
            customType: RALPH_WORKS_STATE_ENTRY_TYPE,
            data: saved,
          },
        ];
      },
    },
  });

  assert.equal(
    restored.phases.find((phase) => phase.id === "generate_spec").artifactPath,
    "docs/hello-world-generated-spec.md",
  );
});
