import "./_setup.mjs";

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { pathToFileURL } from "node:url";

import { normalizeUrl } from "../dist/browser.js";
import { releaseAssetUrls } from "../scripts/install-edge-bridge.mjs";

const here = import.meta.dirname;
const repo = path.resolve(here, "..");
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const scriptDir = tmp("raw-scripts-");

/**
 * Write a script and return the bare file name. Contracts run with `cwd` set
 * to the script's directory, because cmd.exe mangles both inline `-e` scripts
 * and quoted absolute paths.
 */
function writeScript(dir, name, body) {
  fs.writeFileSync(path.join(dir, name), body);
  return `node ${name}`;
}

/* ------------------------------------------------------------------ *
 * verify: timeouts must end the whole process tree, promptly
 * ------------------------------------------------------------------ */

test("raw-bridge: normalizeUrl matches the browser runtime", () => {
  const source = fs.readFileSync(path.join(repo, "scripts", "raw-bridge.mjs"), "utf8");
  const match = source.match(/function normalizeUrl\(value\) \{[\s\S]*?\n\}/);
  assert.ok(match, "raw-bridge.mjs no longer defines normalizeUrl");
  const bridgeNormalize = vm.runInNewContext(`(${match[0]})`);

  for (const input of ["example.com", "https://example.com", "file:///tmp/a", "about:blank", "", "HTTP://X", "data:text/plain,hi", "localhost:3000", "example.com:8080/x", "//cdn.example/app.js"]) {
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
