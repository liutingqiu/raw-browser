#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE_INSTALLER = path.join(PACKAGE_ROOT, "scripts", "install-edge-bridge.mjs");

const HELP = `raw - browser automation runtime

Usage:
  raw status
  raw run [options] < script.js
  raw run -e "console.log(await page.title())"

Options:
  -e, --eval CODE       Run CODE instead of reading stdin
  --timeout-ms N        Script timeout in milliseconds (default: 180000)
  --space NAME          Use an ephemeral isolated browser context
  --headless            Launch the browser headless when it is not already running
  --profile PATH        Override the persistent browser profile directory
  --port N              Override the CDP port (default 9222 direct, 9333/9334 bridge)
  --browser PATH        Use a specific Chrome or Edge executable
  --downloads PATH      Override the browser download directory
  --output-dir PATH     Directory for inline images returned by the runtime
  -h, --help            Show this help

The profile config at ~/.raw/browser-profiles/current.json selects direct CDP
mode or an extension bridge (mode "edge-extension" / "chrome-extension").
`;

function takeValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

const args = process.argv.slice(2);
let command = "run";
if (args[0] && !args[0].startsWith("-")) command = args.shift()!;

const rawHome = process.env.RAW_HOME || path.join(os.homedir(), ".raw");
const browserProfileConfig = path.join(rawHome, "browser-profiles", "current.json");
let defaultBrowserProfile = path.join(rawHome, "codex-browser-profile");
let defaultBrowserPath: string | undefined;
let bridgeBrowser: "edge" | "chrome" | undefined;

try {
  const current = JSON.parse(fs.readFileSync(browserProfileConfig, "utf8").replace(/^﻿/, ""));
  if (typeof current.profile === "string" && path.isAbsolute(current.profile)) defaultBrowserProfile = current.profile;
  if (typeof current.browser === "string" && path.isAbsolute(current.browser)) defaultBrowserPath = current.browser;
  if (current.mode === "edge-extension") bridgeBrowser = "edge";
  else if (current.mode === "chrome-extension") bridgeBrowser = "chrome";
  else if (current.mode === "extension") bridgeBrowser = current.browser === "chrome" ? "chrome" : "edge";
} catch (error: any) {
  if (error?.code !== "ENOENT") {
    process.stderr.write(`raw: invalid browser profile config ${browserProfileConfig}: ${error.message}\n`);
    process.exit(2);
  }
}

process.env.RAW_BROWSER_PROFILE ??= defaultBrowserProfile;
if (defaultBrowserPath) process.env.RAW_BROWSER_PATH ??= defaultBrowserPath;
if (bridgeBrowser) {
  const bridgeConfigPath = path.join(rawHome, `${bridgeBrowser}-bridge.json`);
  try {
    const bridgeConfig = JSON.parse(fs.readFileSync(bridgeConfigPath, "utf8").replace(/^﻿/, ""));
    if (typeof bridgeConfig.token !== "string" || !bridgeConfig.token) {
      throw new Error("missing token");
    }
    process.env.RAW_BROWSER_EXTERNAL_BRIDGE ??= "1";
    process.env.RAW_BROWSER_BRIDGE_BROWSER ??= bridgeBrowser;
    process.env.RAW_BROWSER_BRIDGE_TOKEN ??= bridgeConfig.token;
    process.env.RAW_BRIDGE_CONFIG ??= bridgeConfigPath;
  } catch (error: any) {
    process.stderr.write(
      `raw: cannot use the ${bridgeBrowser} extension bridge (${bridgeConfigPath}): ${error.message}. Run the bridge installer first: node "${BRIDGE_INSTALLER}" --browser ${bridgeBrowser}.\n`,
    );
    process.exit(2);
  }
}
process.env.RAW_DOWNLOAD_DIR ??= path.join(rawHome, "codex-browser-downloads");

if (command === "help" || args.includes("-h") || args.includes("--help")) {
  process.stdout.write(HELP);
} else if (command !== "run" && command !== "status") {
  process.stderr.write(`raw: unknown command "${command}"\n\n${HELP}`);
  process.exitCode = 2;
} else {
  try {
    let code: string | undefined;
    let timeoutMs = 180_000;
    let space: string | undefined;
    let outputDir: string | undefined;

    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === "-e" || arg === "--eval") { code = takeValue(args, index, arg); index++; }
      else if (arg === "--timeout-ms") { timeoutMs = Number(takeValue(args, index, arg)); index++; }
      else if (arg === "--space") { space = takeValue(args, index, arg); index++; }
      else if (arg === "--headless") process.env.RAW_BROWSER_HEADLESS = "1";
      else if (arg === "--profile") { process.env.RAW_BROWSER_PROFILE = path.resolve(takeValue(args, index, arg)); index++; }
      else if (arg === "--port") { process.env.RAW_BROWSER_PORT = takeValue(args, index, arg); index++; }
      else if (arg === "--browser") { process.env.RAW_BROWSER_PATH = path.resolve(takeValue(args, index, arg)); index++; }
      else if (arg === "--downloads") { process.env.RAW_DOWNLOAD_DIR = path.resolve(takeValue(args, index, arg)); index++; }
      else if (arg === "--output-dir") { outputDir = path.resolve(takeValue(args, index, arg)); index++; }
      else throw new Error(`unknown option "${arg}"`);
    }

    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) throw new Error("--timeout-ms must be an integer between 1 and 3600000");

    const bridgeMode = process.env.RAW_BROWSER_EXTERNAL_BRIDGE === "1";
    if (space && bridgeMode) {
      throw new Error("--space needs Target.createBrowserContext, which the extension bridge cannot provide. Use direct CDP mode or drop --space.");
    }
    if (process.env.RAW_BROWSER_HEADLESS === "1" && bridgeMode) {
      process.stderr.write("raw: --headless is ignored in extension bridge mode; that browser is already running.\n");
    }

    const runtime = await import("./browser.ts");
    if (command === "status") {
      process.stdout.write(`${await runtime.browserStatus()}\n`);
    } else {
      if (code === undefined) {
        if (process.stdin.isTTY) throw new Error("provide JavaScript with stdin or --eval");
        code = fs.readFileSync(0, "utf8");
      }
      if (!code.trim()) throw new Error("browser script is empty");
      const result = await runtime.runBrowserScript(code, { timeoutMs, space });
      process.stdout.write(`${result.text}\n`);
      if (result.images?.length) {
        const dir = outputDir ?? process.env.RAW_DOWNLOAD_DIR!;
        fs.mkdirSync(dir, { recursive: true });
        for (let index = 0; index < result.images.length; index++) {
          const image = result.images[index];
          const extension = image.mime === "image/jpeg" ? "jpg" : "png";
          const file = path.join(dir, `codex-raw-browser-${Date.now()}-${index + 1}.${extension}`);
          fs.writeFileSync(file, Buffer.from(image.data, "base64"));
          process.stdout.write(`[raw-browser image] ${file}\n`);
        }
      }
      if (result.text.startsWith("Error:")) process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`raw: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
