import "./_setup.mjs";

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  claimTab,
  ownerOf,
  ownedTabIds,
  pruneRegistry,
  readRegistry,
  releaseTab,
  renameOwner,
  sanitizeLabel,
} from "../scripts/tab-owners.mjs";

const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "raw-owners-")), "tab-owners.json");

test("TabOwners: claim, persist and look up an owner", () => {
  const file = tempFile();
  claimTab("alpha", "1", { file });
  assert.equal(ownerOf("1", { file }), "alpha");
  assert.deepEqual(ownedTabIds("alpha", { file }), ["1"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).tabs, { 1: "alpha" });
});

test("TabOwners: another agent cannot take a tab unless it forces", () => {
  const file = tempFile();
  claimTab("alpha", "1", { file });
  assert.throws(() => claimTab("beta", "1", { file }), /controlled by "alpha"/);
  claimTab("beta", "1", { file, force: true });
  assert.equal(ownerOf("1", { file }), "beta");
  assert.deepEqual(ownedTabIds("alpha", { file }), []);
});

test("TabOwners: release keeps the tab open but gives up ownership", () => {
  const file = tempFile();
  claimTab("alpha", "1", { file });
  releaseTab("alpha", "1", { file });
  assert.equal(ownerOf("1", { file }), null);
  assert.deepEqual(ownedTabIds("alpha", { file }), []);
  assert.equal(readRegistry(file).owners.alpha, undefined);
  // Releasing an already-unowned tab is a no-op; another owner's tab is refused.
  releaseTab("alpha", "1", { file });
  claimTab("alpha", "2", { file });
  assert.throws(() => releaseTab("beta", "2", { file }), /controlled by "alpha"/);
  claimTab("beta", "2", { file, force: true });
});

test("TabOwners: renaming an agent carries its tabs over", () => {
  const file = tempFile();
  claimTab("alpha", "1", { file });
  claimTab("alpha", "2", { file });
  renameOwner("alpha", "alpha-2", { file });
  assert.deepEqual(ownedTabIds("alpha-2", { file }).sort(), ["1", "2"]);
  assert.deepEqual(ownedTabIds("alpha", { file }), []);
});

test("TabOwners: pruning forgets tabs that closed", () => {
  const file = tempFile();
  claimTab("alpha", "1", { file });
  claimTab("alpha", "2", { file });
  pruneRegistry(["2", "3"], { file });
  assert.deepEqual(ownedTabIds("alpha", { file }), ["2"]);
});

test("TabOwners: a corrupt registry reads as empty instead of blocking agents", () => {
  const file = tempFile();
  fs.writeFileSync(file, "{ not json");
  assert.deepEqual(readRegistry(file).tabs, {});
  claimTab("alpha", "7", { file });
  assert.equal(ownerOf("7", { file }), "alpha");
});

test("TabOwners: labels are trimmed and bounded", () => {
  assert.equal(sanitizeLabel("  dsh  "), "dsh");
  assert.equal(sanitizeLabel(""), "agent");
  assert.equal(sanitizeLabel("x".repeat(50)).length, 32);
  assert.equal(sanitizeLabel("a\u0000b"), "ab");
});
