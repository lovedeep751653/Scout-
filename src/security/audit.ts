import type { Db } from '../db/index.ts';
import { newId } from './crypto.ts';
import { redactDeep } from './redact.ts';

export interface AuditEntry {
  projectId?: string | null;
  keyId?: string | null;
  sessionId?: string | null;
  userId?: string | null;
  event: string;
  toolName?: string | null;
  status: string;
  detail?: unknown;
  durationMs?: number | null;
}

export async function audit(db: Db, e: AuditEntry): Promise<void> {
  const detail = e.detail === undefined ? null : JSON.stringify(redactDeep(e.detail)).slice(0, 2000);
  await db.run(
    `INSERT INTO audit_log (id, project_id, key_id, session_id, user_id, event, tool_name, status, detail, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [newId('aud'), e.projectId ?? null, e.keyId ?? null, e.sessionId ?? null, e.userId ?? null, e.event, e.toolName ?? null, e.status, detail, e.durationMs ?? null, Date.now()],
  );
}
