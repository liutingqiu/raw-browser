import "./_setup.mjs";

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { Blackboard, getDefaultDbPath, isTaskStatus } from "../dist/mesh/blackboard.js";
import { Mailbox } from "../dist/mesh/mailbox.js";
import { runContract } from "../dist/verify/runner.js";
import { listPanesArgs } from "../dist/term/tmux-driver.js";
import { normalizeUrl } from "../dist/browser.js";
import { releaseAssetUrls } from "../scripts/install-edge-bridge.mjs";

const here = import.meta.dirname;
const repo = path.resolve(here, "..");
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/* ------------------------------------------------------------------ *
 * verify: timeouts must end the whole process tree, promptly
 * ------------------------------------------------------------------ */

test("Runner: a timed-out check with a long-lived child still resolves", async () => {
  const started = Date.now();
  const verdict = await runContract({
    checks: [{ name: "daemon", command: 'node -e "setInterval(()=>{},1000)"', timeoutMs: 300 }],
  });
  const elapsed = Date.now() - started;

  assert.equal(verdict.verdict, "refuted");
  assert.match(verdict.results[0].error, /timed out/i);
  // The old runner waited for the grandchild to close stdout, i.e. forever.
  assert.ok(elapsed < 5000, `verification took ${elapsed}ms; the timeout did not end it`);
});

test("Runner: a timed-out check does not leave a writing grandchild behind", async () => {
  const dir = tmp("raw-orphan-");
  const marker = path.join(dir, "survived.txt");
  const command = `node -e "setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'x'),1200)"`;

  const verdict = await runContract({ checks: [{ name: "orphan", command, timeoutMs: 300 }] });
  assert.equal(verdict.verdict, "refuted");

  await new Promise((resolve) => setTimeout(resolve, 2000));
  assert.equal(fs.existsSync(marker), false, "the killed check's child process was still running");
});

/* ------------------------------------------------------------------ *
 * verify: protected files
 * ------------------------------------------------------------------ */

function gitAvailable() {
  return spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
}

function makeRepo() {
  const dir = tmp("raw-protected-");
  const run = (args) =>
    spawnSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  run(["init", "-q"]);
  fs.writeFileSync(path.join(dir, "spec.test.mjs"), "// baseline\n");
  run(["add", "."]);
  run(["commit", "-q", "-m", "baseline"]);
  return { dir, run };
}

test("Runner: protected files pass when untouched", async (t) => {
  if (!gitAvailable()) return t.skip("git is not installed");
  const { dir } = makeRepo();
  const verdict = await runContract(
    { checks: [{ command: 'node -e "process.exit(0)"' }], protectedFiles: ["spec.test.mjs"] },
    dir,
  );
  assert.equal(verdict.verdict, "verified");
  assert.equal(verdict.protectedViolation, undefined);
});

test("Runner: refutes a check when a protected test file was edited", async (t) => {
  if (!gitAvailable()) return t.skip("git is not installed");
  const { dir } = makeRepo();
  fs.appendFileSync(path.join(dir, "spec.test.mjs"), "// weakened assertion\n");

  const verdict = await runContract(
    { checks: [{ command: 'node -e "process.exit(0)"' }], protectedFiles: ["spec.test.mjs"] },
    dir,
  );
  assert.equal(verdict.verdict, "refuted");
  assert.match(verdict.protectedViolation ?? "", /modified against HEAD/);
  assert.equal(verdict.passedChecks, 1, "the check itself still ran");
});

test("Runner: refuses a protected file that is not tracked at HEAD", async (t) => {
  if (!gitAvailable()) return t.skip("git is not installed");
  const { dir } = makeRepo();
  fs.writeFileSync(path.join(dir, "extra.test.mjs"), "// new\n");

  const verdict = await runContract(
    { checks: [{ command: 'node -e "process.exit(0)"' }], protectedFiles: ["extra.test.mjs"] },
    dir,
  );
  assert.equal(verdict.verdict, "refuted");
  assert.match(verdict.protectedViolation ?? "", /not tracked at HEAD/);
});

test("Runner: reports a missing protected file", async (t) => {
  if (!gitAvailable()) return t.skip("git is not installed");
  const { dir } = makeRepo();
  const verdict = await runContract(
    { checks: [{ command: 'node -e "process.exit(0)"' }], protectedFiles: ["nope.test.mjs"] },
    dir,
  );
  assert.equal(verdict.verdict, "refuted");
  assert.match(verdict.protectedViolation ?? "", /missing/);
});

/* ------------------------------------------------------------------ *
 * blackboard
 * ------------------------------------------------------------------ */

test("Blackboard: the same artifact content in two tasks does not overwrite", () => {
  const bb = new Blackboard(":memory:");
  const t1 = bb.createTask({ title: "t1", creator: "a", assignee: "b" });
  const t2 = bb.createTask({ title: "t2", creator: "a", assignee: "b" });
  const first = bb.submitArtifact({ taskId: t1.task_id, author: "a", artifactType: "unified_diff", content: "SAME" });
  bb.submitArtifact({ taskId: t2.task_id, author: "b", artifactType: "full_source", content: "SAME" });

  assert.equal(bb.getArtifact(first.artifact_hash, t1.task_id)?.task_id, t1.task_id);
  assert.equal(bb.getArtifact(first.artifact_hash, t2.task_id)?.task_id, t2.task_id);
  assert.equal(bb.listArtifacts(t1.task_id).length, 1);
  assert.equal(bb.listArtifacts(t2.task_id).length, 1);
  bb.close();
});

test("Blackboard: migrates a version-1 database without losing rows", () => {
  const dir = tmp("raw-migrate-");
  const dbPath = path.join(dir, "old.db");
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY, title TEXT NOT NULL, creator TEXT NOT NULL, assignee TEXT NOT NULL,
      status TEXT NOT NULL, context_data TEXT, contract_spec TEXT, result_data TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE artifacts (
      artifact_hash TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL,
      artifact_type TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL
    );
  `);
  legacy.prepare("INSERT INTO tasks VALUES ('t1','old','a','b','dispatched',NULL,NULL,NULL,1,1)").run();
  legacy.prepare("INSERT INTO artifacts VALUES ('abc','t1','a','unified_diff','SAME',1)").run();
  legacy.close();

  const bb = new Blackboard(dbPath);
  assert.equal(bb.schemaVersion(), 2);
  assert.equal(bb.getArtifact("abc", "t1")?.content, "SAME");

  const t2 = bb.createTask({ title: "new", creator: "a", assignee: "b" });
  bb.submitArtifact({ taskId: t2.task_id, author: "b", artifactType: "full_source", content: "SAME" });
  assert.equal(bb.listArtifacts(t2.task_id).length, 1);
  assert.equal(bb.getArtifact("abc", "t1")?.content, "SAME");
  bb.close();
});

test("Blackboard: a second writer waits instead of failing with a locked database", async () => {
  const dir = tmp("raw-busy-");
  const dbPath = path.join(dir, "busy.db");
  const seed = new DatabaseSync(dbPath);
  seed.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);");
  seed.close();

  const bb = new Blackboard(dbPath);

  const holder = path.join(dir, "hold.mjs");
  const marker = path.join(dir, "locked");
  fs.writeFileSync(
    holder,
    `
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[2]);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("BEGIN IMMEDIATE");
db.exec("INSERT INTO t (v) VALUES ('holder')");
fs.writeFileSync(${JSON.stringify(marker)}, "1");
setTimeout(() => { db.exec("COMMIT"); }, Number(process.argv[3]));
`,
  );
  const child = spawn(process.execPath, [holder, dbPath, "1500"], { stdio: "ignore" });

  try {
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(marker)) {
      if (Date.now() > deadline) throw new Error("the helper never acquired the write lock");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const started = Date.now();
    const task = bb.createTask({ title: "concurrent", creator: "a", assignee: "b" });
    const waited = Date.now() - started;
    bb.close();

    assert.ok(task.task_id.startsWith("task-"));
    assert.ok(waited > 200, `the write should have waited for the lock, waited ${waited}ms`);
  } finally {
    child.kill();
  }
});

test("Blackboard: rejects an unknown task status instead of storing it", () => {
  const bb = new Blackboard(":memory:");
  const task = bb.createTask({ title: "t", creator: "a", assignee: "b" });
  assert.equal(isTaskStatus("banana"), false);
  assert.throws(() => bb.updateTaskStatus(task.task_id, "banana"), /invalid task status/);
  assert.throws(() => bb.listTasks({ status: "banana" }), /invalid task status/);
  assert.equal(bb.getTask(task.task_id)?.status, "dispatched");
  bb.close();
});

test("Blackboard: honours RAW_HOME for the default database path", () => {
  const dir = tmp("raw-home-");
  const previous = process.env.RAW_HOME;
  process.env.RAW_HOME = dir;
  try {
    const dbPath = getDefaultDbPath();
    assert.ok(dbPath.startsWith(dir), `${dbPath} is not under ${dir}`);
    assert.equal(path.basename(dbPath), "blackboard.db");
  } finally {
    if (previous === undefined) delete process.env.RAW_HOME;
    else process.env.RAW_HOME = previous;
  }
});

test("Mailbox: envelope parsing round-trips escaped attributes", () => {
  const bb = new Blackboard(":memory:");
  const task = bb.createTask({ title: "t", creator: "a", assignee: "b" });
  const msg = bb.postMessage({
    taskId: task.task_id,
    sender: 'a"&<x>',
    recipient: "b",
    msgType: "handoff",
    payload: "hi",
  });
  const envelope = Mailbox.wrapEnvelope(msg, `title "q" & <t>'`);
  const parsed = Mailbox.parseEnvelopeHeader(envelope);
  assert.equal(parsed.from, 'a"&<x>');
  assert.equal(parsed["task-title"], `title "q" & <t>'`);
  bb.close();
});

/* ------------------------------------------------------------------ *
 * term
 * ------------------------------------------------------------------ */

test("TmuxDriver: a session listing does not fall back to all panes", () => {
  const all = listPanesArgs();
  const scoped = listPanesArgs("alpha");
  assert.ok(all.includes("-a"));
  assert.equal(scoped.includes("-a"), false, "-a overrides -t and leaks every session");
  assert.deepEqual(scoped.slice(0, 3), ["-s", "-t", "alpha"]);
});

/* ------------------------------------------------------------------ *
 * raw-bridge keeps the runtime's URL handling
 * ------------------------------------------------------------------ */

test("raw-bridge: normalizeUrl matches the browser runtime", () => {
  const source = fs.readFileSync(path.join(repo, "scripts", "raw-bridge.mjs"), "utf8");
  const match = source.match(/function normalizeUrl\(value\) \{[\s\S]*?\n\}/);
  assert.ok(match, "raw-bridge.mjs no longer defines normalizeUrl");
  const bridgeNormalize = vm.runInNewContext(`(${match[0]})`);

  for (const input of ["example.com", "https://example.com", "file:///tmp/a", "about:blank", "", "HTTP://X", "data:text/plain,hi"]) {
    assert.equal(bridgeNormalize(input), normalizeUrl(input), `disagreement on ${JSON.stringify(input)}`);
  }
});

/* ------------------------------------------------------------------ *
 * paths
 * ------------------------------------------------------------------ */

test("paths: keeps an existing legacy profile directory", () => {
  const rawHome = path.join(tmp("raw-paths-"), ".raw");
  fs.mkdirSync(path.join(rawHome, "codex-browser-profile"), { recursive: true });
  const pathsUrl = pathToFileURL(path.join(repo, "dist", "paths.js")).href;
  const probe = `import(${JSON.stringify(pathsUrl)}).then((m) => process.stdout.write(m.BROWSER_PROFILE))`;
  const result = spawnSync(process.execPath, ["-e", probe], {
    encoding: "utf8",
    env: { ...process.env, RAW_HOME: rawHome, RAW_BROWSER_PROFILE: "", RAW_DOWNLOAD_DIR: "" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.endsWith("codex-browser-profile"), result.stdout);
});

test("paths: prefers the current profile name on a fresh install", () => {
  const rawHome = path.join(tmp("raw-paths-new-"), ".raw");
  const pathsUrl = pathToFileURL(path.join(repo, "dist", "paths.js")).href;
  const probe = `import(${JSON.stringify(pathsUrl)}).then((m) => process.stdout.write(m.BROWSER_PROFILE))`;
  const result = spawnSync(process.execPath, ["-e", probe], {
    encoding: "utf8",
    env: { ...process.env, RAW_HOME: rawHome, RAW_BROWSER_PROFILE: "", RAW_DOWNLOAD_DIR: "" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, path.join(rawHome, "browser-profile"));
});

/* ------------------------------------------------------------------ *
 * installer
 * ------------------------------------------------------------------ */

test("installer: falls back to the latest release when the version is unpublished", () => {
  const urls = releaseAssetUrls("https://github.com/o/r/releases/download", "0.8.0", "host.tar.gz");
  assert.deepEqual(urls, [
    "https://github.com/o/r/releases/download/v0.8.0/host.tar.gz",
    "https://github.com/o/r/releases/download/latest/download/host.tar.gz",
  ]);
  assert.equal(releaseAssetUrls("https://x/download/", "1.0.0", "a.zip").length, 2);
});

/* ------------------------------------------------------------------ *
 * MCP facade
 * ------------------------------------------------------------------ */

function mcpClient(home) {
  const child = spawn(process.execPath, [path.join(repo, "mcp", "raw-browser-mcp.mjs")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, HOME: home, RAW_HOME: home },
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
  const task = async (action, params) => {
    const message = await call("tools/call", { name: "raw_task", arguments: { action, params } });
    const text = message.result?.content?.[0]?.text ?? "";
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { isError: message.result?.isError, text, data };
  };
  return { call, task, close: () => child.kill() };
}

test("MCP raw_task: accepts snake_case aliases that used to be dropped", async () => {
  const home = tmp("raw-mcp-alias-");
  const client = mcpClient(home);
  try {
    await client.call("initialize", { protocolVersion: "2024-11-05" });
    const created = await client.task("create", {
      title: "alias",
      creator: "a",
      assignee: "b",
      contract_spec: { checks: [{ command: 'node -e "process.exit(0)"' }] },
    });
    assert.equal(created.isError, false);
    assert.ok(created.data.contract_spec, "contract_spec was silently dropped");
    assert.match(created.data.contract_spec, /checks/);
  } finally {
    client.close();
  }
});

test("MCP raw_task: refuses unknown parameters instead of ignoring them", async () => {
  const home = tmp("raw-mcp-unknown-");
  const client = mcpClient(home);
  try {
    await client.call("initialize", { protocolVersion: "2024-11-05" });
    const created = await client.task("create", { title: "x", creator: "a", assignee: "b", nonsense: 1 });
    assert.equal(created.isError, true);
    assert.match(created.text, /unknown parameter/i);
  } finally {
    client.close();
  }
});

test("MCP raw_task: a bad taskId does not create a ghost task", async () => {
  const home = tmp("raw-mcp-ghost-");
  const client = mcpClient(home);
  try {
    await client.call("initialize", { protocolVersion: "2024-11-05" });
    const sent = await client.task("send", { sender: "a", recipient: "b", taskId: "task-missing", text: "hi" });
    assert.equal(sent.isError, true);
    assert.match(sent.text, /task not found/);

    const listed = await client.task("list", {});
    assert.equal(listed.data.length, 0, "a mistyped taskId must not create a task");
  } finally {
    client.close();
  }
});

test("MCP raw_task: validates status and bounds the list limit", async () => {
  const home = tmp("raw-mcp-validation-");
  const client = mcpClient(home);
  try {
    await client.call("initialize", { protocolVersion: "2024-11-05" });
    const created = await client.task("create", { title: "x", creator: "a", assignee: "b" });
    const taskId = created.data.task_id;

    const bad = await client.task("update", { taskId, status: "banana" });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /invalid task status/);

    const after = await client.task("get", { taskId });
    assert.equal(after.data.status, "dispatched");

    const listed = await client.task("list", { limit: "abc" });
    assert.equal(listed.isError, false);
    assert.equal(listed.data.length, 1, "a non-numeric limit must not hide every task");
  } finally {
    client.close();
  }
});

test("MCP raw_term: a missing tmux server is an empty list, not a crash", async () => {
  const home = tmp("raw-mcp-term-");
  const client = mcpClient(home);
  try {
    await client.call("initialize", { protocolVersion: "2024-11-05" });
    const message = await client.call("tools/call", { name: "raw_term", arguments: { action: "list", params: {} } });
    assert.equal(message.result.isError, false);
    const data = JSON.parse(message.result.content[0].text);
    assert.ok(Array.isArray(data.panes), "raw_term list should always answer with a panes array");
  } finally {
    client.close();
  }
});
