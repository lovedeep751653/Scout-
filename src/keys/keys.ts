import type { Db } from '../db/index.ts';
import { newId, randomBase62, safeEqual, type Secrets, sha256Hex } from '../security/crypto.ts';

// An "app key" (sct_sec_...) is what a connected app's SERVER uses to call Scout.
// It is never meant for browsers; browsers get short-lived user tokens instead.
export const APP_SCOPES = ['chat', 'users:token', 'tools:manage', 'connectors', 'settings', 'sessions:read', 'data:export', 'data:delete', 'keys:rotate'] as const;
export type Scope = (typeof APP_SCOPES)[number];

export const APP_KEY_PATTERN = /^sct_sec_[A-Za-z0-9]{20,80}$/;

export interface ApiKey {
  id: string;
  projectId: string;
  name: string;
  hint: string;
  scopes: Scope[];
  source: 'generated' | 'env' | 'rotated';
  rateLimitPerMin: number;
  monthlyTokenBudget: number;
  expiresAt: number | null;
  revokedAt: number | null;
  replacedBy: string | null;
  lastUsedAt: number | null;
  createdAt: number;
}

interface KeyRow {
  id: string;
  project_id: string;
  name: string;
  key_hash: string;
  key_hint: string;
  scopes: string;
  source: string;
  rate_limit_per_min: number;
  monthly_token_budget: number;
  expires_at: number | null;
  revoked_at: number | null;
  replaced_by: string | null;
  last_used_at: number | null;
  created_at: number;
}

const n = (v: number | null) => (v === null || v === undefined ? null : Number(v));

function toKey(r: KeyRow): ApiKey {
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    hint: r.key_hint,
    scopes: JSON.parse(r.scopes) as Scope[],
    source: r.source as ApiKey['source'],
    rateLimitPerMin: Number(r.rate_limit_per_min),
    monthlyTokenBudget: Number(r.monthly_token_budget),
    expiresAt: n(r.expires_at),
    revokedAt: n(r.revoked_at),
    replacedBy: r.replaced_by,
    lastUsedAt: n(r.last_used_at),
    createdAt: Number(r.created_at),
  };
}

export class KeyInputError extends Error {}

// ---------- origins (for the browser widget's user-token calls) ----------

export function normalizeOrigin(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  const wildcard = v.match(/^(https?):\/\/\*\.([a-z0-9.-]+)(:\d+)?$/);
  if (wildcard) return `${wildcard[1]}://*.${wildcard[2]}${wildcard[3] ?? ''}`;
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash || u.username) return null;
    return u.origin;
  } catch {
    return null;
  }
}

export function cleanOrigins(list: unknown): string[] {
  if (!Array.isArray(list)) throw new KeyInputError('allowed_origins must be a list like ["https://loginlens.example.com"].');
  const out = new Set<string>();
  for (const item of list.slice(0, 50)) {
    const o = typeof item === 'string' ? normalizeOrigin(item) : null;
    if (!o) throw new KeyInputError(`"${String(item)}" is not a valid origin. Use the form https://example.com (no path).`);
    out.add(o);
  }
  return [...out];
}

export function originAllowed(allowed: string[], origin: string | undefined): boolean {
  // A browser always sends a concrete origin; a pattern here is never legitimate.
  if (!origin || origin.includes('*')) return false;
  const o = normalizeOrigin(origin);
  if (!o) return false;
  for (const a of allowed) {
    if (a === o) return true;
    if (a.includes('://*.')) {
      const [scheme, rest] = a.split('://*.');
      const u = new URL(o);
      if (u.protocol === `${scheme}:` && u.host.endsWith(`.${rest}`)) return true;
    }
  }
  return false;
}

// ---------- app keys ----------

export interface CreateKeyInput {
  projectId: string;
  name?: string;
  scopes?: string[];
  rateLimitPerMin: number;
  monthlyTokenBudget?: number;
  expiresAt?: number | null;
  source?: ApiKey['source'];
  plaintext?: string;
}

function cleanScopes(scopes: string[] | undefined): Scope[] {
  if (!scopes) return [...APP_SCOPES];
  const bad = scopes.filter((s) => !(APP_SCOPES as readonly string[]).includes(s));
  if (bad.length) throw new KeyInputError(`Unknown scopes: ${bad.join(', ')}. Allowed: ${APP_SCOPES.join(', ')}.`);
  return [...new Set(scopes)] as Scope[];
}

export function generateAppKey(): string {
  return `sct_sec_${randomBase62(40)}`;
}

export async function createKey(db: Db, input: CreateKeyInput): Promise<{ key: ApiKey; plaintext: string }> {
  const plaintext = input.plaintext ?? generateAppKey();
  if (!APP_KEY_PATTERN.test(plaintext)) throw new KeyInputError('An app key must look like sct_sec_ followed by 20-80 letters and numbers.');
  const now = Date.now();
  const key: ApiKey = {
    id: newId('key'),
    projectId: input.projectId,
    name: (input.name ?? '').trim().slice(0, 80) || 'App key',
    hint: `${plaintext.slice(0, 12)}…${plaintext.slice(-4)}`,
    scopes: cleanScopes(input.scopes),
    source: input.source ?? 'generated',
    rateLimitPerMin: Math.max(1, Math.min(100_000, Math.floor(input.rateLimitPerMin))),
    monthlyTokenBudget: Math.max(0, Math.floor(input.monthlyTokenBudget ?? 0)),
    expiresAt: input.expiresAt ?? null,
    revokedAt: null,
    replacedBy: null,
    lastUsedAt: null,
    createdAt: now,
  };
  await db.run(
    `INSERT INTO api_keys (id, project_id, name, key_hash, key_hint, scopes, source, rate_limit_per_min, monthly_token_budget, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [key.id, key.projectId, key.name, sha256Hex(plaintext), key.hint, JSON.stringify(key.scopes), key.source, key.rateLimitPerMin, key.monthlyTokenBudget, key.expiresAt, now],
  );
  clearKeyCache();
  return { key, plaintext };
}

export async function getKey(db: Db, id: string): Promise<ApiKey | undefined> {
  const row = await db.get<KeyRow>('SELECT * FROM api_keys WHERE id = ?', [id]);
  return row ? toKey(row) : undefined;
}

export async function findKeyByPlaintext(db: Db, plaintext: string): Promise<ApiKey | undefined> {
  const row = await db.get<KeyRow>('SELECT * FROM api_keys WHERE key_hash = ?', [sha256Hex(plaintext)]);
  return row ? toKey(row) : undefined;
}

export async function listKeys(db: Db, projectId: string): Promise<ApiKey[]> {
  return (await db.all<KeyRow>('SELECT * FROM api_keys WHERE project_id = ? ORDER BY created_at', [projectId])).map(toKey);
}

export function keyStatus(key: ApiKey, now = Date.now()): 'active' | 'revoked' | 'expired' {
  if (key.revokedAt !== null && key.revokedAt <= now) return 'revoked';
  if (key.expiresAt !== null && key.expiresAt <= now) return 'expired';
  return 'active';
}

export async function activeKeys(db: Db, projectId: string, now = Date.now()): Promise<ApiKey[]> {
  return (await listKeys(db, projectId)).filter((k) => keyStatus(k, now) === 'active');
}

export type KeyCheck = { ok: true; key: ApiKey } | { ok: false; reason: 'not_found' | 'revoked' | 'expired' };

const cache = new Map<string, { key: ApiKey; at: number }>();
const CACHE_MS = 15_000;

export function clearKeyCache(): void {
  cache.clear();
}

export async function verifyKey(db: Db, plaintext: string, now = Date.now()): Promise<KeyCheck> {
  if (!APP_KEY_PATTERN.test(plaintext)) return { ok: false, reason: 'not_found' };
  const hash = sha256Hex(plaintext);
  let hit = cache.get(hash);
  if (!hit || now - hit.at > CACHE_MS) {
    const row = await db.get<KeyRow>('SELECT * FROM api_keys WHERE key_hash = ?', [hash]);
    if (!row || !safeEqual(row.key_hash, hash)) return { ok: false, reason: 'not_found' };
    hit = { key: toKey(row), at: now };
    cache.set(hash, hit);
    if (hit.key.lastUsedAt === null || now - hit.key.lastUsedAt > 60_000) {
      await db.run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', [now, row.id]);
    }
  }
  const status = keyStatus(hit.key, now);
  if (status !== 'active') return { ok: false, reason: status };
  return { ok: true, key: hit.key };
}

export async function revokeKey(db: Db, id: string, at = Date.now()): Promise<boolean> {
  const r = await db.run('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND (revoked_at IS NULL OR revoked_at > ?)', [at, id, at]);
  clearKeyCache();
  return r.changes > 0;
}

export async function reactivateKey(db: Db, id: string): Promise<void> {
  await db.run('UPDATE api_keys SET revoked_at = NULL, replaced_by = NULL, expires_at = NULL WHERE id = ?', [id]);
  clearKeyCache();
}

export async function markEnvKey(db: Db, id: string): Promise<void> {
  await db.run("UPDATE api_keys SET source = 'env' WHERE id = ?", [id]);
  clearKeyCache();
}

// Makes a new key with the same settings. The old key keeps working for `graceMs`
// so the connected app can switch over without downtime.
export async function rotateKey(db: Db, id: string, graceMs: number): Promise<{ key: ApiKey; plaintext: string } | undefined> {
  // A bad grace value must never leave the old key valid forever.
  if (!Number.isFinite(graceMs)) graceMs = 0;
  const old = await getKey(db, id);
  if (!old || keyStatus(old) !== 'active') return undefined;
  return db.transaction(async (tx) => {
    const created = await createKey(tx, {
      projectId: old.projectId,
      name: old.name,
      scopes: old.scopes,
      rateLimitPerMin: old.rateLimitPerMin,
      monthlyTokenBudget: old.monthlyTokenBudget,
      expiresAt: old.expiresAt,
      source: 'rotated',
    });
    await tx.run('UPDATE api_keys SET revoked_at = ?, replaced_by = ? WHERE id = ?', [Date.now() + Math.max(0, graceMs), created.key.id, id]);
    clearKeyCache();
    return created;
  });
}

export function keyView(key: ApiKey) {
  return {
    id: key.id,
    name: key.name,
    hint: key.hint,
    scopes: key.scopes,
    source: key.source,
    rate_limit_per_min: key.rateLimitPerMin,
    monthly_token_budget: key.monthlyTokenBudget,
    expires_at: key.expiresAt,
    revoked_at: key.revokedAt,
    replaced_by: key.replacedBy,
    last_used_at: key.lastUsedAt,
    created_at: key.createdAt,
    status: keyStatus(key),
  };
}

// ---------- user tokens ----------
// The connected app's server mints a short-lived token for one of its signed-in users,
// so the browser chat window can talk to Scout without ever holding the app key.

export function mintUserToken(secrets: Secrets, projectId: string, userId: string, ttlSeconds: number, now = Date.now()): { token: string; expiresAt: number } {
  const exp = Math.floor(now / 1000) + ttlSeconds;
  const payload = Buffer.from(JSON.stringify({ p: projectId, u: userId, exp })).toString('base64url');
  return { token: `sct_ut_${payload}.${secrets.sign(payload, 'user-token')}`, expiresAt: exp * 1000 };
}

export function verifyUserToken(secrets: Secrets, token: string, now = Date.now()): { projectId: string; userId: string } | null {
  const m = /^sct_ut_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token);
  if (!m) return null;
  if (!safeEqual(secrets.sign(m[1]!, 'user-token'), m[2]!)) return null;
  try {
    const data = JSON.parse(Buffer.from(m[1]!, 'base64url').toString('utf8')) as { p: string; u: string; exp: number };
    if (typeof data.p !== 'string' || typeof data.u !== 'string' || typeof data.exp !== 'number' || data.exp * 1000 <= now) return null;
    return { projectId: data.p, userId: data.u };
  } catch {
    return null;
  }
}

export const USER_ID_PATTERN = /^[A-Za-z0-9_.:@+-]{1,128}$/;
