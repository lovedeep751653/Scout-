import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { userSubject } from '../keys/limits.ts';
import type { Message, ModelProvider, Part, Usage } from '../providers/types.ts';
import { newId } from '../security/crypto.ts';
import { cleanText } from '../security/redact.ts';
import { SUMMARY_SYSTEM } from './prompt.ts';

export interface Session {
  id: string;
  projectId: string;
  userId: string;
  keyId: string | null;
  title: string | null;
  summary: string | null;
  summaryUpto: number;
  language: string | null;
  createdAt: number;
  updatedAt: number;
}

interface SessionRow {
  id: string;
  project_id: string;
  user_id: string;
  key_id: string | null;
  title: string | null;
  summary: string | null;
  summary_upto: number;
  language: string | null;
  created_at: number;
  updated_at: number;
}

export interface StoredMessage {
  id: string;
  seq: number;
  role: 'user' | 'assistant';
  parts: Part[];
  feedback: number | null;
  createdAt: number;
}

function toSession(r: SessionRow): Session {
  return {
    id: r.id,
    projectId: r.project_id,
    userId: r.user_id,
    keyId: r.key_id,
    title: r.title,
    summary: r.summary,
    summaryUpto: Number(r.summary_upto),
    language: r.language,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

// Sessions are always looked up together with the owner, so one user can never open
// another user's conversation even with a guessed id.
export async function getSession(db: Db, projectId: string, userId: string, id: string): Promise<Session | undefined> {
  const row = await db.get<SessionRow>('SELECT * FROM sessions WHERE id = ? AND project_id = ? AND user_id = ?', [id, projectId, userId]);
  return row ? toSession(row) : undefined;
}

export async function createSession(db: Db, s: { projectId: string; userId: string; keyId: string | null; title: string; language: string }): Promise<Session> {
  const now = Date.now();
  const id = newId('ses');
  const title = cleanText(s.title, 80);
  await db.run('INSERT INTO sessions (id, project_id, user_id, key_id, title, summary_upto, language, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)', [
    id, s.projectId, s.userId, s.keyId, title, s.language, now, now,
  ]);
  return { id, projectId: s.projectId, userId: s.userId, keyId: s.keyId, title, summary: null, summaryUpto: 0, language: s.language, createdAt: now, updatedAt: now };
}

export async function touchSession(db: Db, id: string, patch: { language?: string; summary?: string; summaryUpto?: number }): Promise<void> {
  const sets = ['updated_at = ?'];
  const params: Array<string | number> = [Date.now()];
  if (patch.language !== undefined) {
    sets.push('language = ?');
    params.push(patch.language);
  }
  if (patch.summary !== undefined) {
    sets.push('summary = ?');
    params.push(patch.summary);
  }
  if (patch.summaryUpto !== undefined) {
    sets.push('summary_upto = ?');
    params.push(patch.summaryUpto);
  }
  params.push(id);
  await db.run(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`, params);
}

interface MessageRow {
  id: string;
  seq: number;
  role: string;
  content: string;
  feedback: number | null;
  created_at: number;
}

function toStored(r: MessageRow): StoredMessage {
  return {
    id: r.id,
    seq: Number(r.seq),
    role: r.role as StoredMessage['role'],
    parts: JSON.parse(r.content) as Part[],
    feedback: r.feedback === null ? null : Number(r.feedback),
    createdAt: Number(r.created_at),
  };
}

export async function loadMessages(db: Db, sessionId: string, afterSeq = 0): Promise<StoredMessage[]> {
  return (await db.all<MessageRow>('SELECT * FROM messages WHERE session_id = ? AND seq > ? ORDER BY seq', [sessionId, afterSeq])).map(toStored);
}

// Provider-only blocks (e.g. Claude thinking) are valid only inside one run, so they are dropped.
export function storable(m: Message): Message {
  return { role: m.role, parts: m.parts.filter((p) => p.type !== 'provider_raw') };
}

export async function appendMessages(db: Db, sessionId: string, msgs: Message[]): Promise<string[]> {
  const ids: string[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await db.transaction(async (tx) => {
        ids.length = 0;
        const row = await tx.get<{ m: number | null }>('SELECT MAX(seq) AS m FROM messages WHERE session_id = ?', [sessionId]);
        let seq = Number(row?.m ?? 0);
        const now = Date.now();
        for (const m of msgs) {
          const clean = storable(m);
          if (clean.parts.length === 0) continue;
          const id = newId('msg');
          ids.push(id);
          await tx.run('INSERT INTO messages (id, session_id, seq, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, sessionId, ++seq, clean.role, JSON.stringify(clean.parts), now]);
        }
      });
      return ids;
    } catch (err) {
      if (attempt === 2 || !/unique|duplicate/i.test(String((err as Error).message))) throw err;
    }
  }
  return ids;
}

export function toMessage(s: StoredMessage): Message {
  return { role: s.role, parts: s.parts };
}

function approxChars(msgs: StoredMessage[]): number {
  return msgs.reduce((n, m) => n + JSON.stringify(m.parts).length, 0);
}

const isUserText = (m: StoredMessage) => m.role === 'user' && m.parts.some((p) => p.type === 'text');

// Picks where to cut: everything before the returned index gets summarized. The cut is
// always at a user text message so tool calls and their results are never split.
export function summaryCut(msgs: StoredMessage[], config: Config): number {
  if (msgs.length <= config.summaryKeepMessages) return 0;
  if (msgs.length < config.summaryTriggerMessages && approxChars(msgs) < config.summaryTriggerChars) return 0;
  for (let i = msgs.length - config.summaryKeepMessages; i > 0; i--) {
    if (isUserText(msgs[i]!)) return i;
  }
  return 0;
}

function transcript(msgs: StoredMessage[]): string {
  const lines: string[] = [];
  for (const m of msgs) {
    for (const p of m.parts) {
      if (p.type === 'text' && p.text) lines.push(`${m.role === 'user' ? 'User' : 'Assistant'}: ${p.text.slice(0, 1500)}`);
      else if (p.type === 'tool_call') lines.push(`Assistant used tool ${p.call.name}`);
      else if (p.type === 'tool_result') lines.push(`Tool ${p.name} returned: ${p.content.slice(0, 400)}`);
    }
  }
  return lines.join('\n');
}

export async function summarize(provider: ModelProvider, previous: string | null, msgs: StoredMessage[], signal?: AbortSignal): Promise<{ summary: string; usage: Usage }> {
  const text = `${previous ? `Earlier summary: ${previous}\n\n` : ''}Conversation to summarize:\n${transcript(msgs)}`;
  const r = await provider.generate({ system: SUMMARY_SYSTEM, messages: [{ role: 'user', parts: [{ type: 'text', text }] }], maxTokens: 400, toolChoice: 'none', signal });
  return { summary: cleanText(r.text.trim(), 1500), usage: r.usage };
}

// ---------- listing, export and deletion ----------

export async function listSessions(db: Db, projectId: string, userId: string, limit = 20) {
  const rows = await db.all<SessionRow>('SELECT * FROM sessions WHERE project_id = ? AND user_id = ? ORDER BY updated_at DESC LIMIT ?', [projectId, userId, Math.min(100, limit)]);
  return rows.map((r) => ({ id: r.id, title: r.title, language: r.language, created_at: Number(r.created_at), updated_at: Number(r.updated_at) }));
}

export function visibleMessages(msgs: StoredMessage[]) {
  return msgs
    .filter((m) => m.parts.some((p) => p.type === 'text' && p.text))
    .map((m) => {
      const text = m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('').trim();
      const meta = m.parts.find((p) => p.type === 'text' && p.meta?.cards);
      const cards = meta && meta.type === 'text' && meta.meta?.cards ? (JSON.parse(meta.meta.cards) as unknown[]) : undefined;
      return { id: m.id, role: m.role, text, ...(cards ? { cards } : {}), feedback: m.feedback, created_at: m.createdAt };
    });
}

export async function deleteSession(db: Db, projectId: string, userId: string, id: string): Promise<boolean> {
  const s = await getSession(db, projectId, userId, id);
  if (!s) return false;
  await db.run('DELETE FROM messages WHERE session_id = ?', [id]);
  await db.run('DELETE FROM pending_actions WHERE session_id = ?', [id]);
  await db.run('DELETE FROM sessions WHERE id = ?', [id]);
  return true;
}

export async function setFeedback(db: Db, projectId: string, userId: string, messageId: string, value: 1 | -1 | null): Promise<boolean> {
  const r = await db.run(
    `UPDATE messages SET feedback = ? WHERE id = ? AND role = 'assistant' AND session_id IN (SELECT id FROM sessions WHERE project_id = ? AND user_id = ?)`,
    [value, messageId, projectId, userId],
  );
  return r.changes > 0;
}

export async function exportUserData(db: Db, projectId: string, userId: string) {
  const sessions = await db.all<SessionRow>('SELECT * FROM sessions WHERE project_id = ? AND user_id = ? ORDER BY created_at', [projectId, userId]);
  const out = [];
  for (const s of sessions) {
    out.push({ id: s.id, title: s.title, summary: s.summary, created_at: Number(s.created_at), messages: visibleMessages(await loadMessages(db, s.id)) });
  }
  const notes = await db.all<{ text: string; created_at: number }>('SELECT text, created_at FROM user_notes WHERE project_id = ? AND user_id = ? ORDER BY created_at', [projectId, userId]);
  const actions = await db.all<{ tool_name: string; summary: string; status: string; created_at: number }>(
    'SELECT tool_name, summary, status, created_at FROM pending_actions WHERE project_id = ? AND user_id = ? ORDER BY created_at',
    [projectId, userId],
  );
  return { user_id: userId, exported_at: new Date().toISOString(), sessions: out, notes, actions };
}

export async function deleteUserData(db: Db, projectId: string, userId: string): Promise<{ sessions: number; notes: number; actions: number }> {
  return db.transaction(async (tx) => {
    const ids = (await tx.all<{ id: string }>('SELECT id FROM sessions WHERE project_id = ? AND user_id = ?', [projectId, userId])).map((r) => r.id);
    for (const id of ids) await tx.run('DELETE FROM messages WHERE session_id = ?', [id]);
    const sessions = (await tx.run('DELETE FROM sessions WHERE project_id = ? AND user_id = ?', [projectId, userId])).changes;
    const notes = (await tx.run('DELETE FROM user_notes WHERE project_id = ? AND user_id = ?', [projectId, userId])).changes;
    const actions = (await tx.run('DELETE FROM pending_actions WHERE project_id = ? AND user_id = ?', [projectId, userId])).changes;
    await tx.run('DELETE FROM usage_counters WHERE subject = ?', [userSubject(projectId, userId)]);
    await tx.run('UPDATE audit_log SET user_id = NULL, detail = NULL WHERE project_id = ? AND user_id = ?', [projectId, userId]);
    return { sessions, notes, actions };
  });
}
