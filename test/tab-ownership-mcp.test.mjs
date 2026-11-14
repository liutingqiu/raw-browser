import "./_setup.mjs";

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const repo = path.resolve(import.meta.dirname, "..");
const MCP = path.join(repo, "mcp", "raw-browser-mcp.mjs");
const STUB = path.join(repo, "test-support", "stub-bridge.mjs");

function makeWorld() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "raw-tabs-"));
  const stateFile = path.join(home, "tabs.json");
  fs.writeFileSync(
    stateFile,
    JSON.stringify({
      nextId: 1,
      tabs: [{ id: "999", url: "https://human.example/", title: "human tab", active: true }],
    }),
  );
  return { home, stateFile };
}

function client(world, extraEnv = {}) {
  const child = spawn(process.execPath, [MCP], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: world.home,
      USERPROFILE: world.home,
      RAW_HOME: world.home,
      RAW_CLI: STUB,
      STUB_TABS: world.stateFile,
      ...extraEnv,
    },
  });
  const rl = readline.createInterface({ input: child.stdout });
  let id = 1;
  const pending = new Map();
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id && pending.has(message.id)) {
      const resolve = pending.get(message.id);
      pending.delete(message.id);
      resolve(message);
    }
  });
  const call = (method, params = {}) =>
    new Promise((resolve) => {
      const requestId = id++;
      pending.set(requestId, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
    });
  const tool = async (name, args = {}) => {
    const message = await call("tools/call", { name, arguments: args });
    const text = message.result?.content?.[0]?.text ?? "";
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { isError: message.result?.isError, text, data };
  };
  return { call, tool, close: () => child.kill() };
}

async function boot(world, env) {
  const c = client(world, env);
  await c.call("initialize", { protocolVersion: "2024-11-05" });
  return c;
}

test("TabOwnership: claim, list, navigate and close only this agent's tab", async () => {
  const world = makeWorld();
  const a = await boot(world);
  try {
    const claimed = await a.tool("raw_claim", { label: "alpha", url: "https://a.example/" });
    assert.equal(claimed.isError, false);
    assert.equal(claimed.data.tabId, "1");
    assert.equal(claimed.data.label, "alpha");

    const tabs = await a.tool("raw_tabs");
    const human = tabs.data.find((tab) => tab.id === "999");
    assert.equal(human.owned, false);
    assert.equal(human.owner, null);
    assert.equal(tabs.data.find((tab) => tab.id === "1").owned, true);

    // Listing tabs is read-only: the targeted tab must not move to the active one.
    const evaluated = await a.tool("raw_eval", { expression: "1" });
    assert.equal(JSON.parse(evaluated.text).tabId, "1");

    // goto uses the bridge's `goto [tabId] <url>` order.
    const navigated = await a.tool("raw_goto", { url: "https://c.example/" });
    assert.equal(navigated.isError, false);
    assert.equal(navigated.data.tabId, "1");

    const refused = await a.tool("raw_goto", { url: "https://x.example/", tabId: "999" });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /not claimed/);

    const closed = await a.tool("raw_close", { tabId: "1" });
    assert.equal(closed.isError, false);
    assert.deepEqual(closed.data.ownedTabs, []);
  } finally {
    a.close();
  }
});

test("TabOwnership: goto with no claimed tab opens its own instead of using the human's", async () => {
  const world = makeWorld();
  const a = await boot(world);
  try {
    const result = await a.tool("raw_goto", { url: "https://fresh.example/" });
    assert.equal(result.isError, false);
    assert.equal(result.data.tabId, "1");
    assert.equal(result.data.label, "agent");
    const tabs = await a.tool("raw_tabs");
    assert.equal(tabs.data.find((tab) => tab.id === "999").owned, false);
  } finally {
    a.close();
  }
});

test("TabOwnership: a second agent cannot act on or take the first agent's tab", async () => {
  const world = makeWorld();
  const a = await boot(world);
  const b = await boot(world);
  try {
    const claimed = await a.tool("raw_claim", { label: "alpha", url: "https://a.example/" });
    const tabId = claimed.data.tabId;

    const beta = await b.tool("raw_claim", { label: "beta", url: "https://b.example/" });
    assert.equal(beta.data.tabId, "2");

    const denied = await b.tool("raw_click", { selector: "#x", tabId });
    assert.equal(denied.isError, true);
    assert.match(denied.text, /controlled by "alpha"/);

    const takeover = await b.tool("raw_claim", { label: "beta", tabId, force: true });
    assert.equal(takeover.isError, false);

    const lost = await a.tool("raw_eval", { tabId, expression: "1" });
    assert.equal(lost.isError, true);
    assert.match(lost.text, /controlled by "beta"/);
  } finally {
    a.close();
    b.close();
  }
});

test("TabOwnership: renaming an agent keeps its tabs", async () => {
  const world = makeWorld();
  const a = await boot(world);
  try {
    await a.tool("raw_claim", { label: "alpha", url: "https://a.example/" });
    await a.tool("raw_new", { url: "https://b.example/" });
    const renamed = await a.tool("raw_claim", { label: "alpha-2" });
    assert.equal(renamed.isError, false);
    assert.deepEqual(renamed.data.ownedTabs.sort(), ["1", "2", "3"]);
  } finally {
    a.close();
  }
});
