/**
 * Read Guard for raw.term.
 * Enforces "read-before-act": agents must observe/read a pane before sending wake signals.
 * Shields human typing and active agent outputs from accidental disruption.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const guardDir = path.join(os.tmpdir(), "raw-term-guards");

function getGuardFilePath(paneId: string): string {
  const safeId = paneId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(guardDir, safeId);
}

export function markRead(paneId: string): void {
  try {
    if (!fs.existsSync(guardDir)) {
      fs.mkdirSync(guardDir, { recursive: true });
    }
    fs.writeFileSync(getGuardFilePath(paneId), String(Date.now()), "utf8");
  } catch {
    // Best-effort non-throwing
  }
}

export function hasRead(paneId: string, maxAgeMs: number = 60_000): boolean {
  try {
    const file = getGuardFilePath(paneId);
    if (!fs.existsSync(file)) return false;
    const stat = fs.statSync(file);
    return Date.now() - stat.mtimeMs <= maxAgeMs;
  } catch {
    return false;
  }
}

export function requireRead(paneId: string, maxAgeMs: number = 60_000): void {
  if (!hasRead(paneId, maxAgeMs)) {
    throw new Error(
      `Must observe/read pane "${paneId}" before sending wake signal. Call raw_pane_peek first.`
    );
  }
}

export function clearRead(paneId: string): void {
  try {
    const file = getGuardFilePath(paneId);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  } catch {
    // Ignore
  }
}
