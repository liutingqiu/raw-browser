#!/usr/bin/env node
/**
 * MCP server for the Raw Browser Bridge.
 *
 * This is the long-lived MCP front end; the actual protocol work lives in
 * scripts/raw-bridge.mjs so the CLI, the MCP server and manual use all share
 * one implementation (including page-helpers locators and rich-text writes).
 *
 * Transport: newline-delimited JSON-RPC 2.0 over stdio. Nothing but protocol
 * messages is written to stdout; diagnostics go to stderr.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import {
  claimTab,
  defaultRegistryPath,
  ownedTabIds,
  ownerOf,
  pruneRegistry,
  readRegistry,
  releaseTab,
  renameOwner,
  sanitizeLabel,
} from "../scripts/tab-owners.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TIMEOUT = Number(process.env.RAW_MCP_TIMEOUT_MS || 60_000);

let _blackboard = null;
async function getBlackboard() {
  if (!_blackboard) {
    const { Blackboard } = await import("../dist/mesh/blackboard.js");
    _blackboard = new Blackboard();
  }
  return _blackboard;
}

let _tmuxDriver = null;
async function getTmuxDriver() {
  if (!_tmuxDriver) {
    const { TmuxDriver } = await import("../dist/term/tmux-driver.js");
    _tmuxDriver = new TmuxDriver();
  }
  return _tmuxDriver;
}

function findCli() {
  if (process.env.RAW_CLI) return process.env.RAW_CLI;
  const candidates = [
    path.join(HERE, "..", "scripts", "raw-bridge.mjs"),
    path.join(HERE, "scripts", "raw-bridge.mjs"),
    path.join(os.homedir(), ".raw", "mcp", "scripts", "raw-bridge.mjs"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

const RAW_CLI = findCli();
const NODE = process.env.RAW_NODE || process.execPath;
const detectedBrowser = (process.env.RAW_BRIDGE_BROWSER || process.env.RAW_BROWSER_BRIDGE || "").toLowerCase();
let browser = detectedBrowser === "chrome" ? "chrome" : "edge";
let currentTabId = null;
const inFlight = new Map();

/** Tools that only touch SQLite/tmux never wait behind a slow browser call. */
const LOCAL_TOOLS = new Set(["raw_task", "raw_term"]);
const LOCAL_TOOL_TIMEOUT_MS = Number(process.env.RAW_LOCAL_TOOL_TIMEOUT_MS || 120_000);
const MAX_IMAGE_BYTES = Number(process.env.RAW_MCP_MAX_IMAGE_BYTES || 8_000_000);

/** camelCase is canonical; snake_case is accepted so a caller's usual style works. */
const PARAM_ALIASES = {
  taskId: ["taskId", "task_id"],
  artifactType: ["artifactType", "artifact_type"],
  msgType: ["msgType", "msg_type"],
  contextData: ["contextData", "context_data"],
  contractSpec: ["contractSpec", "contract_spec"],
  resultData: ["resultData", "result_data"],
  unreadOnly: ["unreadOnly", "unread_only"],
  markRead: ["markRead", "mark_read"],
};

const ALIAS_TO_CANONICAL = new Map();
for (const [canonical, aliases] of Object.entries(PARAM_ALIASES)) {
  for (const alias of aliases) ALIAS_TO_CANONICAL.set(alias, canonical);
}

const TASK_PARAMS = {
  create: ["title", "creator", "assignee", "contextData", "contractSpec"],
  send: ["taskId", "title", "sender", "recipient", "msgType", "payload", "text", "contextData"],
  poll: ["recipient", "unreadOnly", "markRead"],
  list: ["assignee", "status", "limit"],
  get: ["taskId"],
  update: ["taskId", "status", "resultData"],
  submit_artifact: ["taskId", "author", "artifactType", "content"],
  verify: ["taskId", "cwd"],
};

/**
 * Normalize one action's parameters and refuse unknown keys. Silently dropping
 * `contract_spec` used to create a task with no contract and no error.
 */
function normalizeTaskParams(action, raw) {
  const allowed = TASK_PARAMS[action];
  if (!allowed) throw new Error(`unknown raw_task action: ${action}`);
  const allowedSet = new Set(allowed);
  const out = {};
  const unknown = [];
  for (const [key, value] of Object.entries(raw ?? {})) {
    const canonical = ALIAS_TO_CANONICAL.get(key) ?? key;
    if (!allowedSet.has(canonical)) {
      unknown.push(key);
      continue;
    }
    if (canonical in out && out[canonical] !== value) {
      throw new Error(`conflicting values passed for ${canonical}`);
    }
    out[canonical] = value;
  }
  if (unknown.length) {
    throw new Error(
      `unknown parameter(s) for ${action}: ${unknown.join(", ")}; accepted: ${allowed.join(", ")}`,
    );
  }
  return out;
}

const tools = [
  {
    name: "raw_use",
    description: "Select which browser bridge to drive: edge or chrome.",
    inputSchema: {
      type: "object",
      properties: { browser: { type: "string", enum: ["edge", "chrome"] } },
      required: ["browser"],
      additionalProperties: false,
    },
  },
  {
    name: "raw_status",
    description: "Check that the selected browser bridge is alive and report bridge/extension versions.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "raw_tabs",
    description: "List open tabs with id, active flag, title and URL. Remembers the active tab.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "raw_claim",
    description:
      "Claim a tab for this agent (opens one unless tabId is given). The label is shown on the tab banner and in raw_tabs; other agents cannot act on a claimed tab.",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string", description: "Agent name shown on the tab (max 32 chars)" },
        tabId: { type: "string", description: "Existing tab to claim instead of opening one" },
        url: { type: "string", description: "URL for the new tab (default about:blank)" },
        force: { type: "boolean", description: "Take a tab controlled by another label" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "raw_release",
    description: "Release a claimed tab back to the pool without closing it.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "string", description: "Tab to release (defaults to your current tab)" } },
      additionalProperties: false,
    },
  },
  {
    name: "raw_close",
    description: "Close a tab this agent owns and release it.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "string", description: "Tab to close (defaults to your current tab)" } },
      additionalProperties: false,
    },
  },
  {
    name: "raw_new",
    description: "Open a new tab at a URL, wait for it to load, and claim it for this agent.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "URL to open" } },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "raw_goto",
    description: "Navigate an existing tab (or the current tab) to a URL and wait for load.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        tabId: { type: "string", description: "Optional tab id; defaults to the current tab" },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "raw_text",
    description: "Read visible text from a tab, optionally for a selector.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "Optional locator (CSS, XPath, text=, role=, #index)" },
        tabId: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "raw_html",
    description: "Read HTML from a tab, optionally for a selector.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "Optional locator" },
        tabId: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "raw_eval",
    description: "Evaluate a JavaScript expression in a tab and return the value as JSON. Top-level await is allowed.",
    inputSchema: {
      type: "object",
      properties: {
        expression: { type: "string" },
        tabId: { type: "string", description: "Optional tab id; defaults to the current tab" },
      },
      required: ["expression"],
      additionalProperties: false,
    },
  },
  {
    name: "raw_snapshot",
    description: "Return a numbered interactive-element snapshot plus page text. Indices work with #N locators.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "raw_click",
    description: "Click the first element matching a locator using a real mouse event.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS, XPath, text=, role=, or #index from raw_snapshot" },
        tabId: { type: "string" },
      },
      required: ["selector"],
      additionalProperties: false,
    },
  },
  {
    name: "raw_fill",
    description: "Write into an input, textarea, contenteditable, Monaco or CodeMirror field.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        value: { type: "string" },
        tabId: { type: "string" },
      },
      required: ["selector", "value"],
      additionalProperties: false,
    },
  },
  {
    name: "raw_visit",
    description: "Open a URL in a temporary tab, wait for load, evaluate an optional expression, then close the tab.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        expression: { type: "string", description: "Optional expression to evaluate after load" },
        waitMs: { type: "number", description: "Navigation timeout in milliseconds (default 15000)" },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "raw_screenshot",
    description: "Capture a PNG of a tab and return it as an image plus its saved path.",
    inputSchema: {
      type: "object",
      properties: {
        out: { type: "string", description: "Optional output path" },
        tabId: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "raw_cookies",
    description: "List cookies for a domain (values included). Treat the output as a secret.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string" },
        tabId: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "raw_frames",
    description: "List frames in a tab, including cross-origin iframes.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "raw_call",
    description: "Escape hatch: call any Raw.* or browser-level CDP method with JSON params.",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string" },
        params: { type: "object" },
      },
      required: ["method"],
      additionalProperties: false,
    },
  },
  {
    name: "raw_task",
    description: "Multi-Agent task blackboard & mailbox. Actions: create, send, poll, list, get, update, submit_artifact, verify. Parameters use camelCase; snake_case aliases (task_id, contract_spec, artifact_type, msg_type) are accepted too.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "send", "poll", "list", "get", "update", "submit_artifact", "verify"],
          description: "Blackboard operation to perform",
        },
        params: {
          type: "object",
          description: "Action-specific parameters",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "raw_term",
    description: "Tmux terminal topology & non-disruptive wake signals. Actions: list, peek, wake, name.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "peek", "wake", "name"],
          description: "Tmux terminal operation",
        },
        params: {
          type: "object",
          description: "Action-specific parameters",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
];

function bridgeArgs() {
  return browser === "chrome" ? ["--chrome"] : [];
}

function runRaw(argv, timeoutMs = DEFAULT_TIMEOUT, requestId) {
  return new Promise((resolve) => {
    const child = spawn(NODE, [RAW_CLI, ...bridgeArgs(), ...argv], {
      windowsHide: true,
      env: { ...process.env, RAW_BRIDGE_BROWSER: browser, RAW_OWNER_LABEL: ownerLabel },
    });
    if (requestId !== undefined) inFlight.set(requestId, child);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      resolve({ ok: false, text: `raw command timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (requestId !== undefined) inFlight.delete(requestId);
      resolve({ ok: false, text: String(error) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (requestId !== undefined) inFlight.delete(requestId);
      const raw = (stdout || stderr || `raw exited with code ${code}`).trim();
      let value;
      try { value = JSON.parse(raw); } catch { value = raw; }
      resolve({ ok: code === 0, value, text: raw });
    });
  });
}

function asText(value, max = 20_000) {
  if (value === undefined || value === null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.length > max ? `${text.slice(0, max)}\n... [${text.length - max} chars omitted]` : text;
}

function succeeded(result) {
  return result.ok || (result.value && typeof result.value === "object" && !result.value.error);
}

/** Each MCP process is one agent; the label is what the page banner shows. */
/** Chrome and Edge tabs share nothing, so each browser gets its own registry file. */
function registryFile() {
  if (process.env.RAW_TAB_OWNERS_FILE) return process.env.RAW_TAB_OWNERS_FILE;
  const dir = path.dirname(defaultRegistryPath());
  return path.join(dir, `tab-owners-${browser}.json`);
}
const DEFAULT_OWNER = sanitizeLabel(process.env.RAW_OWNER_LABEL || "agent");
let ownerLabel = process.env.RAW_OWNER_LABEL ? sanitizeLabel(process.env.RAW_OWNER_LABEL) : "";

function ensureOwner() {
  if (!ownerLabel) ownerLabel = DEFAULT_OWNER;
  return ownerLabel;
}

function ownedTabs() {
  return ownerLabel ? ownedTabIds(ownerLabel, { file: registryFile() }) : [];
}

function ownerError(tabId, owner) {
  if (owner) {
    return `tab ${tabId} is controlled by "${owner}"; use one of your own tabs, or call raw_claim { "label": "${ownerLabel || DEFAULT_OWNER}", "tabId": "${tabId}", "force": true } to take it over`;
  }
  return `tab ${tabId} is not claimed; call raw_claim { "label": "${ownerLabel || DEFAULT_OWNER}", "tabId": "${tabId}" } first`;
}

/** Explicit tab ids must belong to this agent. */
function assertOwned(tabId) {
  const id = String(tabId);
  const owner = ownerOf(id, { file: registryFile() });
  const label = ensureOwner();
  if (owner !== label) throw new Error(ownerError(id, owner));
  return id;
}

/** The tab a tab-scoped tool should act on, or an actionable error. */
function resolveOwnedTab(explicit) {
  if (explicit !== undefined && explicit !== null && explicit !== "") return assertOwned(explicit);
  const owned = ownedTabs();
  if (currentTabId && owned.includes(currentTabId)) return currentTabId;
  if (owned.length > 0) return owned[0];
  throw new Error(
    `you have no claimed tab; call raw_claim { "label": "your-agent-name" } to open one, ` +
      `or raw_claim with "tabId" to take an existing tab`,
  );
}

/** Paint the owner label where the extension overlay reads it. */
async function stampOwner(tabId, label, requestId) {
  const expression =
    `(window.__rawOwner = { label: ${JSON.stringify(label)} }, ` +
    `document.documentElement && document.documentElement.setAttribute("data-raw-owner", ${JSON.stringify(label)}), "ok")`;
  await runRaw(["eval", String(tabId), expression], 15_000, requestId).catch(() => {});
}

/** Open a fresh tab and claim it, so a new agent never borrows the human's tab. */
async function openClaimedTab(url, requestId) {
  const label = ensureOwner();
  const result = await runRaw(["new", String(url ?? "about:blank")], DEFAULT_TIMEOUT, requestId);
  if (!succeeded(result)) return { error: asText(result.value ?? result.text) };
  const value = result.value;
  const tabId = String(value?.id ?? value?.tabId ?? "");
  if (!tabId) return { error: asText(result.value ?? result.text) };
  claimTab(label, tabId, { file: registryFile() });
  currentTabId = tabId;
  await stampOwner(tabId, label, requestId);
  return { tabId, label };
}

async function callTool(name, args = {}, requestId) {
  switch (name) {
    case "raw_use": {
      const wanted = String(args.browser || "").toLowerCase();
      if (wanted !== "edge" && wanted !== "chrome") return { error: "browser must be edge or chrome" };
      browser = wanted;
      currentTabId = null;
      const status = await runRaw(["status"], DEFAULT_TIMEOUT, requestId);
      return { text: status.text, isError: !status.ok };
    }
    case "raw_status": {
      const result = await runRaw(["status"], DEFAULT_TIMEOUT, requestId);
      const owned = ownedTabs();
      const owner = ownerLabel || "(none — call raw_claim)";
      return {
        text: `${result.text}\nowner: ${owner}\nowned tabs: ${owned.length ? owned.join(", ") : "none"}`,
        isError: !result.ok,
      };
    }
    case "raw_tabs": {
      const result = await runRaw(["tabs"], DEFAULT_TIMEOUT, requestId);
      if (!result.ok || !Array.isArray(result.value)) {
        return { text: asText(result.value ?? result.text), isError: !result.ok };
      }
      const ids = result.value.map((tab) => String(tab.id));
      pruneRegistry(ids, { file: registryFile() });
      const state = readRegistry(registryFile());
      const label = ownerLabel;
      const annotated = result.value.map((tab) => {
        const id = String(tab.id);
        const owner = state.tabs[id] ?? null;
        return { ...tab, owner, owned: Boolean(label) && owner === label };
      });
      // Listing tabs is read-only: keep working on the tab we already own.
      const owned = annotated.filter((tab) => tab.owned).map((tab) => String(tab.id));
      if (!currentTabId || !owned.includes(currentTabId)) currentTabId = owned[0] ?? null;
      return { text: asText(annotated), isError: false };
    }
    case "raw_new": {
      const opened = await openClaimedTab(args.url, requestId);
      if (opened.error) return { text: opened.error, isError: true };
      return {
        text: JSON.stringify({ tabId: opened.tabId, label: opened.label, ownedTabs: ownedTabs() }, null, 2),
        isError: false,
      };
    }
    case "raw_goto": {
      const url = String(args.url ?? "about:blank");
      let tabId;
      if (args.tabId !== undefined && args.tabId !== null && args.tabId !== "") {
        tabId = assertOwned(args.tabId);
      } else {
        const owned = ownedTabs();
        tabId = owned.includes(currentTabId) ? currentTabId : owned[0];
      }
      if (!tabId) {
        // No tab of our own yet: open one instead of navigating the human's.
        const opened = await openClaimedTab(url, requestId);
        if (opened.error) return { text: opened.error, isError: true };
        return {
          text: JSON.stringify({ tabId: opened.tabId, url, label: opened.label, ownedTabs: ownedTabs() }, null, 2),
          isError: false,
        };
      }
      const result = await runRaw(["goto", String(tabId), url], DEFAULT_TIMEOUT, requestId);
      if (succeeded(result)) {
        currentTabId = String(tabId);
        await stampOwner(tabId, ownerLabel || DEFAULT_OWNER, requestId);
      }
      return { text: asText(result.value ?? result.text), isError: !succeeded(result) };
    }
    case "raw_claim": {
      const label = sanitizeLabel(args.label ?? ownerLabel ?? DEFAULT_OWNER);
      if (ownerLabel && label !== ownerLabel) {
        // Renaming keeps the tabs this agent already owns.
        renameOwner(ownerLabel, label, { file: registryFile() });
      }
      ownerLabel = label;
      let tabId;
      if (args.tabId !== undefined && args.tabId !== null && args.tabId !== "") {
        tabId = String(args.tabId);
        try {
          claimTab(label, tabId, { file: registryFile(), force: args.force === true });
        } catch (error) {
          return { text: `${error.message}; pass "force": true to take it over`, isError: true };
        }
      } else {
        const opened = await openClaimedTab(args.url, requestId);
        if (opened.error) return { text: opened.error, isError: true };
        tabId = opened.tabId;
      }
      currentTabId = tabId;
      await stampOwner(tabId, label, requestId);
      return {
        text: JSON.stringify({ label, tabId, ownedTabs: ownedTabIds(label, { file: registryFile() }) }, null, 2),
        isError: false,
      };
    }
    case "raw_release": {
      let tabId;
      try {
        tabId = args.tabId ? assertOwned(args.tabId) : resolveOwnedTab();
      } catch (error) {
        return { text: error.message, isError: true };
      }
      releaseTab(ownerLabel, tabId, { file: registryFile() });
      if (currentTabId === tabId) currentTabId = ownedTabs()[0] ?? null;
      return {
        text: JSON.stringify({ released: tabId, ownedTabs: ownedTabs() }, null, 2),
        isError: false,
      };
    }
    case "raw_close": {
      let tabId;
      try {
        tabId = args.tabId ? assertOwned(args.tabId) : resolveOwnedTab();
      } catch (error) {
        return { text: error.message, isError: true };
      }
      const result = await runRaw(["close", tabId], DEFAULT_TIMEOUT, requestId);
      releaseTab(ownerLabel, tabId, { file: registryFile() });
      if (currentTabId === tabId) currentTabId = ownedTabs()[0] ?? null;
      if (!result.ok) {
        return {
          text: `${asText(result.value ?? result.text)}\n(the tab was released from this agent; it may already be gone)`,
          isError: true,
        };
      }
      return {
        text: JSON.stringify({ closed: tabId, ownedTabs: ownedTabs() }, null, 2),
        isError: false,
      };
    }
    case "raw_text": {
      const tabId = resolveOwnedTab(args.tabId);
      const argv = ["text"];
      if (tabId) argv.push(String(tabId));
      if (args.selector) argv.push(String(args.selector));
      const result = await runRaw(argv, DEFAULT_TIMEOUT, requestId);
      return { text: asText(result.value ?? result.text), isError: !result.ok };
    }
    case "raw_html": {
      const tabId = resolveOwnedTab(args.tabId);
      const argv = ["html"];
      if (tabId) argv.push(String(tabId));
      if (args.selector) argv.push(String(args.selector));
      const result = await runRaw(argv, DEFAULT_TIMEOUT, requestId);
      return { text: asText(result.value ?? result.text, 50_000), isError: !result.ok };
    }
    case "raw_eval": {
      const tabId = resolveOwnedTab(args.tabId);
      const argv = ["eval"];
      if (tabId) argv.push(String(tabId));
      argv.push(String(args.expression ?? ""));
      const result = await runRaw(argv, DEFAULT_TIMEOUT, requestId);
      return { text: asText(result.value ?? result.text), isError: !result.ok };
    }
    case "raw_snapshot": {
      const tabId = resolveOwnedTab(args.tabId);
      const argv = ["snapshot"];
      if (tabId) argv.push(String(tabId));
      const result = await runRaw(argv, DEFAULT_TIMEOUT, requestId);
      const value = result.value;
      const text = value && typeof value === "object" && value.snapshot !== undefined ? value.snapshot : asText(value ?? result.text);
      return { text: asText(text, 30_000), isError: !result.ok };
    }
    case "raw_click": {
      const tabId = resolveOwnedTab(args.tabId);
      const argv = ["click"];
      if (tabId) argv.push(String(tabId));
      argv.push(String(args.selector));
      const result = await runRaw(argv, DEFAULT_TIMEOUT, requestId);
      return { text: asText(result.value ?? result.text), isError: !result.ok };
    }
    case "raw_fill": {
      const tabId = resolveOwnedTab(args.tabId);
      const argv = ["fill"];
      if (tabId) argv.push(String(tabId));
      argv.push(String(args.selector), String(args.value ?? ""));
      const result = await runRaw(argv, DEFAULT_TIMEOUT, requestId);
      return { text: asText(result.value ?? result.text), isError: !result.ok };
    }
    case "raw_visit": {
      const argv = ["visit", String(args.url), String(args.expression ?? ""), String(args.waitMs ?? "")];
      const result = await runRaw(argv, Math.max(DEFAULT_TIMEOUT, 90_000), requestId);
      return { text: asText(result.value ?? result.text), isError: !result.ok };
    }
    case "raw_screenshot": {
      const tabId = resolveOwnedTab(args.tabId);
      const argv = ["screenshot"];
      if (tabId) argv.push(String(tabId));
      if (args.out) argv.push(String(args.out));
      const result = await runRaw(argv, DEFAULT_TIMEOUT, requestId);
      if (!result.ok) return { text: asText(result.value ?? result.text), isError: true };
      const saved = result.value?.saved;
      if (saved && fs.existsSync(saved)) {
        const bytes = fs.statSync(saved).size;
        if (bytes > MAX_IMAGE_BYTES) {
          return {
            text:
              `screenshot saved to ${saved} (${bytes} bytes) but it is larger than the ` +
              `${MAX_IMAGE_BYTES}-byte inline limit, so it was not attached; open it from disk.`,
            isError: false,
          };
        }
        const data = fs.readFileSync(saved).toString("base64");
        return {
          text: `screenshot: ${saved}`,
          image: { type: "image", data, mimeType: "image/png" },
          isError: false,
        };
      }
      return { text: asText(result.value ?? result.text), isError: false };
    }
    case "raw_cookies": {
      const tabId = resolveOwnedTab(args.tabId);
      const argv = ["cookies"];
      if (tabId) argv.push(String(tabId));
      if (args.domain) argv.push(String(args.domain));
      const result = await runRaw(argv, DEFAULT_TIMEOUT, requestId);
      return { text: asText(result.value ?? result.text), isError: !result.ok };
    }
    case "raw_frames": {
      const tabId = resolveOwnedTab(args.tabId);
      const argv = ["frames"];
      if (tabId) argv.push(String(tabId));
      const result = await runRaw(argv, DEFAULT_TIMEOUT, requestId);
      return { text: asText(result.value ?? result.text), isError: !result.ok };
    }
    case "raw_call": {
      const argv = ["call", String(args.method), JSON.stringify(args.params ?? {})];
      const result = await runRaw(argv, DEFAULT_TIMEOUT, requestId);
      return { text: asText(result.value ?? result.text), isError: !result.ok };
    }
    case "raw_task": {
      const action = String(args.action || "");
      const p = normalizeTaskParams(action, args.params || {});
      const bb = await getBlackboard();
      const { Mailbox } = await import("../dist/mesh/mailbox.js");
      const taskId = p.taskId === undefined || p.taskId === null ? "" : String(p.taskId);

      switch (action) {
        case "create": {
          const creator = String(p.creator || "agent");
          const assignee = String(p.assignee || "all");
          const task = bb.createTask({
            title: String(p.title || "Untitled"),
            creator,
            assignee,
            contextData: p.contextData,
            contractSpec: p.contractSpec,
          });
          // Dispatch notification: a task without an inbox envelope is invisible to poll().
          const notice = bb.postMessage({
            taskId: task.task_id,
            sender: creator,
            recipient: assignee,
            msgType: "task_request",
            payload: {
              title: task.title,
              contextData: p.contextData ?? null,
              contractSpec: p.contractSpec ?? null,
            },
          });
          return {
            text: JSON.stringify({ ...task, envelope: Mailbox.wrapEnvelope(notice, task.title) }, null, 2),
            isError: false,
          };
        }
        case "send": {
          // Ad-hoc agent-to-agent message. Creates a lightweight task only when
          // no taskId was given; a typo must not silently create a ghost task.
          const sender = String(p.sender || "agent");
          const recipient = String(p.recipient || "all");
          const msgType = String(p.msgType || "handoff");
          const payload = p.payload ?? p.text ?? "";
          let task;
          if (taskId) {
            task = bb.getTask(taskId);
            if (!task) {
              return {
                text: `task not found: ${taskId} (omit taskId to start a new thread, or create the task first)`,
                isError: true,
              };
            }
          } else {
            const title =
              String(p.title || (typeof payload === "string" ? payload.slice(0, 60) : "agent message")).trim() ||
              "agent message";
            task = bb.createTask({
              title,
              creator: sender,
              assignee: recipient,
              contextData: p.contextData,
            });
          }
          const msg = bb.postMessage({
            taskId: task.task_id,
            sender,
            recipient,
            msgType,
            payload,
          });
          return {
            text: JSON.stringify({ ok: true, message: msg, envelope: Mailbox.wrapEnvelope(msg, task.title) }, null, 2),
            isError: false,
          };
        }
        case "poll": {
          const recipient = String(p.recipient || "all");
          const msgs = bb.pollInbox(recipient, { unreadOnly: p.unreadOnly !== false });
          const envelopes = msgs.map((m) => {
            const task = m.task_id ? bb.getTask(m.task_id) : null;
            return Mailbox.wrapEnvelope(m, task ? task.title : undefined);
          });
          if (p.markRead === true) {
            for (const m of msgs) bb.markMessageRead(m.msg_id);
          }
          return { text: JSON.stringify({ count: msgs.length, messages: msgs, envelopes }, null, 2), isError: false };
        }
        case "list": {
          const limit = Number(p.limit ?? 20);
          const take = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 500) : 20;
          const tasks = bb.listTasks({
            assignee: p.assignee ? String(p.assignee) : undefined,
            status: p.status ? String(p.status) : undefined,
          });
          return { text: JSON.stringify(tasks.slice(0, take), null, 2), isError: false };
        }
        case "get": {
          if (!taskId) return { text: "raw_task get needs taskId", isError: true };
          const task = bb.getTask(taskId);
          return { text: JSON.stringify(task, null, 2), isError: !task };
        }
        case "update": {
          if (!taskId) return { text: "raw_task update needs taskId", isError: true };
          if (p.status === undefined) return { text: "raw_task update needs status", isError: true };
          const ok = bb.updateTaskStatus(taskId, String(p.status), p.resultData);
          return { text: JSON.stringify({ ok }), isError: !ok };
        }
        case "submit_artifact": {
          if (!taskId) return { text: "raw_task submit_artifact needs taskId", isError: true };
          const art = bb.submitArtifact({
            taskId,
            author: String(p.author || "agent"),
            artifactType: String(p.artifactType || "unified_diff"),
            content: String(p.content ?? ""),
          });
          return { text: JSON.stringify(art, null, 2), isError: false };
        }
        case "verify": {
          if (!taskId) return { text: "raw_task verify needs taskId", isError: true };
          const { runContract } = await import("../dist/verify/runner.js");
          const task = bb.getTask(taskId);
          if (!task) return { text: `task not found: ${taskId}`, isError: true };
          if (!task.contract_spec) return { text: `task ${taskId} has no contract_spec`, isError: true };
          const contract = typeof task.contract_spec === "string" ? JSON.parse(task.contract_spec) : task.contract_spec;
          const verdict = await runContract(contract, p.cwd ? String(p.cwd) : process.cwd());
          bb.updateTaskStatus(task.task_id, verdict.verdict === "verified" ? "completed" : "failed", verdict);
          return { text: JSON.stringify(verdict, null, 2), isError: verdict.verdict !== "verified" };
        }
        default:
          return { text: `unknown raw_task action: ${action}`, isError: true };
      }
    }
    case "raw_term": {
      const p = args.params || {};
      const target = p.target ?? p.targetPane ?? p.target_pane ?? p.pane;
      const taskIdParam = p.taskId ?? p.task_id;
      const session = p.session ?? p.targetSession ?? p.target_session;
      const term = await getTmuxDriver();
      switch (args.action) {
        case "list": {
          if (!(await term.isAvailable())) {
            return {
              text: JSON.stringify(
                { panes: [], note: "tmux has no running server; start one with `tmux new -s work`" },
                null,
                2,
              ),
              isError: false,
            };
          }
          try {
            const panes = await term.listPanes(session ? String(session) : undefined);
            return { text: JSON.stringify(panes, null, 2), isError: false };
          } catch (error) {
            return { text: `could not list tmux panes: ${error?.message ?? error}`, isError: true };
          }
        }
        case "peek": {
          if (!target) return { text: "raw_term peek needs target", isError: true };
          try {
            const output = await term.peekPane(String(target), p.lines);
            return { text: output, isError: false };
          } catch (error) {
            return { text: `could not peek pane ${target}: ${error?.message ?? error}`, isError: true };
          }
        }
        case "wake": {
          if (!target) return { text: "raw_term wake needs target", isError: true };
          if (!taskIdParam) return { text: "raw_term wake needs taskId", isError: true };
          try {
            const ok = await term.wakePane(String(target), String(taskIdParam));
            return { text: JSON.stringify({ ok }), isError: !ok };
          } catch (error) {
            return { text: error?.message ?? String(error), isError: true };
          }
        }
        case "name": {
          if (!target) return { text: "raw_term name needs target", isError: true };
          if (!p.name) return { text: "raw_term name needs name", isError: true };
          try {
            const ok = await term.namePane(String(target), String(p.name));
            return { text: JSON.stringify({ ok }), isError: !ok };
          } catch (error) {
            return { text: error?.message ?? String(error), isError: true };
          }
        }
        default:
          return { text: `unknown raw_term action: ${args.action}`, isError: true };
      }
    }
    default:
      return { text: `unknown tool: ${name}`, isError: true };
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

let queue = Promise.resolve();

async function handle(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    reply(id, {
      protocolVersion: params?.protocolVersion || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "raw-browser", version: "0.8.0" },
    });
    return;
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") {
    if (method === "notifications/cancelled") {
      const target = params?.requestId;
      const child = inFlight.get(target);
      if (child) {
        try { child.kill(); } catch { /* already gone */ }
        inFlight.delete(target);
      }
    }
    return;
  }
  if (method === "ping") {
    reply(id, {});
    return;
  }
  if (method === "tools/list") {
    reply(id, { tools });
    return;
  }
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    let replied = false;
    const respond = (payload) => {
      if (replied) return;
      replied = true;
      reply(id, payload);
    };
    const run = async () => {
      try {
        const result = await callTool(name, args, id);
        const content = [{ type: "text", text: result.text ?? "" }];
        if (result.image) content.push(result.image);
        respond({ content, isError: result.isError === true });
      } catch (error) {
        respond({ content: [{ type: "text", text: String(error?.message || error) }], isError: true });
      }
    };

    if (LOCAL_TOOLS.has(name)) {
      // Local tools talk to SQLite/tmux only, so they must not wait
      // behind a slow browser command (and a wedged one must not block them).
      const timer = setTimeout(
        () => respond({ content: [{ type: "text", text: `${name} timed out after ${LOCAL_TOOL_TIMEOUT_MS}ms` }], isError: true }),
        LOCAL_TOOL_TIMEOUT_MS,
      );
      timer.unref?.();
      run().finally(() => clearTimeout(timer));
      return;
    }

    // Serialize browser tools: one browser, one queue. This also keeps the
    // remembered current tab deterministic.
    queue = queue.then(run);
    await queue;
    return;
  }
  if (id !== undefined && id !== null) replyError(id, -32601, `method not found: ${method}`);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let pending = 0;
let closing = false;
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch (error) {
    process.stderr.write(`raw-browser-mcp: invalid JSON: ${error}\n`);
    return;
  }
  pending += 1;
  Promise.resolve(handle(message))
    .catch((error) => {
      process.stderr.write(`raw-browser-mcp: ${error?.stack || error}\n`);
      if (message.id !== undefined && message.id !== null) {
        replyError(message.id, -32603, String(error?.message || error));
      }
    })
    .finally(() => {
      pending -= 1;
      if (closing && pending === 0) process.exit(0);
    });
});
rl.on("close", () => {
  closing = true;
  if (pending === 0) process.exit(0);
});
