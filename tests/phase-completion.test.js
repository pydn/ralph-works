import assert from "node:assert/strict";
import test from "node:test";

import { isLgtmReview } from "../src/state/phase-completion.js";

test("review only completes on explicit LGTM", () => {
  assert.equal(isLgtmReview("LGTM"), true);
  assert.equal(isLgtmReview("LGTM. No critical bugs found."), true);
  assert.equal(isLgtmReview("No critical bugs found."), false);
  assert.equal(isLgtmReview("looks good to me"), false);
});

test("critical review findings override LGTM text", () => {
  assert.equal(
    isLgtmReview("[CRITICAL] Missing regression test.\n\nLGTM"),
    false,
  );
});
