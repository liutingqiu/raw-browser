/**
 * Defense-in-depth Envelope Parser & Serializer for raw.mesh.
 * Shields prompt context from delimiter injection and XML mangling.
 */
import type { InboxMessageRecord } from "./types.js";

export class Mailbox {
  static escapeXmlAttr(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  /**
   * Neutralize attempts to prematurely close or inject envelope tags.
   */
  static sanitizeBody(text: string): string {
    return text.replace(/<(\/?raw-envelope)/gi, "&lt;$1");
  }

  /** Wrap an inbox message into a safe XML envelope for prompt consumption */
  static wrapEnvelope(msg: InboxMessageRecord, taskTitle?: string): string {
    const esc = Mailbox.escapeXmlAttr;
    const body = msg.payload_ref ? Mailbox.sanitizeBody(msg.payload_ref) : "";
    const titleAttr = taskTitle ? ` task-title="${esc(taskTitle)}"` : "";

    return [
      `<raw-envelope msg-id="${esc(msg.msg_id)}" task-id="${esc(msg.task_id)}"${titleAttr} from="${esc(msg.sender)}" to="${esc(msg.recipient)}" type="${esc(msg.msg_type)}" timestamp="${msg.created_at}">`,
      body,
      "</raw-envelope>",
    ].join("\n");
  }

  /** Quick parse attributes from an envelope tag */
  static parseEnvelopeHeader(envelopeText: string): Record<string, string> {
    const match = envelopeText.match(/<raw-envelope\s+([^>]+)>/i);
    if (!match) return {};
    const attrsStr = match[1];
    const attrs: Record<string, string> = {};
    const attrRegex = /([a-z0-9_-]+)="([^"]*)"/gi;
    let m: RegExpExecArray | null;
    while ((m = attrRegex.exec(attrsStr)) !== null) {
      attrs[m[1]] = m[2];
    }
    return attrs;
  }
}
