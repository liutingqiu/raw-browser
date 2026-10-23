#!/usr/bin/env node
/**
 * Install the Raw Browser Bridge native-messaging host.
 *
 * macOS and Linux use this script directly. Windows delegates to the existing
 * PowerShell installer, which owns the HKCU registry entries; the flags are the
 * same so one command works everywhere.
 *
 *   node scripts/install-edge-bridge.mjs --browser both
 *   node scripts/install-edge-bridge.mjs --browser chrome --build-from-source
 *   node scripts/install-edge-bridge.mjs --dry-run
 *
 * The host is published to a stable path under ~/.raw/edge-bridge/current/
 * because Chrome and Edge cache a native-messaging host path for the life of
 * the browser process. Upgrades replace the files in place.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const HOST_NAME = "com.raw.edge_bridge";
export const EXPECTED_EXTENSION_ID = "gfpadofoapicldopjkghnfbnbkljihmk";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const HOST_PROJECT = path.join(REPO_ROOT, "edge-bridge", "host", "RawEdgeBridge.csproj");
const DEFAULT_RELEASE_BASE = "https://github.com/liutingqiu/raw-browser/releases/download";
const PACKAGE = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));

function pathFor(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

export function hostRid(platform = process.platform, arch = process.arch) {
  const osName = platform === "win32" ? "win" : platform === "darwin" ? "osx" : platform;
  if (!["win32", "linux", "darwin"].includes(platform)) {
    throw new Error(`unsupported platform: ${platform}`);
  }
  if (!["x64", "arm64"].includes(arch)) {
    throw new Error(`unsupported architecture: ${arch}`);
  }
  return `${osName}-${arch}`;
}

export function hostFilename(platform = process.platform) {
  return platform === "win32" ? "raw-edge-bridge.exe" : "raw-edge-bridge";
}

/** Chrome's extension id is the first 16 bytes of SHA-256(DER key), a-p. */
export function extensionIdFromManifestKey(key) {
  if (typeof key !== "string" || !key) throw new Error("extension manifest has no key");
  const hash = crypto.createHash("sha256").update(Buffer.from(key, "base64")).digest();
  let id = "";
  for (let index = 0; index < 16; index++) {
    id += String.fromCharCode(97 + (hash[index] >> 4));
    id += String.fromCharCode(97 + (hash[index] & 0x0f));
  }
  return id;
}

export function nativeMessagingDir(platform, home, browser) {
  if (platform === "win32") return null;
  const p = pathFor(platform);
  if (platform === "darwin") {
    return browser === "chrome"
      ? p.join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts")
      : p.join(home, "Library", "Application Support", "Microsoft Edge", "NativeMessagingHosts");
  }
  if (platform === "linux") {
    return browser === "chrome"
      ? p.join(home, ".config", "google-chrome", "NativeMessagingHosts")
      : p.join(home, ".config", "microsoft-edge", "NativeMessagingHosts");
  }
  throw new Error(`unsupported platform: ${platform}`);
}

export function planInstall({
  platform = process.platform,
  arch = process.arch,
  home = os.homedir(),
  browser = "both",
  version = PACKAGE.version,
  repoRoot = REPO_ROOT,
} = {}) {
  if (!["edge", "chrome", "both"].includes(browser)) {
    throw new Error(`--browser must be edge, chrome or both (got ${browser})`);
  }
  version = String(version).replace(/^v/, "");
  const p = pathFor(platform);
  const rid = hostRid(platform, arch);
  const extensionPath = p.join(repoRoot, "edge-bridge", "extension");
  const rawHome = p.join(home, ".raw");
  const installRoot = p.join(rawHome, "edge-bridge");
  const current = p.join(installRoot, "current");
  const previous = p.join(installRoot, "previous");
  const hostName = hostFilename(platform);
  const edgeHost = p.join(current, hostName);
  const chromeHost = p.join(current, `raw-chrome-bridge${platform === "win32" ? ".exe" : ""}`);
  const assetName = platform === "win32"
    ? `raw-bridge-host-${rid}.zip`
    : `raw-bridge-host-${rid}.tar.gz`;
  return {
    platform,
    arch,
    rid,
    browser,
    version,
    repoRoot,
    extensionPath,
    rawHome,
    installRoot,
    current,
    previous,
    hostName,
    edgeHost,
    chromeHost,
    assetName,
    edgeConfig: p.join(rawHome, "edge-bridge.json"),
    chromeConfig: p.join(rawHome, "chrome-bridge.json"),
    edgeManifest: p.join(installRoot, `${HOST_NAME}.edge.json`),
    chromeManifest: p.join(installRoot, `${HOST_NAME}.chrome.json`),
    browserDirs: {
      edge: nativeMessagingDir(platform, home, "edge"),
      chrome: nativeMessagingDir(platform, home, "chrome"),
    },
  };
}

function writeJson(file, value, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode });
  try { fs.chmodSync(file, mode); } catch { /* Windows ignores POSIX modes */ }
}

function ensureConfig(file, port) {
  try {
    const existing = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
    if (typeof existing.token === "string" && existing.token && Number.isInteger(Number(existing.port))) {
      return { ...existing, port: Number(existing.port) };
    }
  } catch {
    /* write a fresh config below */
  }
  const config = { version: 1, token: crypto.randomBytes(32).toString("base64url"), port };
  writeJson(file, config, 0o600);
  return config;
}

function extensionId(plan) {
  const manifestPath = path.join(plan.extensionPath, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const id = extensionIdFromManifestKey(manifest.key);
  if (id !== EXPECTED_EXTENSION_ID) {
    throw new Error(`extension id changed: expected ${EXPECTED_EXTENSION_ID}, manifest yields ${id}`);
  }
  return id;
}

function walkFor(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = walkFor(full, name);
      if (found) return found;
    } else if (entry.name === name) {
      return full;
    }
  }
  return null;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    windowsHide: true,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${result.status ?? "no status"}`);
  }
  return result;
}

function dotnetVersion() {
  const result = spawnSync("dotnet", ["--version"], { encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout?.trim() || null : null;
}

function dotnetSupportsNet9() {
  const version = dotnetVersion();
  if (!version) return false;
  return Number.parseInt(version.split(".")[0], 10) >= 9;
}

function buildFromSource(plan, destination) {
  const version = dotnetVersion();
  if (!version) throw new Error("building from source needs the .NET 9 SDK on PATH");
  if (Number.parseInt(version.split(".")[0], 10) < 9) {
    throw new Error(`building from source needs the .NET 9 SDK (found ${version})`);
  }
  console.error(`building the ${plan.rid} bridge host from source`);
  run("dotnet", [
    "publish", HOST_PROJECT,
    "-c", "Release",
    "-r", plan.rid,
    "--self-contained", "true",
    "-p:PublishSingleFile=true",
    "-p:IncludeNativeLibrariesForSelfExtract=true",
    "-p:EnableCompressionInSingleFile=true",
    "-o", path.dirname(destination),
    "--nologo",
  ], { cwd: REPO_ROOT, stdio: ["inherit", 2, 2] });
  if (!fs.existsSync(destination)) {
    throw new Error(`the bridge host was not produced: ${destination}`);
  }
  const frameworkDependent = path.join(path.dirname(destination), "raw-edge-bridge.dll");
  if (fs.existsSync(frameworkDependent)) {
    throw new Error("the source build did not produce a single-file bridge host");
  }
  try { fs.chmodSync(destination, 0o755); } catch { /* Windows */ }
}

function checksumFor(text, asset) {
  const line = text
    .split(/\r?\n/)
    .find((entry) => entry.trim().split(/\s+/).at(-1) === asset);
  return line ? line.trim().split(/\s+/)[0].toLowerCase() : null;
}

async function downloadPrebuilt(plan, destination, releaseBase) {
  const base = releaseBase.replace(/\/+$/, "");
  const url = `${base}/v${plan.version}/${plan.assetName}`;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "raw-bridge-"));
  try {
    console.error(`downloading prebuilt bridge host: ${url}`);
    const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
    if (!response.ok) {
      throw new Error(`could not download ${url} (HTTP ${response.status}); install the .NET 9 SDK and rerun with --build-from-source, pass --host-path, or publish the release asset`);
    }
    const archive = path.join(temp, plan.assetName);
    fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()));

    try {
      const sumsResponse = await fetch(`${base}/v${plan.version}/SHA256SUMS.txt`, {
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
      });
      if (sumsResponse.ok) {
        const expected = checksumFor(await sumsResponse.text(), plan.assetName);
        const actual = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
        if (expected && expected !== actual) {
          throw new Error(`checksum mismatch for ${plan.assetName}`);
        }
        if (!expected) console.error(`warning: SHA256SUMS.txt has no entry for ${plan.assetName}`);
      } else {
        console.error(`warning: could not fetch SHA256SUMS.txt (HTTP ${sumsResponse.status})`);
      }
    } catch (error) {
      if (String(error.message).includes("checksum mismatch")) throw error;
      console.error(`warning: could not verify ${plan.assetName}: ${error.message}`);
    }

    const extract = path.join(temp, "extract");
    fs.mkdirSync(extract, { recursive: true });
    run("tar", ["-xzf", archive, "-C", extract], { stdio: "ignore" });
    const found = walkFor(extract, "raw-edge-bridge");
    if (!found) throw new Error(`the downloaded archive does not contain raw-edge-bridge`);
    fs.copyFileSync(found, destination);
    try { fs.chmodSync(destination, 0o755); } catch { /* Windows */ }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

async function resolveHost(plan, options, staging) {
  const destination = path.join(staging, plan.hostName);
  if (options.hostPath) {
    const source = path.resolve(options.hostPath);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
      throw new Error(`--host-path is not a file: ${source}`);
    }
    fs.copyFileSync(source, destination);
    try { fs.chmodSync(destination, 0o755); } catch { /* Windows */ }
    return destination;
  }

  if (options.buildFromSource || (!options.preferPrebuilt && dotnetSupportsNet9())) {
    try {
      buildFromSource(plan, destination);
      return destination;
    } catch (error) {
      if (options.buildFromSource) throw error;
      console.error(`warning: source build failed, falling back to the prebuilt host: ${error.message}`);
    }
  }

  await downloadPrebuilt(plan, destination, options.releaseBase);
  return destination;
}

function installHost(plan, stagedHost) {
  const p = pathFor(plan.platform);
  fs.mkdirSync(plan.current, { recursive: true, mode: 0o700 });
  fs.mkdirSync(plan.previous, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(plan.current, 0o700); } catch { /* Windows */ }
  try { fs.chmodSync(plan.previous, 0o700); } catch { /* Windows */ }

  const previousEdge = p.join(plan.previous, p.basename(plan.edgeHost));
  const previousChrome = p.join(plan.previous, p.basename(plan.chromeHost));
  const edgeTemp = `${plan.edgeHost}.new-${process.pid}`;
  const chromeTemp = `${plan.chromeHost}.new-${process.pid}`;
  try {
    if (fs.existsSync(plan.edgeHost)) {
      fs.rmSync(previousEdge, { force: true });
      fs.renameSync(plan.edgeHost, previousEdge);
    }
    if (fs.existsSync(plan.chromeHost)) {
      fs.rmSync(previousChrome, { force: true });
      fs.renameSync(plan.chromeHost, previousChrome);
    }
    fs.copyFileSync(stagedHost, edgeTemp);
    fs.copyFileSync(stagedHost, chromeTemp);
    try { fs.chmodSync(edgeTemp, 0o755); } catch { /* Windows */ }
    try { fs.chmodSync(chromeTemp, 0o755); } catch { /* Windows */ }
    fs.renameSync(edgeTemp, plan.edgeHost);
    fs.renameSync(chromeTemp, plan.chromeHost);
  } catch (error) {
    fs.rmSync(edgeTemp, { force: true });
    fs.rmSync(chromeTemp, { force: true });
    fs.rmSync(plan.edgeHost, { force: true });
    fs.rmSync(plan.chromeHost, { force: true });
    if (fs.existsSync(previousEdge)) fs.renameSync(previousEdge, plan.edgeHost);
    if (fs.existsSync(previousChrome)) fs.renameSync(previousChrome, plan.chromeHost);
    throw error;
  }
}

function installManifests(plan, id) {
  const allowedOrigin = `chrome-extension://${id}/`;
  writeJson(plan.edgeManifest, {
    name: HOST_NAME,
    description: "Local bridge between Raw and the user's Edge profile",
    path: plan.edgeHost,
    type: "stdio",
    allowed_origins: [allowedOrigin],
  });
  writeJson(plan.chromeManifest, {
    name: HOST_NAME,
    description: "Local bridge between Raw and the user's Chrome profile",
    path: plan.chromeHost,
    type: "stdio",
    allowed_origins: [allowedOrigin],
  });
}

function registerManifests(plan) {
  const p = pathFor(plan.platform);
  const registered = {};
  const selected = plan.browser === "both" ? ["edge", "chrome"] : [plan.browser];
  for (const browser of selected) {
    const dir = plan.browserDirs[browser];
    if (!dir) continue;
    fs.mkdirSync(dir, { recursive: true });
    const target = p.join(dir, `${HOST_NAME}.json`);
    fs.copyFileSync(browser === "edge" ? plan.edgeManifest : plan.chromeManifest, target);
    try { fs.chmodSync(target, 0o644); } catch { /* Windows */ }
    registered[browser] = target;
  }
  return registered;
}

function legacyHostDirs(plan) {
  if (!fs.existsSync(plan.installRoot)) return [];
  return fs.readdirSync(plan.installRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("host-"))
    .map((entry) => path.join(plan.installRoot, entry.name));
}

function delegateWindows(options) {
  if (options.home) {
    throw new Error("--home is only supported on macOS/Linux; the Windows installer uses %USERPROFILE% and HKCU");
  }
  if (options.version !== PACKAGE.version) {
    console.error("warning: --version is ignored on Windows; the PowerShell installer uses the package version");
  }
  if (options.releaseBase !== DEFAULT_RELEASE_BASE) {
    console.error("warning: --release-base is ignored on Windows; the PowerShell installer downloads from GitHub");
  }
  const ps1 = path.join(SCRIPT_DIR, "install-edge-bridge.ps1");
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, "-Browser", options.browser];
  if (options.hostPath) args.push("-HostPath", path.resolve(options.hostPath));
  if (options.preferPrebuilt) args.push("-PreferPrebuilt");
  if (options.buildFromSource) args.push("-BuildFromSource");
  if (options.cleanLegacyHosts) args.push("-CleanLegacyHosts");
  const result = spawnSync("powershell.exe", args, { stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}

function parseArgs(argv) {
  const options = {
    browser: "both",
    hostPath: undefined,
    buildFromSource: false,
    preferPrebuilt: false,
    cleanLegacyHosts: false,
    dryRun: false,
    help: false,
    home: undefined,
    version: PACKAGE.version,
    releaseBase: process.env.RAW_BRIDGE_RELEASE_BASE || DEFAULT_RELEASE_BASE,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const take = (name) => {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
      return value;
    };
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--browser") options.browser = take("--browser");
    else if (arg.startsWith("--browser=")) options.browser = arg.slice("--browser=".length);
    else if (arg === "--host-path") options.hostPath = take("--host-path");
    else if (arg.startsWith("--host-path=")) options.hostPath = arg.slice("--host-path=".length);
    else if (arg === "--build-from-source") options.buildFromSource = true;
    else if (arg === "--prefer-prebuilt") options.preferPrebuilt = true;
    else if (arg === "--clean-legacy-hosts") options.cleanLegacyHosts = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--home") options.home = take("--home");
    else if (arg.startsWith("--home=")) options.home = arg.slice("--home=".length);
    else if (arg === "--version") options.version = take("--version").replace(/^v/, "");
    else if (arg.startsWith("--version=")) options.version = arg.slice("--version=".length).replace(/^v/, "");
    else if (arg === "--release-base") options.releaseBase = take("--release-base");
    else if (arg.startsWith("--release-base=")) options.releaseBase = arg.slice("--release-base=".length);
    else throw new Error(`unknown option: ${arg}`);
  }
  if (options.browser !== "edge" && options.browser !== "chrome" && options.browser !== "both") {
    throw new Error("--browser must be edge, chrome or both");
  }
  if (options.preferPrebuilt && options.buildFromSource) {
    throw new Error("use either --prefer-prebuilt or --build-from-source, not both");
  }
  if (options.hostPath && (options.preferPrebuilt || options.buildFromSource)) {
    throw new Error("--host-path cannot be combined with a build/download switch");
  }
  if (!options.version) throw new Error("--version cannot be empty");
  if (!options.releaseBase) throw new Error("--release-base cannot be empty");
  return options;
}

function help() {
  return `Install the Raw Browser Bridge native-messaging host.

Usage:
  node scripts/install-edge-bridge.mjs [options]

Options:
  --browser <edge|chrome|both>  Browser manifests to register (default: both)
  --host-path <file>            Install a host you built yourself
  --build-from-source           Require a local .NET 9 SDK build
  --prefer-prebuilt             Download the release host even with an SDK
  --clean-legacy-hosts          Remove old host-* directories after a restart
  --home <dir>                  Test-only home override (macOS/Linux)
  --version <version>           Release version to download (default: package)
  --release-base <url>          Override the GitHub release download base
  --dry-run                     Print the resolved plan without writing
  -h, --help                    Show this help

Windows delegates to scripts/install-edge-bridge.ps1; macOS and Linux install
the native-messaging manifests under the browser's user config directory.
`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(help());
    return;
  }
  if (process.platform === "win32" && !options.dryRun) {
    delegateWindows(options);
    return;
  }

  const plan = planInstall({
    platform: process.platform,
    arch: process.arch,
    home: options.home ? path.resolve(options.home) : os.homedir(),
    browser: options.browser,
    version: options.version,
    repoRoot: REPO_ROOT,
  });
  const id = extensionId(plan);

  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({
      dryRun: true,
      ...plan,
      extensionId: id,
      releaseUrl: `${options.releaseBase.replace(/\/+$/, "")}/v${plan.version}/${plan.assetName}`,
    }, null, 2)}\n`);
    return;
  }

  fs.mkdirSync(plan.installRoot, { recursive: true, mode: 0o700 });
  const staging = path.join(plan.installRoot, `.install-${process.pid}-${Date.now()}`);
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    const stagedHost = await resolveHost(plan, options, staging);
    installHost(plan, stagedHost);
    const edgeConfig = ensureConfig(plan.edgeConfig, 9333);
    const chromeConfig = ensureConfig(plan.chromeConfig, 9334);
    installManifests(plan, id);
    const registered = registerManifests(plan);

    const legacy = legacyHostDirs(plan);
    if (legacy.length) {
      if (options.cleanLegacyHosts) {
        for (const dir of legacy) fs.rmSync(dir, { recursive: true, force: true });
        console.error("removed legacy host directories");
      } else {
        console.error(
          `warning: legacy host directories remain: ${legacy.map((dir) => path.basename(dir)).join(", ")}. ` +
          "A running browser may still use one until it restarts; rerun with --clean-legacy-hosts after the restart.",
        );
      }
    }

    process.stdout.write(`${JSON.stringify({
      ExtensionId: id,
      ExtensionPath: plan.extensionPath,
      EdgeHost: plan.edgeHost,
      ChromeHost: plan.chromeHost,
      EdgeConfig: plan.edgeConfig,
      ChromeConfig: plan.chromeConfig,
      EdgeManifest: plan.edgeManifest,
      ChromeManifest: plan.chromeManifest,
      EdgePort: edgeConfig.port,
      ChromePort: chromeConfig.port,
      Registered: registered,
    }, null, 2)}\n`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

const invokedDirectly = process.argv[1] && (() => {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  }
})();

if (invokedDirectly) {
  main().catch((error) => {
    console.error(`raw-bridge-install: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
