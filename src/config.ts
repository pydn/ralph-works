import * as os from "node:os";
import * as path from "node:path";

/** Custom session entry type used to persist Ralph state into Pi JSONL. */
export const CUSTOM_TYPE = "ralph-loop-state";

/** Skill root can be overridden in tests; production defaults to Pi's global skill directory. */
export const SKILL_BASE = process.env.PI_SKILL_BASE ?? path.join(os.homedir(), ".pi", "agent", "skills", "_global");

export const MAX_PHASE_ATTEMPTS = 3;
export const GATE_THRESHOLD = 3;
export const GATE_PHASES = new Set(["implement", "review"]);
export const WAITING_FOR_USER_PHASE_STATUS = "waiting_for_user";
export const IMPLEMENT_CHECKPOINT_WAIT_REASON = "implement_checkpoint";
export const RENDER_HTML_FLAG = "--render-html";
export const YOLO_FLAG = "--yolo";
export const RENDER_PHASE = "render";
export const PROMPT_FILE_EXTENSIONS = new Set([".md", ".txt", ".html"]);
export const STEER_DEDUP_TTL_MS = 30_000;
export const UI_WIDGET_ID = "ralph-loop";
export const UI_WIDGET_MAX_LINES = 4;
