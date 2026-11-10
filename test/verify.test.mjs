import test from "node:test";
import assert from "node:assert/strict";
import { normalizeContract } from "../dist/verify/contract.js";
import { runContract } from "../dist/verify/runner.js";

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
    checks: [
      { name: "should-pass", command: 'node -e "process.exit(0);"' },
    ],
  });
  assert.equal(passVerdict.verdict, "verified");
  assert.equal(passVerdict.passedChecks, 1);
  assert.equal(passVerdict.totalChecks, 1);

  // 2. Refuted check (exit 1)
  const failVerdict = await runContract({
    checks: [
      { name: "should-fail", command: 'node -e "process.exit(1);"' },
    ],
  });
  assert.equal(failVerdict.verdict, "refuted");
  assert.equal(failVerdict.passedChecks, 0);
  assert.equal(failVerdict.results[0].exitCode, 1);

  // 3. Timeout check
  const timeoutVerdict = await runContract({
    checks: [
      {
        name: "should-timeout",
        command: 'node -e "setTimeout(() => {}, 2000);"',
        timeoutMs: 100,
      },
    ],
  });
  assert.equal(timeoutVerdict.verdict, "refuted");
  assert.match(timeoutVerdict.results[0].error, /timed out/);
});
