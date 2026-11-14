#!/usr/bin/env node
/**
 * Per-origin browser permissions.
 *
 * The extension bridge drives the human's real, logged-in profile, so an agent
 * should be able to answer "may I open this site?" before it navigates there.
 * The default is allow (raw stays frictionless); set `defaultAccess` to "ask"
 * or "deny" in `$RAW_HOME/permissions.json` to turn on confirmation, and pin
 * individual origins with an explicit allow/deny.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const VERSION = 1;
const DECISIONS = new Set(["allow", "ask", "deny"]);

export function defaultPermissionsPath() {
  const home = process.env.RAW_HOME || path.join(os.homedir(), ".raw");
  return path.join(home, "permissions.json");
}

function emptyPermissions() {
  return { version: VERSION, defaultAccess: "allow", origins: {} };
}

function normalize(raw) {
  if (!raw || typeof raw !== "object") return emptyPermissions();
  const defaultAccess = DECISIONS.has(raw.defaultAccess) ? raw.defaultAccess : "allow";
  const origins = {};
  if (raw.origins && typeof raw.origins === "object") {
    for (const [origin, entry] of Object.entries(raw.origins)) {
      if (!entry || typeof entry !== "object") continue;
      if (!DECISIONS.has(entry.access)) continue;
      origins[origin] = {
        access: entry.access,
        approvedAt: Number(entry.approvedAt) || 0,
      };
    }
  }
  return { version: VERSION, defaultAccess, origins };
}

export function readPermissions(file = defaultPermissionsPath()) {
  try {
    const text = fs.readFileSync(file, "utf8").replace(/^\ufeff/, "");
    return normalize(JSON.parse(text));
  } catch {
    return emptyPermissions();
  }
}

function writePermissions(state, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Normalize a bare host or full URL into an http(s) origin, else null. */
export function originFor(url) {
  const text = String(url ?? "").trim();
  if (!text) return null;
  const candidate = text.startsWith("//")
    ? `https:${text}`
    : /^[a-z][a-z0-9+.-]*:\d+(?:[/?#]|$)/i.test(text)
      ? `https://${text}`
      : /^[a-z][a-z0-9+.-]*:/i.test(text)
        ? text
        : `https://${text}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.origin;
    return null;
  } catch {
    return null;
  }
}

/**
 * Decision for one URL. Non-http(s) URLs (file:, about:, data:) are outside the
 * origin model and always allowed; the caller can still refuse on its own.
 */
export function accessFor(url, { file = defaultPermissionsPath(), permissions } = {}) {
  const origin = originFor(url);
  if (!origin) return { origin: null, decision: "allow", source: "non-http" };
  const state = permissions ?? readPermissions(file);
  const entry = state.origins[origin];
  if (entry) return { origin, decision: entry.access, source: "origin" };
  return { origin, decision: state.defaultAccess, source: "default" };
}

/** Persist an allow for one origin (`scope: "persistent"`). */
export function approveOrigin(url, { file = defaultPermissionsPath() } = {}) {
  const origin = originFor(url);
  if (!origin) throw new Error(`not an http(s) URL: ${url}`);
  const state = readPermissions(file);
  state.origins[origin] = { access: "allow", approvedAt: Date.now() };
  writePermissions(state, file);
  return origin;
}
