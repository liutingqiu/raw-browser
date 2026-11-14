import "./_setup.mjs";

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  accessFor,
  approveOrigin,
  originFor,
  readPermissions,
} from "../scripts/permissions.mjs";

const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "raw-perms-")), "permissions.json");

test("Permissions: default is allow, so raw stays frictionless", () => {
  const file = tempFile();
  assert.deepEqual(accessFor("https://example.com/x", { file }), {
    origin: "https://example.com",
    decision: "allow",
    source: "default",
  });
});

test("Permissions: ask mode makes an unapproved origin need confirmation", () => {
  const file = tempFile();
  fs.writeFileSync(file, JSON.stringify({ defaultAccess: "ask", origins: {} }));
  assert.equal(accessFor("https://new.example/", { file }).decision, "ask");
});

test("Permissions: an explicit origin entry wins over the default", () => {
  const file = tempFile();
  fs.writeFileSync(
    file,
    JSON.stringify({
      defaultAccess: "ask",
      origins: { "https://ok.example": { access: "allow" }, "https://no.example": { access: "deny" } },
    }),
  );
  assert.equal(accessFor("https://ok.example/a", { file }).decision, "allow");
  assert.equal(accessFor("https://no.example/a", { file }).decision, "deny");
});

test("Permissions: approve writes a persistent allow", () => {
  const file = tempFile();
  const origin = approveOrigin("https://example.com/path", { file });
  assert.equal(origin, "https://example.com");
  assert.equal(readPermissions(file).origins["https://example.com"].access, "allow");
  assert.equal(accessFor("https://example.com/other", { file }).decision, "allow");
});

test("Permissions: bare hosts and ports normalize, other schemes are outside the model", () => {
  assert.equal(originFor("example.com:8080/x"), "https://example.com:8080");
  assert.equal(originFor("http://a.example:80/x"), "http://a.example");
  assert.equal(originFor("file:///tmp/a.html"), null);
  assert.equal(originFor("about:blank"), null);
  assert.equal(accessFor("file:///tmp/a.html", { file: tempFile() }).decision, "allow");
});

test("Permissions: a corrupt file reads as the default policy", () => {
  const file = tempFile();
  fs.writeFileSync(file, "{ not json");
  assert.equal(readPermissions(file).defaultAccess, "allow");
  assert.deepEqual(readPermissions(file).origins, {});
});
