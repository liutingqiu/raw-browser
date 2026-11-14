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

function createMcpClient() {
  // Give the server its own home so a test never touches the developer's
  // ~/.raw (and so Windows, where os.homedir() ignores HOME, stays isolated).
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "raw-mcp-facade-"));
  const child = spawn(process.execPath, [MCP_SCRIPT], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, HOME: home, USERPROFILE: home, RAW_HOME: home },
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
      // Ignore
    }
  });

  function call(method, params = {}) {
    const id = reqId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  function close() {
    child.kill();
  }

  return { call, close };
}

test("MCP Facade: serves the browser tools over stdio JSON-RPC", async () => {
  const client = createMcpClient();
  try {
    // 1. tools/list works over stdio
    const list = await client.call("tools/list");
    assert.ok(Array.isArray(list.tools), "tools/list should return an array");
    const names = list.tools.map((tool) => tool.name);

    // 2. every tool is a browser tool, and the count matches the facade
    assert.equal(names.length, 27, `expected 27 browser tools, got ${names.length}`);
    for (const required of ["raw_use", "raw_status", "raw_tabs", "raw_claim", "raw_goto", "raw_run", "raw_group", "raw_call"]) {
      assert.ok(names.includes(required), `should expose ${required}`);
    }

    // 3. the multi-agent toolset is gone: this is a browser-only project
    assert.ok(!names.includes("raw_task"), "raw_task must not be exposed");
    assert.ok(!names.includes("raw_term"), "raw_term must not be exposed");
    for (const name of names) {
      assert.ok(name.startsWith("raw_"), `unexpected tool name ${name}`);
    }

    // 4. an unknown tool is an error, not a crash
    const bad = await client.call("tools/call", { name: "raw_task", arguments: { action: "list" } });
    assert.equal(bad.isError, true, "a removed tool should report an error");
  } finally {
    client.close();
  }
});
