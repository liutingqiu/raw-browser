import "./_setup.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  EXPECTED_EXTENSION_ID,
  extensionIdFromManifestKey,
  hostFilename,
  hostRid,
  nativeMessagingDir,
  planInstall,
} from "../scripts/install-edge-bridge.mjs";

const repo = path.resolve(import.meta.dirname, "..");

test("host RIDs and file names match the release matrix", () => {
  assert.equal(hostRid("win32", "x64"), "win-x64");
  assert.equal(hostRid("win32", "arm64"), "win-arm64");
  assert.equal(hostRid("darwin", "x64"), "osx-x64");
  assert.equal(hostRid("darwin", "arm64"), "osx-arm64");
  assert.equal(hostRid("linux", "x64"), "linux-x64");
  assert.equal(hostRid("linux", "arm64"), "linux-arm64");
  assert.equal(hostFilename("win32"), "raw-edge-bridge.exe");
  assert.equal(hostFilename("darwin"), "raw-edge-bridge");
  assert.equal(hostFilename("linux"), "raw-edge-bridge");
  assert.throws(() => hostRid("freebsd", "x64"), /unsupported platform/);
  assert.throws(() => hostRid("linux", "ia32"), /unsupported architecture/);
});

test("native messaging directories follow Chrome and Edge on macOS and Linux", () => {
  assert.equal(
    nativeMessagingDir("darwin", "/Users/me", "chrome"),
    "/Users/me/Library/Application Support/Google/Chrome/NativeMessagingHosts",
  );
  assert.equal(
    nativeMessagingDir("darwin", "/Users/me", "edge"),
    "/Users/me/Library/Application Support/Microsoft Edge/NativeMessagingHosts",
  );
  assert.equal(
    nativeMessagingDir("linux", "/home/me", "chrome"),
    "/home/me/.config/google-chrome/NativeMessagingHosts",
  );
  assert.equal(
    nativeMessagingDir("linux", "/home/me", "edge"),
    "/home/me/.config/microsoft-edge/NativeMessagingHosts",
  );
  assert.equal(nativeMessagingDir("win32", "C:\\Users\\me", "chrome"), null);
});

test("the extension id is derived from the checked-in manifest key", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, "edge-bridge", "extension", "manifest.json"), "utf8"));
  assert.equal(extensionIdFromManifestKey(manifest.key), EXPECTED_EXTENSION_ID);
});

test("the installer keeps one stable host path per browser", () => {
  const linux = planInstall({
    platform: "linux",
    arch: "arm64",
    home: "/home/me",
    browser: "both",
    version: "0.7.0",
    repoRoot: "/repo",
  });
  assert.equal(linux.rid, "linux-arm64");
  assert.equal(linux.assetName, "raw-bridge-host-linux-arm64.tar.gz");
  assert.equal(linux.edgeHost, "/home/me/.raw/edge-bridge/current/raw-edge-bridge");
  assert.equal(linux.chromeHost, "/home/me/.raw/edge-bridge/current/raw-chrome-bridge");
  assert.equal(linux.edgeManifest, "/home/me/.raw/edge-bridge/com.raw.edge_bridge.edge.json");
  assert.equal(linux.extensionPath, "/repo/edge-bridge/extension");

  const mac = planInstall({
    platform: "darwin",
    arch: "arm64",
    home: "/Users/me",
    browser: "chrome",
    version: "0.7.0",
    repoRoot: "/repo",
  });
  assert.equal(mac.rid, "osx-arm64");
  assert.equal(mac.assetName, "raw-bridge-host-osx-arm64.tar.gz");
  assert.equal(mac.edgeHost, "/Users/me/.raw/edge-bridge/current/raw-edge-bridge");

  const windows = planInstall({
    platform: "win32",
    arch: "x64",
    home: "C:\\Users\\me",
    browser: "both",
    version: "0.7.0",
    repoRoot: "C:\\repo",
  });
  assert.equal(windows.rid, "win-x64");
  assert.equal(windows.assetName, "raw-bridge-host-win-x64.zip");
  assert.equal(windows.edgeHost, "C:\\Users\\me\\.raw\\edge-bridge\\current\\raw-edge-bridge.exe");
  assert.equal(windows.chromeHost, "C:\\Users\\me\\.raw\\edge-bridge\\current\\raw-chrome-bridge.exe");
});
