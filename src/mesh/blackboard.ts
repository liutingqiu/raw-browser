/**
 * SQLite-backed Blackboard and Mailbox storage engine for raw.mesh.
 * Zero-dependency: built directly on Node 22 native node:sqlite.
 *
 * Concurrency: several agent processes may share one database file, so writes
 * use a busy timeout instead of failing with "database is locked" the moment a
 * second writer appears.
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

export const TASK_STATUSES: readonly TaskStatus[] = [
  "draft",
  "dispatched",
  "running",
  "verifying",
  "completed",
  "failed",
  "blocked",
];

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value);
}

/** `RAW_HOME` selects the same home the browser runtime uses. */
export function rawHome(): string {
  return process.env.RAW_HOME || path.join(os.homedir(), ".raw");
}

export function getDefaultDbPath(): string {
  const meshDir = path.join(rawHome(), "mesh");
  if (!fs.existsSync(meshDir)) {
    fs.mkdirSync(meshDir, { recursive: true });
  }
  return path.join(meshDir, "blackboard.db");
}

/** Current schema: artifacts are keyed by (task_id, artifact_hash). */
const SCHEMA_VERSION = 2;

type SqlRow = Record<string, unknown>;

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
    this.migrate();
  }

  private initPragmas(): void {
    try {
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec("PRAGMA synchronous = NORMAL;");
      this.db.exec("PRAGMA foreign_keys = ON;");
      // Two agents writing at the same moment used to make one of them fail
      // with SQLITE_BUSY immediately; wait for the other writer instead.
      this.db.exec("PRAGMA busy_timeout = 5000;");
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
        artifact_hash TEXT NOT NULL,
        task_id TEXT NOT NULL,
        author TEXT NOT NULL,
        artifact_type TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (task_id, artifact_hash),
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
      CREATE INDEX IF NOT EXISTS idx_artifacts_hash ON artifacts(artifact_hash);
    `);
  }

  /** Version 1 keyed artifacts only by content hash, so one task's upload
   * overwrote another task's row. Rebuild the table once, keeping every row. */
  private migrate(): void {
    const version = this.schemaVersion();
    if (version >= SCHEMA_VERSION) return;

    if (this.artifactsTableExists() && !this.artifactsHaveCompositeKey()) {
      this.db.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE artifacts RENAME TO artifacts_legacy;
        CREATE TABLE artifacts (
          artifact_hash TEXT NOT NULL,
          task_id TEXT NOT NULL,
          author TEXT NOT NULL,
          artifact_type TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (task_id, artifact_hash),
          FOREIGN KEY(task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
        );
        INSERT OR IGNORE INTO artifacts (artifact_hash, task_id, author, artifact_type, content, created_at)
          SELECT artifact_hash, task_id, author, artifact_type, content, created_at FROM artifacts_legacy;
        DROP TABLE artifacts_legacy;
        CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id);
        CREATE INDEX IF NOT EXISTS idx_artifacts_hash ON artifacts(artifact_hash);
        COMMIT;
      `);
    }
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
  }

  /** Exposed for migration tests and status reporting. */
  schemaVersion(): number {
    const row = this.db.prepare("PRAGMA user_version").get() as SqlRow | undefined;
    return Number(row?.user_version ?? 0);
  }

  private artifactsTableExists(): boolean {
    const row = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'artifacts'")
      .get() as SqlRow | undefined;
    return row !== undefined;
  }

  private artifactsHaveCompositeKey(): boolean {
    const rows = this.db.prepare("PRAGMA table_info(artifacts)").all() as SqlRow[];
    const primary = rows.filter((row) => Number(row.pk ?? 0) > 0);
    return primary.length === 2 &&
      primary.some((row) => row.name === "task_id") &&
      primary.some((row) => row.name === "artifact_hash");
  }

  /** Create a new collaborative task on the blackboard */
  createTask(opts: CreateTaskOptions): TaskRecord {
    const title = typeof opts.title === "string" ? opts.title.trim() : "";
    if (!title) throw new Error("task title cannot be empty");
    const creator = typeof opts.creator === "string" ? opts.creator.trim() : "";
    const assignee = typeof opts.assignee === "string" ? opts.assignee.trim() : "";
    if (!creator) throw new Error("task creator cannot be empty");
    if (!assignee) throw new Error("task assignee cannot be empty");

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
      title,
      creator,
      assignee,
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
    const row = stmt.get(taskId) as unknown as TaskRecord | undefined;
    return row ?? null;
  }

  /** Update task status and optional execution verdict/result */
  updateTaskStatus(taskId: string, status: TaskStatus, resultData?: Record<string, unknown> | string): boolean {
    if (!isTaskStatus(status)) {
      throw new Error(`invalid task status "${String(status)}"; expected one of ${TASK_STATUSES.join(", ")}`);
    }
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
      if (!isTaskStatus(filter.status)) {
        throw new Error(`invalid task status "${String(filter.status)}"; expected one of ${TASK_STATUSES.join(", ")}`);
      }
      conditions.push("status = ?");
      params.push(filter.status);
    }

    if (conditions.length > 0) {
      query += " WHERE " + conditions.join(" AND ");
    }
    query += " ORDER BY created_at DESC";

    const stmt = this.db.prepare(query);
    return stmt.all(...params) as unknown as TaskRecord[];
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

  /**
   * Get an artifact by content hash. Pass the task id when the same content
   * was submitted to more than one task; without it the newest row wins.
   */
  getArtifact(hash: string, taskId?: string): ArtifactRecord | null {
    const stmt = taskId
      ? this.db.prepare("SELECT * FROM artifacts WHERE artifact_hash = ? AND task_id = ?")
      : this.db.prepare("SELECT * FROM artifacts WHERE artifact_hash = ? ORDER BY created_at DESC LIMIT 1");
    const row = (taskId ? stmt.get(hash, taskId) : stmt.get(hash)) as unknown as ArtifactRecord | undefined;
    return row ?? null;
  }

  /** Every artifact attached to one task */
  listArtifacts(taskId: string): ArtifactRecord[] {
    const stmt = this.db.prepare("SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at ASC");
    return stmt.all(taskId) as unknown as ArtifactRecord[];
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
    return stmt.all(...params) as unknown as InboxMessageRecord[];
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
