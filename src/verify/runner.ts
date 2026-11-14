/**
 * Verification Runner for raw.verify.
 * Executes independent acceptance checks and checks process exit codes.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AcceptanceContract, CheckSpec } from "../mesh/types.js";
import { normalizeContract, type VerificationVerdict, type VerificationCheckResult } from "./contract.js";

const MAX_OUTPUT = 50_000;
const MAX_PROTECTED_BYTES = 64 * 1024 * 1024;

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Git stores LF; a Windows checkout may hand us CRLF. Normalising the line
 * endings keeps a clean protected file from looking modified, while any real
 * edit still changes the hash.
 */
function normalizedSha256(buffer: Buffer): string {
  return sha256(Buffer.from(buffer.toString("utf8").replace(/\r\n/g, "\n"), "utf8"));
}

/**
 * Kill the whole process tree, not just the shell. A check like `npm test`
 * spawns children that keep the stdout pipe open; killing only /bin/sh used to
 * leave them running and the promise waiting for a `close` that never came.
 */
function killProcessTree(child: ReturnType<typeof spawn>): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      /* already gone */
    }
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    return;
  }
  try {
    // The child was spawned detached, so its pgid equals its pid.
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

function executeCheck(check: CheckSpec, cwd: string): Promise<VerificationCheckResult> {
  const start = Date.now();
  const timeoutMs = check.timeoutMs || 30_000;
  const expectedExitCode = typeof check.expectedExitCode === "number" ? check.expectedExitCode : 0;

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const isWin = process.platform === "win32";
    const shell = isWin ? "cmd.exe" : "/bin/sh";
    const shellArg = isWin ? "/c" : "-c";

    const child = spawn(shell, [shellArg, check.command], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      // A separate process group is what lets the POSIX timeout kill the
      // grandchildren as well as the shell.
      detached: !isWin,
      windowsHide: true,
    });

    const finish = (result: VerificationCheckResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      resolve(result);
    };

    const timer = setTimeout(() => {
      killProcessTree(child);
      finish({
        name: check.name,
        command: check.command,
        exitCode: null,
        passed: false,
        durationMs: Date.now() - start,
        stdout,
        stderr,
        error: `Command timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > MAX_OUTPUT) stdout = stdout.slice(-MAX_OUTPUT);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > MAX_OUTPUT) stderr = stderr.slice(-MAX_OUTPUT);
    });

    child.on("error", (err: Error) => {
      finish({
        name: check.name,
        command: check.command,
        exitCode: null,
        passed: false,
        durationMs: Date.now() - start,
        stdout,
        stderr,
        error: err.message,
      });
    });

    child.on("close", (code: number | null) => {
      finish({
        name: check.name,
        command: check.command,
        exitCode: code,
        passed: code === expectedExitCode,
        durationMs: Date.now() - start,
        stdout,
        stderr,
      });
    });
  });
}

/* ------------------------------------------------------------------ *
 * Protected files: tests an agent must not rewrite to "pass"
 * ------------------------------------------------------------------ */

interface ProtectedBaseline {
  file: string;
  /** Content hash for non-git snapshots; null when git is the source of truth. */
  hash: string | null;
  git: boolean;
}

interface ProtectedSnapshot {
  baseline: ProtectedBaseline[];
  violation?: string;
}

function git(cwd: string, args: string[]): { status: number; stdout: Buffer } {
  try {
    const result = spawnSync("git", ["-C", cwd, ...args], {
      maxBuffer: MAX_PROTECTED_BYTES,
      windowsHide: true,
    });
    return {
      status: result.status ?? 1,
      stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? ""),
    };
  } catch {
    return { status: 1, stdout: Buffer.alloc(0) };
  }
}

function repoRoot(cwd: string): string | null {
  if (git(cwd, ["rev-parse", "--is-inside-work-tree"]).status !== 0) return null;
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  const root = top.stdout.toString("utf8").trim();
  return top.status === 0 && root ? root : null;
}

/**
 * `git status --porcelain -- <path>` is compared against HEAD. Letting git
 * resolve the path avoids the symlinked-temp-directory and short-path problems
 * that made a relative-path calculation report a clean file as untracked.
 */
function gitDirty(cwd: string, file: string): { tracked: boolean; dirty: string } {
  const tracked = git(cwd, ["ls-files", "--error-unmatch", "--", file]).status === 0;
  if (!tracked) return { tracked, dirty: "" };
  const status = git(cwd, ["status", "--porcelain", "--", file]);
  return { tracked, dirty: status.status === 0 ? status.stdout.toString("utf8").trim() : "?" };
}

/** Hash of each protected file as it is at the start of verification. */
export function snapshotProtectedFiles(cwd: string, files: string[] = []): ProtectedSnapshot {
  if (files.length === 0) return { baseline: [] };
  const root = repoRoot(cwd);
  const baseline: ProtectedBaseline[] = [];
  let violation: string | undefined;

  for (const file of files) {
    const abs = path.resolve(cwd, file);
    if (!fs.existsSync(abs)) {
      violation ??= `protected file is missing: ${file}`;
      baseline.push({ file, hash: null, git: Boolean(root) });
      continue;
    }

    if (root) {
      const state = gitDirty(cwd, file);
      if (!state.tracked) {
        // Tracked nowhere in HEAD: there is no trusted version to compare against.
        violation ??= `protected file is not tracked at HEAD: ${file}`;
      } else if (state.dirty) {
        violation ??= `protected file was modified against HEAD: ${file}`;
      }
      baseline.push({ file, hash: null, git: true });
      continue;
    }
    baseline.push({ file, hash: normalizedSha256(fs.readFileSync(abs)), git: false });
  }

  return { baseline, violation };
}

/** Compare the files again after the checks ran. */
export function verifyProtectedFiles(cwd: string, snapshot: ProtectedSnapshot): string | undefined {
  let violation = snapshot.violation;
  for (const entry of snapshot.baseline) {
    const abs = path.resolve(cwd, entry.file);
    if (!fs.existsSync(abs)) {
      violation ??= `protected file was deleted during verification: ${entry.file}`;
      continue;
    }
    if (entry.git) {
      const state = gitDirty(cwd, entry.file);
      if (!state.tracked) {
        violation ??= `protected file is no longer tracked at HEAD: ${entry.file}`;
      } else if (state.dirty) {
        violation ??= `protected file changed during verification: ${entry.file}`;
      }
      continue;
    }
    if (entry.hash !== null && normalizedSha256(fs.readFileSync(abs)) !== entry.hash) {
      violation ??= `protected file changed during verification: ${entry.file}`;
    }
  }
  return violation;
}

export async function runContract(
  rawContract: AcceptanceContract | unknown,
  cwd: string = process.cwd()
): Promise<VerificationVerdict> {
  const contract = normalizeContract(rawContract);
  if (!fs.existsSync(cwd)) {
    throw new Error(`verification cwd does not exist: ${cwd}`);
  }

  const snapshot = snapshotProtectedFiles(cwd, contract.protectedFiles ?? []);
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
  const protectedViolation = verifyProtectedFiles(cwd, snapshot);
  const verdict = allPassed && protectedViolation === undefined ? "verified" : "refuted";

  return {
    verdict,
    passedChecks,
    totalChecks: results.length,
    results,
    ...(protectedViolation ? { protectedViolation } : {}),
  };
}
