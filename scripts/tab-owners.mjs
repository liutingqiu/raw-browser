#!/usr/bin/env node
/**
 * Tab ownership registry shared by every agent process.
 *
 * The browser is one profile with one set of tabs, but several agents may drive
 * it. This file records which agent owns which tab, so an agent can only act on
 * tabs it claimed and never silently takes over the page a human is reading.
 *
 * Storage: a small JSON file under RAW_HOME, guarded by a lock file and
 * written atomically. Reads are tolerant: a corrupt file becomes an empty
 * registry instead of blocking every agent.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const VERSION = 1;
const MAX_LABEL = 32;

export function defaultRegistryPath() {
  const home = process.env.RAW_HOME || path.join(os.homedir(), ".raw");
  return path.join(home, "tab-owners.json");
}

/** A label is what the page banner shows; keep it short and printable. */
export function sanitizeLabel(raw, fallback = "agent") {
  const text = String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return (text.slice(0, MAX_LABEL) || fallback).trim();
}

function emptyState() {
  return { version: VERSION, owners: {}, tabs: {} };
}

function normalizeState(raw) {
  if (!raw || typeof raw !== "object") return emptyState();
  const owners = raw.owners && typeof raw.owners === "object" ? raw.owners : {};
  const tabs = raw.tabs && typeof raw.tabs === "object" ? raw.tabs : {};
  const cleanOwners = {};
  for (const [label, entry] of Object.entries(owners)) {
    if (!entry || typeof entry !== "object") continue;
    const list = Array.isArray(entry.tabs) ? entry.tabs.filter((id) => typeof id === "string") : [];
    cleanOwners[label] = {
      label,
      tabs: [...new Set(list)],
      updatedAt: Number(entry.updatedAt) || 0,
    };
  }
  const cleanTabs = {};
  for (const [tabId, owner] of Object.entries(tabs)) {
    if (typeof tabId === "string" && typeof owner === "string" && cleanOwners[owner]) {
      cleanTabs[tabId] = owner;
    }
  }
  return { version: VERSION, owners: cleanOwners, tabs: cleanTabs };
}

export function readRegistry(file = defaultRegistryPath()) {
  try {
    const text = fs.readFileSync(file, "utf8").replace(/^\ufeff/, "");
    return normalizeState(JSON.parse(text));
  } catch {
    return emptyState();
  }
}

function writeRegistry(state, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Serialize read-modify-write across processes. */
function withLock(file, fn) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + 5000;
  for (;;) {
    let fd;
    try {
      fd = fs.openSync(lock, "wx");
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 5000) fs.rmSync(lock, { force: true });
      } catch {
        /* the holder just released it */
      }
      if (Date.now() > deadline) throw new Error("timed out waiting for the tab ownership registry");
      sleepSync(20);
      continue;
    }
    try {
      return fn();
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
      try {
        fs.rmSync(lock, { force: true });
      } catch {
        /* already gone */
      }
    }
  }
}

function detachTab(state, tabId) {
  const owner = state.tabs[tabId];
  delete state.tabs[tabId];
  if (!owner) return;
  const entry = state.owners[owner];
  if (!entry) return;
  entry.tabs = entry.tabs.filter((id) => id !== tabId);
  entry.updatedAt = Date.now();
  if (entry.tabs.length === 0) delete state.owners[owner];
}

/**
 * Claim one tab for `label`. A tab owned by another agent is refused unless
 * `force` is set (an explicit takeover), which is what a human would expect a
 * "take over this tab" button to do.
 */
export function claimTab(label, tabId, { file = defaultRegistryPath(), force = false } = {}) {
  const owner = sanitizeLabel(label);
  const id = String(tabId);
  if (!id) throw new Error("claimTab needs a tab id");
  return withLock(file, () => {
    const state = readRegistry(file);
    const current = state.tabs[id];
    if (current && current !== owner) {
      if (!force) throw new Error(`tab ${id} is controlled by "${current}"`);
      detachTab(state, id);
    }
    state.tabs[id] = owner;
    const entry = state.owners[owner] ?? { label: owner, tabs: [], updatedAt: 0 };
    if (!entry.tabs.includes(id)) entry.tabs.push(id);
    entry.updatedAt = Date.now();
    state.owners[owner] = entry;
    writeRegistry(state, file);
    return state;
  });
}

/** Give a tab back to the unowned pool; it stays open. */
export function releaseTab(label, tabId, { file = defaultRegistryPath() } = {}) {
  const owner = sanitizeLabel(label);
  const id = String(tabId);
  return withLock(file, () => {
    const state = readRegistry(file);
    const current = state.tabs[id];
    if (current && current !== owner) throw new Error(`tab ${id} is controlled by "${current}"`);
    detachTab(state, id);
    writeRegistry(state, file);
    return state;
  });
}

/** Forget a tab regardless of who owns it (used when it was closed). */
export function forgetTab(tabId, { file = defaultRegistryPath() } = {}) {
  const id = String(tabId);
  return withLock(file, () => {
    const state = readRegistry(file);
    detachTab(state, id);
    writeRegistry(state, file);
    return state;
  });
}

/** Drop every tab of one agent (used when it renames itself or shuts down). */
export function releaseAll(label, { file = defaultRegistryPath() } = {}) {
  const owner = sanitizeLabel(label);
  return withLock(file, () => {
    const state = readRegistry(file);
    for (const id of [...(state.owners[owner]?.tabs ?? [])]) detachTab(state, id);
    writeRegistry(state, file);
    return state;
  });
}

/** Move an agent's tabs to a new label, so renaming keeps its pages. */
export function renameOwner(fromLabel, toLabel, { file = defaultRegistryPath() } = {}) {
  const from = sanitizeLabel(fromLabel);
  const to = sanitizeLabel(toLabel);
  return withLock(file, () => {
    const state = readRegistry(file);
    if (from === to) return state;
    const entry = state.owners[from];
    if (!entry) return state;
    const target = state.owners[to] ?? { label: to, tabs: [], updatedAt: 0 };
    for (const id of entry.tabs) {
      state.tabs[id] = to;
      if (!target.tabs.includes(id)) target.tabs.push(id);
    }
    target.updatedAt = Date.now();
    state.owners[to] = target;
    delete state.owners[from];
    writeRegistry(state, file);
    return state;
  });
}

/** Forget tabs that no longer exist in the browser. */
export function pruneRegistry(validTabIds, { file = defaultRegistryPath() } = {}) {
  const valid = new Set([...validTabIds].map(String));
  return withLock(file, () => {
    const state = readRegistry(file);
    let changed = false;
    for (const id of Object.keys(state.tabs)) {
      if (!valid.has(id)) {
        detachTab(state, id);
        changed = true;
      }
    }
    if (changed) writeRegistry(state, file);
    return state;
  });
}

export function ownerOf(tabId, { file = defaultRegistryPath() } = {}) {
  const state = readRegistry(file);
  return state.tabs[String(tabId)] ?? null;
}

export function ownedTabIds(label, { file = defaultRegistryPath() } = {}) {
  const state = readRegistry(file);
  return [...(state.owners[sanitizeLabel(label)]?.tabs ?? [])];
}
