#!/usr/bin/env node
/**
 * Drives demo/dashboard.html with the raw runtime, captures frames, and
 * encodes assets/demo.gif + assets/demo.mp4.
 *
 *   node scripts/demo.mjs              # visible browser
 *   node scripts/demo.mjs --headless   # for CI / asset generation
 *   node scripts/demo.mjs --keep       # keep the captured frames
 *
 * The demo uses the direct-CDP mode with its own profile, so it never touches
 * the browser profile selected in ~/.raw/browser-profiles/current.json.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DEMO = path.join(ROOT, "demo");
const FRAMES = path.join(DEMO, ".frames");
const ASSETS = path.join(ROOT, "assets");

const args = process.argv.slice(2);
const headless = args.includes("--headless");
const keep = args.includes("--keep");
const width = 1400;
const height = 1000;

function fail(message) {
  console.error(`demo: ${message}`);
  process.exit(1);
}

function serveDemo() {
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
  };
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const file = path.resolve(DEMO, `.${rel === "/" ? "/dashboard.html" : rel}`);
    if (!file.startsWith(DEMO + path.sep)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    fs.readFile(file, (error, data) => {
      if (error) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function pageScript({ url, frames, width, height }) {
  return `
const ui = await page.newTab(${JSON.stringify(url)});
await ui.cdpSend('Emulation.setDeviceMetricsOverride', {
  width: ${width}, height: ${height}, deviceScaleFactor: 1, mobile: false,
});
await ui.sleep(450);

const FRAMES = ${JSON.stringify(frames)};
const timings = [];
let frameNo = 0;
async function snap() {
  const file = FRAMES + '/frame-' + String(frameNo++).padStart(4, '0') + '.jpg';
  timings.push(Date.now());
  await ui.screenshot({ path: file, format: 'jpeg', quality: 88, inline: false });
}
async function hold(frames, ms) {
  for (let i = 0; i < frames; i++) { await snap(); await sleep(ms); }
}
async function moveTo(selector, steps = 9) {
  const info = await ui.find(selector);
  if (!info) throw new Error('demo: element not found: ' + selector);
  const target = info.box;
  const start = await ui.eval('window.__demoPos || { x: 120, y: 120 }');
  for (let i = 1; i <= steps; i++) {
    const x = start.x + (target.x - start.x) * i / steps;
    const y = start.y + (target.y - start.y) * i / steps;
    await ui.eval('window.__demoCursor(' + x + ',' + y + '); window.__demoPos = { x: ' + x + ', y: ' + y + ' }');
    await sleep(50);
    await snap();
  }
  await ui.sleep(120);
  await snap();
  return target;
}
async function clickAt(selector, line) {
  if (line) await ui.eval('window.__demoScript(' + line + ')');
  const target = await moveTo(selector);
  await ui.eval('window.__demoClick(' + target.x + ',' + target.y + ')');
  await ui.click(selector);
  await snap();
}

await hold(4, 100);
await ui.eval('window.__demoScript(1)');
await hold(6, 100);
const snapshot = await ui.snapshot({ scope: 'viewport' });
const elements = snapshot.split('\\n').filter((line) => /^\\[\\d+\\]/.test(line)).length;
console.log('snapshot: ' + elements + ' interactive elements, ' + snapshot.length + ' chars');
await ui.eval('window.__demoLog(' + JSON.stringify('snapshot · ' + elements + ' interactive') + ')');

await clickAt('input[placeholder="Search orders"]', 3);
await ui.eval('window.__demoScript(4)');
for (const ch of 'Initech') {
  await ui.typeText(ch);
  await sleep(85);
  await snap();
}
await ui.sleep(220);
await snap();

await ui.eval('window.__demoScript(6)');
await moveTo('text=Initech');
await ui.eval('window.__demoScript(7)');
await ui.click('text=Initech');
await snap();
await hold(8, 120);

await ui.eval('window.__demoScript(9)');
const exportButton = await moveTo('#export');
await ui.eval('window.__demoScript(10)');
await ui.eval('window.__demoClick(' + exportButton.x + ',' + exportButton.y + ')');
const download = await ui.waitForDownload(() => ui.click('#export'), { timeoutMs: 20000 });
await ui.eval('window.__demoScript(12)');
await ui.eval('window.__demoLog(' + JSON.stringify('downloaded · ' + download.filename) + ')');
await snap();
console.log('downloaded: ' + download.filename + ' (' + download.bytes + ' bytes)');
await hold(12, 110);

await ui.eval('window.__demoDone()');
await hold(8, 110);

await ui.eval('window.__demoCursor(1180, 730)');
await hold(6, 120);
await ui.closeTab();
console.log('TIMINGS:' + JSON.stringify(timings));
`;
}

function run(command, commandArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited ${code}\n${stderr.slice(-4000)}`));
    });
  });
}

async function encode(directory, frames, timings) {
  const listFile = path.join(directory, "frames.txt");
  const lines = [];
  for (let i = 0; i < frames.length; i++) {
    const next = i + 1 < frames.length ? timings[i + 1] : timings[i] + 900;
    const duration = Math.max(0.04, Math.min(2.5, (next - timings[i]) / 1000));
    lines.push(`file '${frames[i]}'`, `duration ${duration.toFixed(3)}`);
  }
  fs.writeFileSync(listFile, lines.join("\n") + "\n");

  fs.mkdirSync(ASSETS, { recursive: true });
  const gif = path.join(ASSETS, "demo.gif");
  const mp4 = path.join(ASSETS, "demo.mp4");

  await run("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "concat", "-safe", "0", "-i", listFile,
    "-vf", "fps=12,scale=1100:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64[p];[b][p]paletteuse=dither=none:diff_mode=rectangle",
    "-loop", "0", gif,
  ]);

  await run("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "concat", "-safe", "0", "-i", listFile,
    "-vf", "fps=30,scale=1200:-2:flags=lanczos,format=yuv420p",
    "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-movflags", "+faststart",
    mp4,
  ]);

  return {
    gif: `${(fs.statSync(gif).size / 1024 / 1024).toFixed(2)} MB`,
    mp4: `${(fs.statSync(mp4).size / 1024 / 1024).toFixed(2)} MB`,
  };
}

async function main() {
  fs.rmSync(FRAMES, { recursive: true, force: true });
  fs.mkdirSync(FRAMES, { recursive: true });

  const { server, port } = await serveDemo();
  const url = `http://127.0.0.1:${port}/dashboard.html`;
  console.log(`serving ${url}`);

  // Direct CDP with a dedicated profile: the demo never drives a signed-in tab.
  delete process.env.RAW_BROWSER_EXTERNAL_BRIDGE;
  delete process.env.RAW_BROWSER_BRIDGE_BROWSER;
  delete process.env.RAW_BROWSER_BRIDGE_TOKEN;
  process.env.RAW_BROWSER_PROFILE = path.join(os.homedir(), ".raw", "demo-profile");
  process.env.RAW_DOWNLOAD_DIR = path.join(os.homedir(), ".raw", "demo-downloads");
  if (headless) process.env.RAW_BROWSER_HEADLESS = "1";

  const runtime = await import(pathToFileURL(path.join(ROOT, "dist", "browser.js")).href);
  let result;
  try {
    result = await runtime.runBrowserScript(pageScript({ url, frames: FRAMES, width, height }), {
      timeoutMs: 180_000,
    });
  } finally {
    server.close();
  }

  console.log(result.text);
  const match = /TIMINGS:(\[[^\]]*\])/.exec(result.text);
  if (!match) fail("the demo script did not report frame timings");
  const timings = JSON.parse(match[1]);

  const frames = fs.readdirSync(FRAMES).filter((name) => name.endsWith(".jpg")).sort();
  if (frames.length !== timings.length) {
    fail(`captured ${frames.length} frames but recorded ${timings.length} timings`);
  }
  if (frames.length < 10) fail(`only ${frames.length} frames captured`);

  const encoded = await encode(
    FRAMES,
    frames.map((name) => path.join(FRAMES, name)),
    timings,
  );
  console.log(`wrote assets/demo.gif (${encoded.gif}) and assets/demo.mp4 (${encoded.mp4})`);
  if (!keep) fs.rmSync(FRAMES, { recursive: true, force: true });
}

main().catch((error) => fail(error?.stack || String(error)));
