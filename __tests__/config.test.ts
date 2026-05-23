import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalSkillBase = process.env.PI_SKILL_BASE;

afterEach(() => {
  if (originalSkillBase === undefined) delete process.env.PI_SKILL_BASE;
  else process.env.PI_SKILL_BASE = originalSkillBase;
  vi.resetModules();
});

describe("SKILL_BASE", () => {
  it("defaults to Pi's documented global skills directory", async () => {
    delete process.env.PI_SKILL_BASE;
    vi.resetModules();

    const { SKILL_BASE } = await import("../src/config");

    expect(SKILL_BASE).toBe(path.join(os.homedir(), ".pi", "agent", "skills"));
  });

  it("still supports PI_SKILL_BASE override", async () => {
    process.env.PI_SKILL_BASE = "/tmp/custom-skills";
    vi.resetModules();

    const { SKILL_BASE } = await import("../src/config");

    expect(SKILL_BASE).toBe("/tmp/custom-skills");
  });
});
