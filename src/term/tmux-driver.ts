/**
 * Tmux driver and topology router for raw.term.
 * Zero-dependency: interacts with local tmux server via native child_process.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { markRead, requireRead, clearRead } from "./read-guard.js";

const execFileAsync = promisify(execFile);

export interface TmuxPaneInfo {
  paneId: string;
  paneIndex: number;
  paneTitle: string;
  currentCommand: string;
  isCurrent: boolean;
}

export class TmuxDriver {
  private socketPath?: string;

  constructor(socketPath?: string) {
    this.socketPath = socketPath || process.env.TMUX_SOCKET;
  }

  private buildArgs(subcommand: string, args: string[]): string[] {
    const base: string[] = [];
    if (this.socketPath) {
      base.push("-S", this.socketPath);
    }
    base.push(subcommand, ...args);
    return base;
  }

  private async runTmux(subcommand: string, args: string[]): Promise<string> {
    const fullArgs = this.buildArgs(subcommand, args);
    const { stdout } = await execFileAsync("tmux", fullArgs, { encoding: "utf8" });
    return stdout;
  }

  /** Check whether a tmux server is reachable */
  async isAvailable(): Promise<boolean> {
    try {
      await this.runTmux("list-sessions", []);
      return true;
    } catch {
      return false;
    }
  }

  /** Enumerate all panes in the active or target session */
  async listPanes(targetSession?: string): Promise<TmuxPaneInfo[]> {
    const format = "#{pane_id}|#{pane_index}|#{pane_title}|#{pane_current_command}|#{pane_active}";
    const args = ["-a", "-F", format];
    if (targetSession) {
      args.unshift("-t", targetSession);
    }

    const output = await this.runTmux("list-panes", args);
    const lines = output.trim().split("\n").filter(Boolean);

    return lines.map((line) => {
      const [paneId, paneIndex, paneTitle, currentCommand, activeStr] = line.split("|");
      return {
        paneId: paneId || "",
        paneIndex: Number(paneIndex) || 0,
        paneTitle: paneTitle || "",
        currentCommand: currentCommand || "",
        isCurrent: activeStr === "1",
      };
    });
  }

  /** Read captured output from a specific pane, updating the read-guard */
  async peekPane(target: string, lines: number = 50): Promise<string> {
    const boundedLines = Math.max(1, Math.min(lines, 500));
    const args = ["-p", "-t", target, "-S", `-${boundedLines}`];
    const output = await this.runTmux("capture-pane", args);
    markRead(target);
    return output;
  }

  /** Send a safe wake signal to target pane with Read-Before-Act verification */
  async wakePane(target: string, taskId: string): Promise<boolean> {
    // 1. Strict format check on taskId to prevent any shell escape
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(taskId)) {
      throw new Error(`Invalid taskId for wake signal: "${taskId}"`);
    }

    // 2. Enforce read-before-act guard
    requireRead(target);

    // 3. Inject minimal wake signal
    const signalCommand = `raw pickup ${taskId}`;
    await this.runTmux("send-keys", ["-t", target, "-l", signalCommand]);
    await this.runTmux("send-keys", ["-t", target, "Enter"]);

    // 4. Invalidate guard
    clearRead(target);
    return true;
  }

  /** Set custom title or name for a pane (e.g. "claude", "codex", "dsh") */
  async namePane(target: string, name: string): Promise<boolean> {
    const cleanName = name.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
    if (!cleanName) {
      throw new Error("Pane name must contain alphanumeric characters");
    }
    await this.runTmux("select-pane", ["-t", target, "-T", cleanName]);
    return true;
  }
}
