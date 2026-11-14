import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeContract } from "../dist/verify/contract.js";
import { runContract } from "../dist/verify/runner.js";

/**
 * Run a real file rather than `node -e "<script>"`: cmd.exe does not share
 * Node's argument-quoting rules, so an inline script containing `=>` and `{}`
 * gets mangled on Windows.
 */
const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "raw-verify-"));
function nodeScript(name, body) {
  const file = path.join(scriptDir, name);
  fs.writeFileSync(file, body);
  return `node ${JSON.stringify(file)}`;
}

test("Contract: normalizes valid contract specifications", () => {
  const norm = normalizeContract({
    checks: [{ command: "npm test" }],
  });
  assert.equal(norm.timeoutMs, 60000);
  assert.equal(norm.checks.length, 1);
  assert.equal(norm.checks[0].expectedExitCode, 0);

  // Rejects invalid inputs
  assert.throws(() => normalizeContract(null), /must be an object/);
  assert.throws(() => normalizeContract({ checks: [] }), /must contain at least one check/);
});

test("Runner: executes real checks and correctly arbitrates verdicts", async () => {
  // 1. Successful check (exit 0)
  const passVerdict = await runContract({
    checks: [{ name: "should-pass", command: nodeScript("pass.mjs", "process.exit(0);") }],
  });
  assert.equal(passVerdict.verdict, "verified");
  assert.equal(passVerdict.passedChecks, 1);
  assert.equal(passVerdict.totalChecks, 1);

  // 2. Refuted check (exit 1)
  const failVerdict = await runContract({
    checks: [{ name: "should-fail", command: nodeScript("fail.mjs", "process.exit(1);") }],
  });
  assert.equal(failVerdict.verdict, "refuted");
  assert.equal(failVerdict.passedChecks, 0);
  assert.equal(failVerdict.results[0].exitCode, 1);

  // 3. Timeout check
  const timeoutVerdict = await runContract({
    checks: [
      {
        name: "should-timeout",
        command: nodeScript("slow.mjs", "setTimeout(() => {}, 2000);"),
        timeoutMs: 100,
      },
    ],
  });
  assert.equal(timeoutVerdict.verdict, "refuted");
  assert.match(timeoutVerdict.results[0].error, /timed out/);
});
