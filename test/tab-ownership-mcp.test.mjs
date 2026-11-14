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


test("MCP compaction: list is summary-only and poll honours a limit", async () => {
  const world = makeWorld();
  const a = await boot(world);
  try {
    const created = await a.tool("raw_task", {
      action: "create",
      params: {
        title: "summary",
        creator: "a",
        assignee: "b",
        contextData: { big: "x".repeat(5000) },
        contractSpec: { checks: [{ command: "node ok.mjs" }] },
      },
    });
    assert.equal(created.isError, false);

    const listed = await a.tool("raw_task", { action: "list", params: {} });
    const entry = listed.data[0];
    assert.equal(entry.has_contract, true);
    assert.equal(entry.has_context, true);
    assert.equal("contract_spec" in entry, false);
    assert.equal("context_data" in entry, false);
    assert.equal("result_data" in entry, false);

    for (const text of ["one", "two", "three"]) {
      await a.tool("raw_task", { action: "send", params: { sender: "a", recipient: "bulk", text } });
    }
    const polled = await a.tool("raw_task", { action: "poll", params: { recipient: "bulk", limit: 1 } });
    assert.equal(polled.data.count, 1);
    assert.equal(polled.data.total, 3);
    assert.equal(polled.data.truncated, true);
  } finally {
    a.close();
  }
});

test("MCP compaction: a noisy check is truncated in the verdict", async () => {
  const world = makeWorld();
  const a = await boot(world);
  try {
    fs.writeFileSync(path.join(world.home, "noisy.mjs"), 'process.stdout.write("x".repeat(10000));');
    const created = await a.tool("raw_task", {
      action: "create",
      params: {
        title: "noisy",
        creator: "a",
        assignee: "b",
        contractSpec: { checks: [{ command: "node noisy.mjs" }] },
      },
    });
    const verified = await a.tool("raw_task", {
      action: "verify",
      params: { taskId: created.data.task_id, cwd: world.home },
    });
    assert.equal(verified.isError, false, verified.text);
    assert.equal(verified.data.results[0].stdout.length, 4000);
    assert.equal(verified.data.results[0].outputTruncated, true);
    assert.ok(verified.text.length < 20000, `verdict text was ${verified.text.length} chars`);
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

test("MCP raw_task: an unknown task says so", async () => {
  const world = makeWorld();
  const a = await boot(world);
  try {
    const got = await a.tool("raw_task", { action: "get", params: { taskId: "task-nope" } });
    assert.equal(got.isError, true);
    assert.match(got.text, /task not found/);
  } finally {
    a.close();
  }
});
