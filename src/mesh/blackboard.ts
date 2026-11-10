/**
 * SQLite-backed Blackboard and Mailbox storage engine for raw.mesh.
 * Zero-dependency: built directly on Node 22 native node:sqlite.
 */
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type {
  TaskRecord,
  TaskStatus,
  InboxMessageRecord,
  ArtifactRecord,
  CreateTaskOptions,
  SubmitArtifactOptions,
  PostMessageOptions,
} from "./types.js";

export function getDefaultDbPath(): string {
  const meshDir = path.join(os.homedir(), ".raw", "mesh");
  if (!fs.existsSync(meshDir)) {
    fs.mkdirSync(meshDir, { recursive: true });
  }
  return path.join(meshDir, "blackboard.db");
}

export class Blackboard {
  private db: DatabaseSync;

  constructor(dbPath: string = getDefaultDbPath()) {
    if (dbPath !== ":memory:") {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    this.db = new DatabaseSync(dbPath);
    this.initPragmas();
    this.initTables();
  }

  private initPragmas(): void {
    try {
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec("PRAGMA synchronous = NORMAL;");
      this.db.exec("PRAGMA foreign_keys = ON;");
    } catch {
      // In-memory or fallback environments may safely ignore some pragmas
    }
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        creator TEXT NOT NULL,
        assignee TEXT NOT NULL,
        status TEXT NOT NULL,
        context_data TEXT,
        contract_spec TEXT,
        result_data TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_hash TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        author TEXT NOT NULL,
        artifact_type TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS inbox_messages (
        msg_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        sender TEXT NOT NULL,
        recipient TEXT NOT NULL,
        msg_type TEXT NOT NULL,
        payload_ref TEXT,
        created_at INTEGER NOT NULL,
        read_at INTEGER,
        FOREIGN KEY(task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee, status);
      CREATE INDEX IF NOT EXISTS idx_inbox_recipient ON inbox_messages(recipient, read_at);
      CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id);
    `);
  }

  /** Create a new collaborative task on the blackboard */
  createTask(opts: CreateTaskOptions): TaskRecord {
    const taskId = "task-" + randomUUID().slice(0, 8);
    const now = Date.now();
    const contextDataStr = typeof opts.contextData === "object"
      ? JSON.stringify(opts.contextData)
      : opts.contextData ?? null;
    const contractSpecStr = typeof opts.contractSpec === "object"
      ? JSON.stringify(opts.contractSpec)
      : opts.contractSpec ?? null;

    const stmt = this.db.prepare(`
      INSERT INTO tasks (
        task_id, title, creator, assignee, status,
        context_data, contract_spec, result_data, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `);

    stmt.run(
      taskId,
      opts.title,
      opts.creator,
      opts.assignee,
      "dispatched",
      contextDataStr,
      contractSpecStr,
      now,
      now
    );

    return this.getTask(taskId)!;
  }

  /** Retrieve a single task by ID */
  getTask(taskId: string): TaskRecord | null {
    const stmt = this.db.prepare("SELECT * FROM tasks WHERE task_id = ?");
    const row = stmt.get(taskId) as TaskRecord | undefined;
    return row ?? null;
  }

  /** Update task status and optional execution verdict/result */
  updateTaskStatus(taskId: string, status: TaskStatus, resultData?: Record<string, unknown> | string): boolean {
    const now = Date.now();
    const resultStr = typeof resultData === "object"
      ? JSON.stringify(resultData)
      : resultData ?? null;

    const stmt = this.db.prepare(`
      UPDATE tasks
      SET status = ?, result_data = COALESCE(?, result_data), updated_at = ?
      WHERE task_id = ?
    `);
    const res = stmt.run(status, resultStr, now, taskId);
    return res.changes > 0;
  }

  /** List tasks, optionally filtered by assignee or status */
  listTasks(filter: { assignee?: string; status?: TaskStatus } = {}): TaskRecord[] {
    let query = "SELECT * FROM tasks";
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filter.assignee) {
      conditions.push("assignee = ?");
      params.push(filter.assignee);
    }
    if (filter.status) {
      conditions.push("status = ?");
      params.push(filter.status);
    }

    if (conditions.length > 0) {
      query += " WHERE " + conditions.join(" AND ");
    }
    query += " ORDER BY created_at DESC";

    const stmt = this.db.prepare(query);
    return stmt.all(...params) as TaskRecord[];
  }

  /** Store a code artifact or verification bundle */
  submitArtifact(opts: SubmitArtifactOptions): ArtifactRecord {
    const hash = createHash("sha256").update(opts.content, "utf8").digest("hex");
    const now = Date.now();

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO artifacts (
        artifact_hash, task_id, author, artifact_type, content, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(hash, opts.taskId, opts.author, opts.artifactType, opts.content, now);

    return {
      artifact_hash: hash,
      task_id: opts.taskId,
      author: opts.author,
      artifact_type: opts.artifactType,
      content: opts.content,
      created_at: now,
    };
  }

  /** Get an artifact by hash */
  getArtifact(hash: string): ArtifactRecord | null {
    const stmt = this.db.prepare("SELECT * FROM artifacts WHERE artifact_hash = ?");
    const row = stmt.get(hash) as ArtifactRecord | undefined;
    return row ?? null;
  }

  /** Post a message to an agent's inbox */
  postMessage(opts: PostMessageOptions): InboxMessageRecord {
    const msgId = "msg-" + randomUUID().slice(0, 8);
    const now = Date.now();
    const payloadStr = typeof opts.payload === "object"
      ? JSON.stringify(opts.payload)
      : opts.payload ?? null;

    const stmt = this.db.prepare(`
      INSERT INTO inbox_messages (
        msg_id, task_id, sender, recipient, msg_type, payload_ref, created_at, read_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    `);
    stmt.run(msgId, opts.taskId, opts.sender, opts.recipient, opts.msgType, payloadStr, now);

    return {
      msg_id: msgId,
      task_id: opts.taskId,
      sender: opts.sender,
      recipient: opts.recipient,
      msg_type: opts.msgType,
      payload_ref: payloadStr,
      created_at: now,
      read_at: null,
    };
  }

  /** Poll inbox messages for a recipient */
  pollInbox(recipient: string, opts: { unreadOnly?: boolean } = { unreadOnly: true }): InboxMessageRecord[] {
    let query = "SELECT * FROM inbox_messages WHERE recipient = ?";
    const params: (string | number)[] = [recipient];

    if (opts.unreadOnly) {
      query += " AND read_at IS NULL";
    }
    query += " ORDER BY created_at ASC";

    const stmt = this.db.prepare(query);
    return stmt.all(...params) as InboxMessageRecord[];
  }

  /** Mark a message as read */
  markMessageRead(msgId: string): boolean {
    const now = Date.now();
    const stmt = this.db.prepare("UPDATE inbox_messages SET read_at = ? WHERE msg_id = ?");
    const res = stmt.run(now, msgId);
    return res.changes > 0;
  }

  /** Close the database sync instance */
  close(): void {
    try {
      this.db.close();
    } catch {
      // Ignore already closed
    }
  }
}
