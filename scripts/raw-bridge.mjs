#!/usr/bin/env node
/**
 * raw-bridge - drive your own browser from any shell, without starting a full
 * agent session.
 *
 * The Edge extension bridge already speaks CDP on 127.0.0.1:9333 and the
 * extension exposes its own extension-only surfaces on top of it. This script
 * is a thin, dependency-free client for both, so any session, script or human
 * reaches the same logged-in browser the raw agent uses.
 *
 *   node raw-bridge.mjs status
 *   node raw-bridge.mjs tabs
 *   node raw-bridge.mjs goto 123 https://example.com
 *   node raw-bridge.mjs eval 123 "document.title"
 *   node raw-bridge.mjs snapshot 123
 *   node raw-bridge.mjs cookies example.com
 *   node raw-bridge.mjs call Raw.proxyGet
 *
 * Every command prints JSON, so a caller can parse it instead of scraping
 * prose. Exit code is 0 on success and 1 on any failure.
 *
 * Note: `cookies` and `eval` return whatever the page holds, which can include
 * live session material. That is the point of the tool, but treat the output
 * as a secret when you redirect it anywhere.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const isChromeTarget = process.argv.includes("--chrome") ||
  stringEq(process.env.RAW_BRIDGE_BROWSER, "chrome");
function stringEq(a, b) { return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase(); }

const DEFAULT_CONFIG_FILE = isChromeTarget ? "chrome-bridge.json" : "edge-bridge.json";
const CONFIG = process.env.RAW_BRIDGE_CONFIG || path.join(os.homedir(), ".raw", DEFAULT_CONFIG_FILE);
const TIMEOUT_MS = Number(process.env.RAW_BRIDGE_TIMEOUT_MS ?? 45_000);

function readConfig() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(CONFIG, "utf8").replace(/^﻿/, ""));
  } catch {
    throw new Error(
      `no bridge config at ${CONFIG}. Install the extension bridge first (see scripts/install-edge-bridge.ps1).`,
    );
  }
  if (typeof parsed.token !== "string" || parsed.token.length === 0) {
    throw new Error(`bridge config at ${CONFIG} has no token`);
  }
  return { token: parsed.token, port: Number(parsed.port) || (isChromeTarget ? 9334 : 9333) };
}

const config = readConfig();
const base = `http://127.0.0.1:${config.port}`;
const authHeaders = { "X-Raw-Bridge-Token": config.token };

async function http(pathname, init = {}) {
  const response = await fetch(`${base}${pathname}`, {
    ...init,
    headers: { ...authHeaders, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`${pathname} returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** close a WebSocket and wait for the close handshake, so process.exit()
 * does not tear down a libuv handle that is still closing. */
function closeWebSocket(socket) {
  return new Promise((resolve) => {
    if (!socket || socket.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, 500);
    socket.addEventListener("close", done, { once: true });
    try {
      socket.close();
    } catch {
      done();
    }
  });
}

/** open a CDP-over-WebSocket channel: /devtools/browser/... or /devtools/page/{id} */
function openSocket(kind, tabId) {
  const route = kind === "browser" ? "/devtools/browser/raw-edge" : `/devtools/page/${encodeURIComponent(tabId)}`;
  const url = `${base.replace("http", "ws")}${route}?token=${encodeURIComponent(config.token)}`;
  const socket = new WebSocket(url);
  let counter = 0;
  const pending = new Map();
  const listeners = new Map();

  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (message.method) {
      for (const listener of listeners.get(message.method) ?? []) {
        try {
          listener(message.params);
        } catch {
          /* one listener must not break the socket */
        }
      }
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
    else entry.resolve(message.result);
  });

  const ready = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", () => reject(new Error(`cannot reach the bridge on port ${config.port}`)));
  });

  const send = async (method, params = {}) => {
    await ready;
    const id = ++counter;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`${method} timed out after ${TIMEOUT_MS}ms`));
      }, TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  };

  const on = (method, listener) => {
    let set = listeners.get(method);
    if (!set) listeners.set(method, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  };

  return { send, on, close: () => closeWebSocket(socket), ready };
}

/** Run an expression, allowing top-level await and returning its value. */
async function evaluateChannel(channel, expression, opts = {}) {
  const wrapped = `(async () => { return (${expression}); })()`;
  const run = async (source) => channel.send("Runtime.evaluate", {
    expression: source,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  let result = await run(wrapped);
  // A statement (rather than an expression) only compiles in the raw form.
  if (result?.exceptionDetails && /SyntaxError/.test(result.exceptionDetails.text ?? "")) {
    result = await run(expression);
  }
  if (result?.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "evaluation failed");
  }
  if (result?.result && "unserializableValue" in result.result && result.result.unserializableValue !== undefined) {
    return result.result.unserializableValue;
  }
  return result?.result?.value;
}

/** Wait for a load, or for a same-document navigation, instead of sleeping. */
function waitForLoad(channel, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    let done = false;
    const offLoad = channel.on("Page.loadEventFired", finish);
    const offWithin = channel.on("Page.navigatedWithinDocument", finish);
    const timer = setTimeout(finish, timeoutMs);
    function finish() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      offLoad();
      offWithin();
      resolve();
    }
  });
}

const HELPERS_PATH = new URL("../src/page-helpers.js", import.meta.url);
let helpersSource = null;

/**
 * Install the same locator/rich-editor engine the runtime uses, so the CLI
 * and MCP tools do not silently lag behind page.setValue().
 */
async function ensureHelpers(channel) {
  const present = await channel.send("Runtime.evaluate", {
    expression: "typeof window.__mai !== 'undefined'",
    returnByValue: true,
  });
  if (present?.result?.value === true) return;
  if (helpersSource === null) {
    helpersSource = fs.readFileSync(HELPERS_PATH, "utf8");
  }
  await channel.send("Runtime.evaluate", { expression: helpersSource, returnByValue: true, awaitPromise: true });
}

async function withPage(tabId, fn) {
  const channel = openSocket("page", await resolveTab(tabId));
  try {
    return await fn(channel);
  } finally {
    await channel.close();
  }
}

async function callBrowser(method, params = {}) {
  const channel = openSocket("browser");
  try {
    return await channel.send(method, params);
  } finally {
    await channel.close();
  }
}

async function callPage(tabId, method, params = {}) {
  const channel = openSocket("page", tabId);
  try {
    return await channel.send(method, params);
  } finally {
    await channel.close();
  }
}

async function evaluate(tabId, expression) {
  return await withPage(tabId, (channel) => evaluateChannel(channel, expression));
}

/** pick a tab: the given id, or the active one */
async function resolveTab(explicit) {
  if (explicit !== undefined && explicit !== "") return String(explicit);
  const targets = await http("/json/list");
  const active = targets.find((target) => target.active) ?? targets[0];
  if (!active) throw new Error("no open tab to work with");
  return String(active.id);
}

const commands = {
  async status() {
    const version = await http("/json/version");
    return {
      bridge: version.Browser,
      protocol: version["Protocol-Version"],
      extension: version["Raw-Extension-Version"],
      port: config.port,
    };
  },

  async tabs() {
    const targets = await http("/json/list");
    return targets.map((target) => ({
      id: target.id,
      title: target.title,
      url: target.url,
      active: target.active === true,
    }));
  },

  async new(url = "about:blank") {
    // Open blank and navigate afterwards: creating the tab at the target URL
    // races the first evaluate ("Execution context was destroyed").
    const target = await http("/json/new?about%3Ablank", { method: "PUT" });
    const id = String(target.id);
    if (url && url !== "about:blank") {
      await withPage(id, async (channel) => {
        await channel.send("Page.enable");
        const loaded = waitForLoad(channel, 30_000);
        const result = await channel.send("Page.navigate", { url: String(url) }, 30_000);
        if (result?.errorText) throw new Error(`navigation failed: ${result.errorText}`);
        await loaded;
      });
    }
    const targets = await http("/json/list");
    const tab = Array.isArray(targets) ? targets.find((item) => item.id === id) : null;
    return { id, url: tab?.url ?? url, title: tab?.title ?? "" };
  },

  async close(tabId) {
    const id = await resolveTab(tabId);
    // the extension host exposes tab lifecycle over HTTP, not as a Raw.* method
    await http(`/json/close/${encodeURIComponent(id)}`, { method: "PUT" });
    return { closed: id };
  },

  async goto(tabId, url) {
    const id = await resolveTab(tabId);
    return await withPage(id, async (channel) => {
      await channel.send("Page.enable");
      const loaded = waitForLoad(channel, 30_000);
      const result = await channel.send("Page.navigate", { url: String(url) }, 30_000);
      if (result?.errorText) throw new Error(`navigation failed: ${result.errorText}`);
      await loaded;
      const href = await evaluateChannel(channel, "location.href");
      return { tabId: id, url: href };
    });
  },

  async eval(tabId, expression) {
    return await evaluate(await resolveTab(tabId), expression);
  },

  async title(tabId) {
    return await evaluate(await resolveTab(tabId), "document.title");
  },

  async url(tabId) {
    return await evaluate(await resolveTab(tabId), "location.href");
  },

  async text(tabId, selector) {
    const id = await resolveTab(tabId);
    return await withPage(id, async (channel) => {
      await ensureHelpers(channel);
      const expression = selector
        ? `(() => { const el = window.__mai.find(${JSON.stringify(selector)}); return el ? (el.innerText || el.textContent || '') : null; })()`
        : "document.body ? document.body.innerText : ''";
      return await evaluateChannel(channel, expression);
    });
  },

  async html(tabId, selector) {
    const id = await resolveTab(tabId);
    return await withPage(id, async (channel) => {
      await ensureHelpers(channel);
      const expression = selector
        ? `(() => { const el = window.__mai.find(${JSON.stringify(selector)}); return el ? el.outerHTML : null; })()`
        : "document.documentElement.outerHTML";
      const value = await evaluateChannel(channel, expression);
      return typeof value === "string" ? value.slice(0, 50_000) : value;
    });
  },

  /** a compact, numbered list of interactive elements plus page text */
  async snapshot(tabId) {
    const id = await resolveTab(tabId);
    return await withPage(id, async (channel) => {
      await ensureHelpers(channel);
      const snapshot = await evaluateChannel(
        channel,
        "window.__mai.snapshot({ scope: 'full' })",
      );
      const title = await evaluateChannel(channel, "document.title");
      const url = await evaluateChannel(channel, "location.href");
      const elements = [...String(snapshot).matchAll(/^\[(\d+)\] (\w+)(?::(\w+))? "(.*)"$/gm)].map((match) => ({
        index: Number(match[1]),
        tag: match[2],
        type: match[3] ?? "",
        label: match[4],
      }));
      return { title, url, elements, snapshot };
    });
  },

  async click(tabId, selector) {
    const id = await resolveTab(tabId);
    return await withPage(id, async (channel) => {
      await ensureHelpers(channel);
      const point = await evaluateChannel(
        channel,
        `(() => { const el = window.__mai.find(${JSON.stringify(selector)}); if (!el) return null;
          const r = window.__mai.rect(el);
          return { x: Math.round(r.x), y: Math.round(r.y) }; })()`,
      );
      if (!point) throw new Error(`element not found: ${selector}`);
      for (const type of ["mousePressed", "mouseReleased"]) {
        await channel.send("Input.dispatchMouseEvent", {
          type,
          x: point.x,
          y: point.y,
          button: "left",
          buttons: type === "mousePressed" ? 1 : 0,
          clickCount: 1,
        });
      }
      return { clicked: selector, at: point };
    });
  },

  async fill(tabId, selector, value) {
    const id = await resolveTab(tabId);
    return await withPage(id, async (channel) => {
      await ensureHelpers(channel);
      const written = await evaluateChannel(
        channel,
        `window.__mai.setValue(${JSON.stringify(selector)}, ${JSON.stringify(value ?? "")}, { notifyChange: true })`,
      );
      if (!written || !written.ok) {
        throw new Error(written?.detail ?? `element not found: ${selector}`);
      }
      return { filled: selector, length: written.length, strategy: written.strategy };
    });
  },

  /** open a throwaway tab, navigate, read, and close it in one attach */
  async visit(url, expression, waitArg) {
    const created = await http("/json/new?about%3Ablank", { method: "PUT" });
    const id = String(created.id);
    try {
      const page = await withPage(id, async (channel) => {
        await channel.send("Page.enable");
        const loaded = waitForLoad(channel, Number(waitArg) || 15_000);
        const result = await channel.send("Page.navigate", { url: String(url) }, 30_000);
        if (result?.errorText) throw new Error(`navigation failed: ${result.errorText}`);
        await loaded;
        await ensureHelpers(channel);
        return await evaluateChannel(channel, expression || "({ title: document.title, url: location.href })");
      });
      const targets = await http("/json/list");
      const mine = Array.isArray(targets) ? targets.find((tab) => tab.id === id) : null;
      return { page, browser: { title: mine?.title ?? "", url: mine?.url ?? "" } };
    } finally {
      try {
        await http(`/json/close/${id}`, { method: "PUT" });
      } catch {
        /* a leaked tab is worth less than the answer */
      }
    }
  },

  async screenshot(tabId, target) {
    const id = await resolveTab(tabId);
    const result = await callPage(id, "Page.captureScreenshot", { format: "png", fromSurface: true });
    const file = path.resolve(target ?? `raw-shot-${Date.now()}.png`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(result.data, "base64"));
    return { saved: file, bytes: fs.statSync(file).size };
  },

  async cookies(_tabId, domain) {
    const details = domain ? { domain } : {};
    const list = await callBrowser("Raw.cookiesAll", { details });
    return list.map((cookie) => ({ name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly, expires: cookie.expirationDate }));
  },

  async proxy(_tabId, action, mode) {
    if (action === "set") return await callBrowser("Raw.proxySet", { value: { mode } });
    if (action === "clear") return await callBrowser("Raw.proxyClear", {});
    return await callBrowser("Raw.proxyGet", {});
  },

  async history(_tabId, text) {
    const items = await callBrowser("Raw.historySearch", { query: { text: text ?? "", maxResults: 50 } });
    return items.map((item) => ({ url: item.url, title: item.title, lastVisit: item.lastVisitTime, visits: item.visitCount }));
  },

  async bookmarks() {
    return await callBrowser("Raw.bookmarksList", {});
  },

  async extensions() {
    return await callBrowser("Raw.managementList", {});
  },

  async frames(tabId) {
    const id = await resolveTab(tabId);
    return await callBrowser("Raw.frames", { tabId: Number(id) });
  },

  async notify(_tabId, title, message) {
    return await callBrowser("Raw.notify", { title: title ?? "raw", message: message ?? "" });
  },

  /** escape hatch: any Raw.* or CDP method, with a JSON params argument */
  async call(method, rawParams) {
    if (!method) throw new Error("call needs a method name");
    const params = rawParams ? JSON.parse(rawParams) : {};
    return await callBrowser(method, params);
  },
};

function usage() {
  console.log(`raw-bridge <command> [args]

  status                          bridge and extension version
  tabs                            list open tabs
  new [url]                       open a tab
  close [tabId]                   close a tab
  goto [tabId] <url>              navigate
  eval [tabId] <js>               run JavaScript in the page
  title | url [tabId]             page title or URL
  text [tabId] [selector]         read text
  html [tabId] [selector]         read HTML
  snapshot [tabId]                numbered elements plus page text
  click [tabId] <selector>        click an element
  fill [tabId] <selector> <value> write into a field
  visit <url> [expr] [waitMs]     open, read and close a throwaway tab
  screenshot [tabId] [file.png]   save a PNG
  cookies [domain]                list cookies (values included)
  proxy [get|set <mode>|clear]    read or switch the proxy
  history [text]                  search browsing history
  bookmarks                       bookmark tree
  extensions                      installed extensions
  frames [tabId]                  iframes, cross-origin included
  notify <title> <message>        system notification
  call <method> [jsonParams]      any Raw.* or CDP method

Tab ids come from \`tabs\`; omit one to use the active tab.
Pass --chrome (or set RAW_BRIDGE_BROWSER=chrome) for the Chrome bridge.`);
}

const rawCliArgs = process.argv.slice(2).filter((arg) => arg !== "--chrome");
const [command, ...args] = rawCliArgs;

// a leading numeric tabId is optional for the tab-scoped commands
const TAB_SCOPED = new Set(["goto", "eval", "title", "url", "text", "html", "snapshot", "click", "fill", "screenshot", "cookies", "proxy", "history", "frames", "notify"]);

if (!command || command === "help" || command === "--help" || command === "-h") {
  usage();
  process.exit(command ? 0 : 1);
}

const handler = commands[command];
if (!handler) {
  console.error(`unknown command: ${command}\n`);
  usage();
  process.exit(1);
}

let argv = [...args];
let tabId;
if (TAB_SCOPED.has(command) && argv.length && /^\d+$/.test(argv[0])) {
  tabId = argv.shift();
}

try {
  const result = TAB_SCOPED.has(command)
    ? await handler(tabId, ...argv)
    : await handler(...argv);
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exit(1);
}
