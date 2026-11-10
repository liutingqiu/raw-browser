/**
 * Core type definitions for raw.mesh (Agent-to-Agent Blackboard & Mailbox).
 * Part of the raw sovereign agent substrate.
 */

export type TaskStatus =
  | "draft"
  | "dispatched"
  | "running"
  | "verifying"
  | "completed"
  | "failed"
  | "blocked";

export type MessageType =
  | "task_request"
  | "progress_update"
  | "review_request"
  | "handoff"
  | "contract_verdict";

export type ArtifactType =
  | "unified_diff"
  | "full_source"
  | "ast_patch"
  | "verification_evidence"
  | "json_data";

export interface CheckSpec {
  name: string;
  command: string;
  expectedExitCode?: number;
  timeoutMs?: number;
}

export interface AcceptanceContract {
  timeoutMs?: number;
  checks: CheckSpec[];
  protectedFiles?: string[];
}

export interface TaskRecord {
  task_id: string;
  title: string;
  creator: string;
  assignee: string;
  status: TaskStatus;
  context_data: string | null;
  contract_spec: string | null;
  result_data: string | null;
  created_at: number;
  updated_at: number;
}

export interface InboxMessageRecord {
  msg_id: string;
  task_id: string;
  sender: string;
  recipient: string;
  msg_type: MessageType;
  payload_ref: string | null;
  created_at: number;
  read_at: number | null;
}

export interface ArtifactRecord {
  artifact_hash: string;
  task_id: string;
  author: string;
  artifact_type: ArtifactType;
  content: string;
  created_at: number;
}

export interface CreateTaskOptions {
  title: string;
  creator: string;
  assignee: string;
  contextData?: Record<string, unknown> | string;
  contractSpec?: AcceptanceContract | string;
}

export interface SubmitArtifactOptions {
  taskId: string;
  author: string;
  artifactType: ArtifactType;
  content: string;
}

export interface PostMessageOptions {
  taskId: string;
  sender: string;
  recipient: string;
  msgType: MessageType;
  payload?: Record<string, unknown> | string;
}
