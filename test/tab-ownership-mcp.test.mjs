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

function makeWorld(permissions) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "raw-tabs-"));
  const stateFile = path.join(home, "tabs.json");
  fs.writeFileSync(
    stateFile,
    JSON.stringify({
      nextId: 1,
      tabs: [{ id: "999", url: "https://human.example/", title: "human tab", active: true }],
    }),
  );
  const env = {};
  if (permissions) {
    const file = path.join(home, "permissions.json");
    fs.writeFileSync(file, JSON.stringify(permissions));
    env.RAW_PERMISSIONS_FILE = file;
  }
  return { home, stateFile, env };
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
      ...world.env,
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

test("TabOwnership: claim, list, navigate and close this agent's tab", async () => {
  const world = makeWorld();
  const a = await boot(world);
  try {
    const claimed = await a.tool("raw_claim", { label: "alpha", url: "https://a.example/" });
    assert.equal(claimed.isError, false);
    assert.equal(claimed.data.tabId, "1");

    // Agent tabs open in the background so the human keeps focus.
    const state = JSON.parse(fs.readFileSync(world.stateFile, "utf8"));
    assert.equal(state.lastBackground, "1");

    const tabs = await a.tool("raw_tabs");
    assert.equal(tabs.data.find((tab) => tab.id === "999").owned, false);
    assert.equal(tabs.data.find((tab) => tab.id === "1").owner, "alpha");

    // Listing tabs is read-only: the targeted tab must not move to the active one.
    const evaluated = await a.tool("raw_eval", { expression: "1" });
    assert.equal(JSON.parse(evaluated.text).tabId, "1");

    const navigated = await a.tool("raw_goto", { url: "https://c.example/" });
    assert.equal(navigated.isError, false);
    assert.equal(navigated.data.tabId, "1");

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
    const tabs = await a.tool("raw_tabs");
    assert.equal(tabs.data.find((tab) => tab.id === "999").owned, false);
  } finally {
    a.close();
  }
});

test("TabOwnership: agents may read and act on each other's tabs when explicit", async () => {
  const world = makeWorld();
  const a = await boot(world);
  const b = await boot(world);
  try {
    const claimed = await a.tool("raw_claim", { label: "alpha", url: "https://a.example/" });
    const tabId = claimed.data.tabId;

    // b opens its own tab and works there unless it names alpha's tab.
    await b.tool("raw_claim", { label: "beta", url: "https://b.example/" });
    const implicit = await b.tool("raw_eval", { expression: "1" });
    assert.equal(JSON.parse(implicit.text).tabId, "2");

    const read = await b.tool("raw_text", { tabId });
    assert.equal(read.isError, false);
    assert.match(read.text, /belongs to "alpha"/);

    const write = await b.tool("raw_click", { selector: "#x", tabId });
    assert.equal(write.isError, false);
    assert.match(write.text, /belongs to "alpha"/);

    // Closing another agent's tab is destructive and needs an explicit force.
    const denied = await b.tool("raw_close", { tabId });
    assert.equal(denied.isError, true);
    assert.match(denied.text, /pass "force": true/);

    const forced = await b.tool("raw_close", { tabId, force: true });
    assert.equal(forced.isError, false);
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

test("OriginPermissions: ask mode blocks until the origin is approved", async () => {
  const world = makeWorld({ defaultAccess: "ask", origins: {} });
  const a = await boot(world);
  try {
    const blocked = await a.tool("raw_claim", { label: "alpha", url: "https://new.example/" });
    assert.equal(blocked.isError, true);
    assert.match(blocked.text, /not approved/);

    const approved = await a.tool("raw_approve", { origin: "https://new.example", scope: "session" });
    assert.equal(approved.isError, false);

    const claimed = await a.tool("raw_claim", { label: "alpha", url: "https://new.example/" });
    assert.equal(claimed.isError, false);
  } finally {
    a.close();
  }
});

test("OriginPermissions: an explicit deny wins over everything", async () => {
  const world = makeWorld({
    defaultAccess: "allow",
    origins: { "https://no.example": { access: "deny" } },
  });
  const a = await boot(world);
  try {
    const blocked = await a.tool("raw_goto", { url: "https://no.example/page" });
    assert.equal(blocked.isError, true);
    assert.match(blocked.text, /blocked/);
  } finally {
    a.close();
  }
});

test("Verify evidence: a verdict carries the page screenshot and URL", async () => {
  const world = makeWorld();
  const a = await boot(world);
  try {
    fs.writeFileSync(path.join(world.home, "ok.mjs"), "process.exit(0);");
    await a.tool("raw_claim", { label: "alpha", url: "https://a.example/" });
    const created = await a.tool("raw_task", {
      action: "create",
      params: {
        title: "evidence",
        creator: "a",
        assignee: "b",
        contractSpec: { checks: [{ command: "node ok.mjs" }] },
      },
    });
    const task = created.data;
    const verified = await a.tool("raw_task", {
      action: "verify",
      params: { taskId: task.task_id, cwd: world.home },
    });
    assert.equal(verified.isError, false, verified.text);
    assert.equal(verified.data.verdict, "verified");
    assert.equal(verified.data.evidence.tabId, "1");
    assert.ok(verified.data.evidence.screenshot.endsWith(`${task.task_id}.png`));
  } finally {
    a.close();
  }
});
