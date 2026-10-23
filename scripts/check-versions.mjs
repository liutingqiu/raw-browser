#!/usr/bin/env node
/**
 * Fail when the version reported by the package, extension, native host and
 * MCP server drift apart. `--tag v0.5.1` also checks a release tag.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

const pkg = JSON.parse(read("package.json")).version;
const manifest = JSON.parse(read("edge-bridge/extension/manifest.json")).version;
const hostMatch = /const string Version = "([^"]+)"/.exec(read("edge-bridge/host/Program.cs"));
const mcpMatch = /serverInfo:\s*\{\s*name:\s*"raw-browser",\s*version:\s*"([^"]+)"/.exec(
  read("mcp/raw-browser-mcp.mjs"),
);

if (!hostMatch) throw new Error("could not find the host version in edge-bridge/host/Program.cs");
if (!mcpMatch) throw new Error("could not find serverInfo.version in mcp/raw-browser-mcp.mjs");

const found = {
  "package.json": pkg,
  "edge-bridge/extension/manifest.json": manifest,
  "edge-bridge/host/Program.cs": hostMatch[1],
  "mcp/raw-browser-mcp.mjs": mcpMatch[1],
};
const versions = new Set(Object.values(found));
if (versions.size !== 1) {
  console.error("version drift:");
  for (const [file, version] of Object.entries(found)) console.error(`  ${version}  ${file}`);
  process.exit(1);
}

const tagIndex = process.argv.indexOf("--tag");
if (tagIndex !== -1) {
  const tag = (process.argv[tagIndex + 1] ?? "").replace(/^v/, "");
  if (!tag) throw new Error("--tag needs a value such as v0.5.1");
  if (tag !== pkg) {
    console.error(`release tag v${tag} does not match the package version ${pkg}`);
    process.exit(1);
  }
}

console.log(`versions agree on ${pkg}`);
