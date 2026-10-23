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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TIMEOUT = Number(process.env.RAW_MCP_TIMEOUT_MS || 60_000);

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
    name: "raw_new",
    description: "Open a new tab at a URL, wait for it to load, and make it the current tab.",
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
];

function bridgeArgs() {
  return browser === "chrome" ? ["--chrome"] : [];
}

function runRaw(argv, timeoutMs = DEFAULT_TIMEOUT, requestId) {
  return new Promise((resolve) => {
    const child = spawn(NODE, [RAW_CLI, ...bridgeArgs(), ...argv], {
      windowsHide: true,
      env: { ...process.env, RAW_BRIDGE_BROWSER: browser },
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

function requiredTab(args = {}) {
  return args.tabId ?? currentTabId ?? undefined;
}

async function rememberTab(result) {
  const value = result.value;
  if (value && typeof value === "object") {
    if (value.id !== undefined && value.id !== null) currentTabId = String(value.id);
    else if (value.tabId !== undefined && value.tabId !== null) currentTabId = String(value.tabId);
  }
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
      return { text: result.text, isError: !result.ok };
    }
    case "raw_tabs": {
      const result = await runRaw(["tabs"], DEFAULT_TIMEOUT, requestId);
      if (result.ok && Array.isArray(result.value)) {
        const active = result.value.find((tab) => tab.active);
        currentTabId = active ? String(active.id) : (currentTabId ?? (result.value[0] ? String(result.value[0].id) : null));
      }
      return { text: asText(result.value ?? result.text), isError: !result.ok };
    }
    case "raw_new": {
      const result = await runRaw(["new", String(args.url ?? "about:blank")], DEFAULT_TIMEOUT, requestId);
      await rememberTab(result);
      return { text: asText(result.value ?? result.text), isError: !succeeded(result) };
    }
    case "raw_goto": {
      const tabId = requiredTab(args);
      const argv = ["goto", String(args.url)];
      if (tabId) argv.push(String(tabId));
      const result = await runRaw(argv, DEFAULT_TIMEOUT, requestId);
      await rememberTab(result);
      return { text: asText(result.value ?? result.text), isError: !succeeded(result) };
    }
    case "raw_text": {
      const tabId = requiredTab(args);
      const argv = ["text"];
      if (tabId) argv.push(String(tabId));
      if (args.selector) argv.push(String(args.selector));
      const result = await runRaw(argv, DEFAULT_TIMEOUT, requestId);
      return { text: asText(result.value ?? result.text), isError: !result.ok };
    }
    case "raw_html": {
      const tabId = requiredTab(args);
      const argv = ["html"];
      if (tabId) argv.push(String(tabId));
      if (args.selector) argv.push(String(args.selector));
      const result = await runRaw(argv, DEFAULT_TIMEOUT, requestId);
      return { text: asText(result.value ?? result.text, 50_000), isError: !result.ok };
    }
    case "raw_eval": {
      const tabId = requiredTab(args);
      const argv = ["eval"];
      if (tabId) argv.push(String(tabId));
      argv.push(String(args.expression ?? ""));
      const result = await runRaw(argv, DEFAULT_TIMEOUT, requestId);
      return { text: asText(result.value ?? result.text), isError: !result.ok };
    }
    case "raw_snapshot": {
      const tabId = requiredTab(args);
      const argv = ["snapshot"];
      if (tabId) argv.push(String(tabId));
      const result = await runRaw(argv, DEFAULT_TIMEOUT, requestId);
      const value = result.value;
      const text = value && typeof value === "object" && value.snapshot !== undefined ? value.snapshot : asText(value ?? result.text);
      return { text: asText(text, 30_000), isError: !result.ok };
    }
    case "raw_click": {
      const tabId = requiredTab(args);
      const argv = ["click"];
      if (tabId) argv.push(String(tabId));
      argv.push(String(args.selector));
      const result = await runRaw(argv, DEFAULT_TIMEOUT, requestId);
      return { text: asText(result.value ?? result.text), isError: !result.ok };
    }
    case "raw_fill": {
      const tabId = requiredTab(args);
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
      const tabId = requiredTab(args);
      const argv = ["screenshot"];
      if (tabId) argv.push(String(tabId));
      if (args.out) argv.push(String(args.out));
      const result = await runRaw(argv, DEFAULT_TIMEOUT, requestId);
      if (!result.ok) return { text: asText(result.value ?? result.text), isError: true };
      const saved = result.value?.saved;
      if (saved && fs.existsSync(saved)) {
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
      const tabId = requiredTab(args);
      const argv = ["cookies"];
      if (tabId) argv.push(String(tabId));
      if (args.domain) argv.push(String(args.domain));
      const result = await runRaw(argv, DEFAULT_TIMEOUT, requestId);
      return { text: asText(result.value ?? result.text), isError: !result.ok };
    }
    case "raw_frames": {
      const tabId = requiredTab(args);
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
      serverInfo: { name: "raw-browser", version: "0.6.1" },
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
    // Serialize tool calls: one browser, one queue. This also keeps the
    // remembered current tab deterministic.
    queue = queue.then(async () => {
      try {
        const result = await callTool(name, args, id);
        const content = [{ type: "text", text: result.text ?? "" }];
        if (result.image) content.push(result.image);
        reply(id, { content, isError: result.isError === true });
      } catch (error) {
        reply(id, { content: [{ type: "text", text: String(error?.message || error) }], isError: true });
      }
    });
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
