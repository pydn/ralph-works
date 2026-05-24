import { readFile } from "node:fs/promises";
import path from "node:path";

export async function loadModelConfig(rootDir, fileName = "model.config.json") {
  const configPath = path.join(rootDir, fileName);

  try {
    const raw = await readFile(configPath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        default_model: undefined,
        phase_models: {},
      };
    }
    throw error;
  }
}
