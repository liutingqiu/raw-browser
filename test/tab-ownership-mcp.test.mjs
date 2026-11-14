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
      nextGroupId: 100,
      tabs: [{ id: "999", url: "https://human.example/", title: "human tab", active: true, windowId: 1, groupId: -1 }],
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

test("TabOwnership: another agent's tab is read-only until it is cloned", async () => {
  const world = makeWorld();
  const a = await boot(world);
  const b = await boot(world);
  try {
    const claimed = await a.tool("raw_claim", { label: "alpha", url: "https://a.example/" });
    const tabId = claimed.data.tabId;
    await b.tool("raw_claim", { label: "beta", url: "https://b.example/" });

    // Reading is allowed and names the owner.
    const read = await b.tool("raw_text", { tabId });
    assert.equal(read.isError, false);
    assert.match(read.text, /belongs to "alpha"/);

    // Writing (including eval) is refused with the clone hint.
    for (const tool of ["raw_click", "raw_fill", "raw_eval"]) {
      const args = tool === "raw_click" ? { selector: "#x", tabId }
        : tool === "raw_fill" ? { selector: "#x", value: "v", tabId }
        : { expression: "1", tabId };
      const denied = await b.tool(tool, args);
      assert.equal(denied.isError, true, `${tool} should be refused`);
      assert.match(denied.text, /read-only/);
      assert.match(denied.text, /raw_clone/);
    }

    // Cloning gives beta its own copy to operate on.
    const clone = await b.tool("raw_clone", { tabId });
    assert.equal(clone.isError, false);
    assert.equal(clone.data.sourceTabId, tabId);
    assert.notEqual(clone.data.tabId, tabId);
    const writeCopy = await b.tool("raw_click", { selector: "#x" });
    assert.equal(writeCopy.isError, false);

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

test("MCP raw_run: a snippet drives only this agent's tab", async () => {
  const world = makeWorld();
  const a = await boot(world);
  try {
    await a.tool("raw_claim", { label: "alpha", url: "https://a.example/" });
    const ran = await a.tool("raw_run", {
      code: "const t = await page.text('body'); console.log(t); return page.tabId;",
    });
    assert.equal(ran.isError, false, ran.text);
    assert.match(ran.text, /stub text for tab 1/);
    assert.match(ran.text, /returned: 1/);
  } finally {
    a.close();
  }
});

test("TabOwnership: every claimed tab joins a model-named task group", async () => {
  const world = makeWorld();
  const a = await boot(world);
  try {
    const first = await a.tool("raw_claim", { label: "alpha", group: "task-1", url: "https://a.example/" });
    assert.equal(first.isError, false, first.text);
    assert.equal(first.data.group.grouped, true);
    const groupId = first.data.group.groupId;
    assert.ok(groupId > 0);

    const second = await a.tool("raw_new", { url: "https://b.example/" });
    assert.equal(second.data.group.groupId, groupId, "the second tab joins the same group");

    let tabs = await a.tool("raw_tabs");
    assert.equal(tabs.data.find((tab) => tab.id === first.data.tabId).group, "task-1");
    assert.equal(tabs.data.find((tab) => tab.id === second.data.tabId).group, "task-1");

    // A different task gets its own group.
    const other = await a.tool("raw_claim", { label: "alpha", group: "task-2", url: "https://c.example/" });
    assert.notEqual(other.data.group.groupId, groupId);
    tabs = await a.tool("raw_tabs");
    assert.equal(tabs.data.find((tab) => tab.id === other.data.tabId).group, "task-2");

    // Closing a finished task group removes its tabs only.
    const closed = await a.tool("raw_group", { group: "task-1", close: true });
    assert.equal(closed.isError, false, closed.text);
    assert.equal(closed.data.closed.length, 2);
    const after = await a.tool("raw_tabs");
    assert.ok(!after.data.some((tab) => tab.id === first.data.tabId));
    assert.ok(after.data.some((tab) => tab.id === other.data.tabId));
  } finally {
    a.close();
  }
});
