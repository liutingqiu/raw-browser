import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Browser-runtime storage locations. The model/agent config store was removed. */
export const APP_NAME = "raw";
export const CONFIG_DIR = process.env.RAW_HOME || path.join(os.homedir(), `.${APP_NAME}`);

/**
 * Earlier builds used `codex-*` directory names. Keep using an existing one so
 * an upgrade never strands a profile (and its logins); new installs get the
 * current name.
 */
function pickDirectory(preferred: string, legacy: string): string {
  try {
    if (!fs.existsSync(preferred) && fs.existsSync(legacy)) return legacy;
  } catch {
    /* fall through to the preferred name */
  }
  return preferred;
}

export const DOWNLOAD_DIR =
  process.env.RAW_DOWNLOAD_DIR ||
  pickDirectory(path.join(CONFIG_DIR, "downloads"), path.join(CONFIG_DIR, "codex-browser-downloads"));
export const BROWSER_PROFILE =
  process.env.RAW_BROWSER_PROFILE ||
  pickDirectory(path.join(CONFIG_DIR, "browser-profile"), path.join(CONFIG_DIR, "codex-browser-profile"));

export function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}
