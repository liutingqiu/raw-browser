/**
 * Integration smoke test for the native bridge host.
 *
 * Starts a renamed copy of the built host so it cannot retire the user's live
 * bridge, feeds it a fake native `hello`, and checks the HTTP facade. Both
 * browser modes are covered with their own config file and port.
 *
 *   node scripts/smoke-bridge.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = path.join(repo, "edge-bridge", "host", "bin", "Release", "net9.0");
const hostName = process.platform === "win32" ? "raw-edge-bridge.exe" : "raw-edge-bridge";
const builtHost = process.env.RAW_BRIDGE_HOST
  ? path.resolve(process.env.RAW_BRIDGE_HOST)
  : path.join(buildDir, hostName);

if (!fs.existsSync(builtHost)) {
  console.error(`bridge host not built: ${builtHost}\nrun: dotnet publish edge-bridge/host/RawEdgeBridge.csproj -c Release`);
  process.exit(1);
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function request(port, pathname, { token, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: pathname, headers: { ...(token ? { "X-Raw-Bridge-Token": token } : {}), ...headers } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function waitFor(fn, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw last ?? new Error("condition not met");
}

function frame(message) {
  const payload = Buffer.from(JSON.stringify(message));
  const size = Buffer.alloc(4);
  size.writeInt32LE(payload.length, 0);
  return Buffer.concat([size, payload]);
}

async function runMode({ kind, port, token, versionField }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `raw-bridge-smoke-${kind}-`));
  const smokeName = `raw-${kind}-bridge-smoke${process.platform === "win32" ? ".exe" : ""}`;
  const exe = path.join(root, smokeName);
  const sourceDir = path.dirname(builtHost);
  const sourceName = path.basename(builtHost);
  const sourceStem = sourceName.replace(/\.exe$/i, "");
  const files = fs.readdirSync(sourceDir).filter((file) =>
    file.startsWith(sourceStem) && fs.statSync(path.join(sourceDir, file)).isFile()
  );
  for (const file of files) {
    const source = path.join(sourceDir, file);
    const target = path.join(root, file === sourceName ? smokeName : file);
    fs.copyFileSync(source, target);
    if (file === sourceName) {
      try { fs.chmodSync(target, 0o755); } catch { /* Windows */ }
    }
  }
  if (!fs.existsSync(exe)) throw new Error(`could not stage the bridge host from ${builtHost}`);
  const configName = kind === "chrome" ? "chrome-bridge.json" : "edge-bridge.json";
  fs.writeFileSync(path.join(root, configName), JSON.stringify({ version: 1, token, port }));

  const child = spawn(exe, [], {
    cwd: root,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, RAW_HOME: root, RAW_BRIDGE_LOG: "0" },
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  try {
    let version;
    try {
      version = await waitFor(async () => {
        const response = await request(port, "/json/version", { token });
        if (response.status !== 200) return null;
        return JSON.parse(response.body);
      });
    } catch (error) {
      const detail = stderr.trim() ? `\nhost stderr:\n${stderr.trim()}` : "";
      throw new Error(`${error?.message ?? error}${detail}`);
    }
    if (!String(version.Browser).startsWith(versionField)) {
      throw new Error(`unexpected Browser field: ${version.Browser}`);
    }

    child.stdin.write(frame({
      kind: "hello",
      extensionId: "smoke",
      version: "0.5.0",
      protocolVersion: "1",
      userAgent: `RawSmoke/${kind}`,
    }));
    const withHello = await waitFor(async () => {
      const response = await request(port, "/json/version", { token });
      const value = JSON.parse(response.body);
      return value["User-Agent"] === `RawSmoke/${kind}` ? value : null;
    });
    if (withHello["Raw-Extension-Version"] !== "0.5.0") throw new Error("hello version was not recorded");

    const protocol = await request(port, "/json/protocol", { token });
    if (protocol.status !== 200 || !JSON.parse(protocol.body).version) throw new Error("/json/protocol is missing");

    const unauthorized = await request(port, "/json/version");
    if (unauthorized.status !== 401) throw new Error(`unauthorized request returned ${unauthorized.status}`);

    const badHost = await request(port, "/json/version", { token, headers: { Host: "evil.example" } });
    if (badHost.status !== 400) throw new Error(`non-loopback Host returned ${badHost.status}`);

    console.log(`${kind} host smoke passed on ${port}`);
  } finally {
    try { child.stdin.end(); } catch { /* already closed */ }
    try { child.kill(); } catch { /* already gone */ }
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(resolve, 2_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    if (stderr.trim()) console.error(stderr.trim());
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt === 19) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
}

await runMode({ kind: "edge", port: await freePort(), token: "smoke-edge-token", versionField: "RawEdgeBridge/" });
await runMode({ kind: "chrome", port: await freePort(), token: "smoke-chrome-token", versionField: "RawChromeBridge/" });
console.log("bridge host smoke passed");
