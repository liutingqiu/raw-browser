/**
 * Verification Runner for raw.verify.
 * Executes independent acceptance checks and checks process exit codes.
 */
import { spawn } from "node:child_process";
import type { AcceptanceContract, CheckSpec } from "../mesh/types.js";
import { normalizeContract, type VerificationVerdict, type VerificationCheckResult } from "./contract.js";

function executeCheck(check: CheckSpec, cwd: string): Promise<VerificationCheckResult> {
  const start = Date.now();
  const timeoutMs = check.timeoutMs || 30_000;
  const expectedExitCode = typeof check.expectedExitCode === "number" ? check.expectedExitCode : 0;

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let killed = false;

    // Use /bin/sh or cmd.exe to run shell commands safely
    const isWin = process.platform === "win32";
    const shell = isWin ? "cmd.exe" : "/bin/sh";
    const shellArg = isWin ? "/c" : "-c";

    const child = spawn(shell, [shellArg, check.command], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      killed = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 50_000) {
        stdout = stdout.slice(-50_000); // Bounded output cap
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 50_000) {
        stderr = stderr.slice(-50_000);
      }
    });

    child.on("error", (err: Error) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      resolve({
        name: check.name,
        command: check.command,
        exitCode: null,
        passed: false,
        durationMs,
        stdout,
        stderr,
        error: err.message,
      });
    });

    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      const passed = !killed && code === expectedExitCode;

      resolve({
        name: check.name,
        command: check.command,
        exitCode: code,
        passed,
        durationMs,
        stdout,
        stderr,
        error: killed ? `Command timed out after ${timeoutMs}ms` : undefined,
      });
    });
  });
}

export async function runContract(
  rawContract: AcceptanceContract | unknown,
  cwd: string = process.cwd()
): Promise<VerificationVerdict> {
  const contract = normalizeContract(rawContract);
  const results: VerificationCheckResult[] = [];
  let allPassed = true;

  for (const check of contract.checks) {
    const res = await executeCheck(check, cwd);
    results.push(res);
    if (!res.passed) {
      allPassed = false;
    }
  }

  const passedChecks = results.filter((r) => r.passed).length;

  return {
    verdict: allPassed ? "verified" : "refuted",
    passedChecks,
    totalChecks: results.length,
    results,
  };
}
