import assert from "node:assert/strict";
import test from "node:test";

import {
  buildArtifactPath,
  sanitizeArtifactPrefix,
} from "../src/artifacts/artifact-paths.ts";

test("artifact paths use docs directory and feature prefix", () => {
  assert.equal(
    buildArtifactPath("hello-world", "generated-spec.md"),
    "docs/hello-world-generated-spec.md",
  );
});

test("feature prefixes are cleaned before becoming filenames", () => {
  assert.equal(sanitizeArtifactPrefix("../Hello World!!"), "hello-world");
  assert.equal(sanitizeArtifactPrefix("   ***   "), "feature");
  assert.equal(
    buildArtifactPath("../Hello World!!", "../Generated Spec!!.md"),
    "docs/hello-world-generated-spec.md",
  );
});

test("artifact paths avoid duplicate feature prefixes", () => {
  assert.equal(
    buildArtifactPath("hello-world", "docs/hello-world-generated-spec.md"),
    "docs/hello-world-generated-spec.md",
  );
});
