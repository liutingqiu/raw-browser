/**
 * Acceptance Contract Specifications for raw.verify.
 * Independent arbitration: rejects agent self-report hallucinations.
 */
import type { AcceptanceContract, CheckSpec } from "../mesh/types.js";

export interface VerificationCheckResult {
  name: string;
  command: string;
  exitCode: number | null;
  passed: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface VerificationVerdict {
  verdict: "verified" | "refuted" | "error";
  passedChecks: number;
  totalChecks: number;
  results: VerificationCheckResult[];
  protectedViolation?: string;
}

export function normalizeContract(rawContract: unknown): AcceptanceContract {
  if (!rawContract || typeof rawContract !== "object") {
    throw new Error("AcceptanceContract must be an object");
  }
  const c = rawContract as Record<string, unknown>;
  const timeoutMs = typeof c.timeoutMs === "number" ? Math.max(1000, c.timeoutMs) : 60_000;
  
  if (!Array.isArray(c.checks) || c.checks.length === 0) {
    throw new Error("AcceptanceContract must contain at least one check in checks[]");
  }

  const checks: CheckSpec[] = c.checks.map((chk: unknown, idx: number) => {
    if (!chk || typeof chk !== "object") {
      throw new Error(`checks[${idx}] must be an object`);
    }
    const item = chk as Record<string, unknown>;
    const command = String(item.command || "").trim();
    if (!command) {
      throw new Error(`checks[${idx}].command cannot be empty`);
    }
    return {
      name: String(item.name || `check-${idx + 1}`),
      command,
      expectedExitCode: typeof item.expectedExitCode === "number" ? item.expectedExitCode : 0,
      timeoutMs: typeof item.timeoutMs === "number" ? item.timeoutMs : timeoutMs,
    };
  });

  const protectedFiles: string[] = Array.isArray(c.protectedFiles)
    ? c.protectedFiles.map(String).filter(Boolean)
    : [];

  return {
    timeoutMs,
    checks,
    protectedFiles,
  };
}
