import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP_SCRIPT = path.join(HERE, "..", "mcp", "raw-browser-mcp.mjs");

function createClient(homeDir) {
  const child = spawn(process.execPath, [MCP_SCRIPT], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, RAW_HOME: homeDir },
  });
  const rl = readline.createInterface({ input: child.stdout });
  let reqId = 1;
  const pending = new Map();
  rl.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    } catch {
      /* ignore non-protocol lines */
    }
  });
  function call(method, params = {}) {
    const id = reqId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  const exited = new Promise((resolve) => child.once("exit", resolve));
  return {
    call,
    async close() {
      child.kill();
      // Windows keeps the SQLite file locked until the process is really gone.
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
    },
  };
}

async function tool(client, action, params) {
  const res = await client.call("tools/call", {
    name: "raw_task",
    arguments: { action, params },
  });
  return { isError: res.isError, data: JSON.parse(res.content[0].text) };
}

test("raw.mesh mailbox: send, poll, markRead and list over MCP", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "raw-mesh-home-"));
  const client = createClient(home);
  try {
    const init = await client.call("initialize", { protocolVersion: "2024-11-05" });
    assert.equal(init.serverInfo.name, "raw-browser");

    // 1. Ad-hoc send creates a lightweight task and an inbox envelope.
    const sent = await tool(client, "send", {
      sender: "dsh-tech",
      recipient: "codex-gemini",
      text: "novel-rag PR #1 合并了，CI 3.9 是红的，先修矩阵再动检索",
    });
    assert.equal(sent.isError, false);
    assert.equal(sent.data.ok, true);
    assert.ok(sent.data.message.msg_id.startsWith("msg-"));
    assert.match(sent.data.envelope, /from="dsh-tech"/);
    assert.match(sent.data.envelope, /to="codex-gemini"/);

    // 2. Recipient polls and sees it.
    const polled = await tool(client, "poll", { recipient: "codex-gemini" });
    assert.equal(polled.isError, false);
    assert.equal(polled.data.count, 1);
    assert.equal(polled.data.messages[0].sender, "dsh-tech");
    assert.match(polled.data.envelopes[0], /<raw-envelope/);

    // 3. markRead drains the unread inbox.
    await tool(client, "poll", { recipient: "codex-gemini", markRead: true });
    const drained = await tool(client, "poll", { recipient: "codex-gemini" });
    assert.equal(drained.data.count, 0);

    // 4. create() dispatches an inbox notice to the assignee.
    const created = await tool(client, "create", {
      title: "修 CI 3.9 矩阵",
      creator: "dsh-tech",
      assignee: "codex-gemini",
      contextData: { file: ".github/workflows/ci.yml" },
    });
    assert.ok(created.data.task_id.startsWith("task-"));
    assert.match(created.data.envelope, /type="task_request"/);

    const afterCreate = await tool(client, "poll", { recipient: "codex-gemini" });
    assert.equal(afterCreate.data.count, 1);
    assert.equal(afterCreate.data.messages[0].task_id, created.data.task_id);

    // 5. list() filters by assignee.
    const listed = await tool(client, "list", { assignee: "codex-gemini" });
    assert.ok(Array.isArray(listed.data));
    assert.ok(listed.data.some((t) => t.task_id === created.data.task_id));
  } finally {
    await client.close();
    try {
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // A lingering handle must not turn a passing test into a failure.
    }
  }
});
