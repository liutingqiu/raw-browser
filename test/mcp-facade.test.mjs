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
  // Keep the test off the developer's real blackboard (and let Windows, where
  // os.homedir() ignores HOME, use its own directory too).
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

test("MCP Facade: serves raw_task and raw_term over stdio JSON-RPC", async () => {
  const client = createMcpClient();

  try {
    // 1. Initialize
    const initRes = await client.call("initialize", { protocolVersion: "2024-11-05" });
    assert.equal(initRes.serverInfo.name, "raw-browser");

    // 2. List tools
    const toolsRes = await client.call("tools/list");
    const toolNames = toolsRes.tools.map((t) => t.name);
    assert.ok(toolNames.includes("raw_task"), "Should expose raw_task");
    assert.ok(toolNames.includes("raw_term"), "Should expose raw_term");

    // 3. Call raw_task create
    const createRes = await client.call("tools/call", {
      name: "raw_task",
      arguments: {
        action: "create",
        params: {
          title: "Verify MCP Facade Integration",
          creator: "test-suite",
          assignee: "codex",
          contractSpec: {
            checks: [{ name: "quick-pass", command: 'node -e "process.exit(0)"' }],
          },
        },
      },
    });

    assert.equal(createRes.isError, false);
    const createdTask = JSON.parse(createRes.content[0].text);
    assert.ok(createdTask.task_id.startsWith("task-"));
    assert.equal(createdTask.title, "Verify MCP Facade Integration");

    // 4. Call raw_task submit_artifact
    const artifactRes = await client.call("tools/call", {
      name: "raw_task",
      arguments: {
        action: "submit_artifact",
        params: {
          taskId: createdTask.task_id,
          author: "claude",
          artifactType: "unified_diff",
          content: "diff --git a/test b/test",
        },
      },
    });

    assert.equal(artifactRes.isError, false);
    const artifact = JSON.parse(artifactRes.content[0].text);
    assert.ok(artifact.artifact_hash.length === 64);

    // 5. Call raw_task verify (arbitrates objective exit code)
    const verifyRes = await client.call("tools/call", {
      name: "raw_task",
      arguments: {
        action: "verify",
        params: {
          taskId: createdTask.task_id,
        },
      },
    });

    assert.equal(verifyRes.isError, false);
    const verdict = JSON.parse(verifyRes.content[0].text);
    assert.equal(verdict.verdict, "verified");
    assert.equal(verdict.passedChecks, 1);

    // 6. Verify task status was updated on blackboard
    const getRes = await client.call("tools/call", {
      name: "raw_task",
      arguments: {
        action: "get",
        params: {
          taskId: createdTask.task_id,
        },
      },
    });
    const finalTask = JSON.parse(getRes.content[0].text);
    assert.equal(finalTask.status, "completed");

  } finally {
    client.close();
  }
});
