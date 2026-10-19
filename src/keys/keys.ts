import type { Db } from '../db/index.ts';
import { newId, randomBase62, safeEqual, type Secrets, sha256Hex } from '../security/crypto.ts';

export type KeyKind = 'public' | 'secret';

export const PUBLIC_SCOPES = ['chat'] as const;
export const SECRET_SCOPES = ['chat', 'tools:manage', 'users:token', 'sessions:read', 'data:export', 'data:delete', 'connectors'] as const;
export type Scope = (typeof SECRET_SCOPES)[number];

export interface ApiKey {
  id: string;
  projectId: string;
  kind: KeyKind;
  name: string;
  hint: string;
  scopes: Scope[];
  allowedOrigins: string[];
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
  kind: string;
  name: string;
  key_hash: string;
  key_hint: string;
  scopes: string;
  allowed_origins: string;
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
    kind: r.kind as KeyKind,
    name: r.name,
    hint: r.key_hint,
    scopes: JSON.parse(r.scopes) as Scope[],
    allowedOrigins: JSON.parse(r.allowed_origins) as string[],
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

// ---------- origins ----------

export function normalizeOrigin(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if (v === '*' || v === 'native') return v;
  const wildcard = v.match(/^(https?):\/\/\*\.([a-z0-9.-]+)(:\d+)?$/);
  if (wildcard) return `${wildcard[1]}://*.${wildcard[2]}${wildcard[3] ?? ''}`;
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.pathname !== '/' || u.search || u.hash || u.username) return null;
    return u.origin;
  } catch {
    return null;
  }
}

export function cleanOrigins(list: unknown): string[] {
  if (!Array.isArray(list)) throw new KeyInputError('allowed_origins must be a list like ["https://example.com"].');
  const out = new Set<string>();
  for (const item of list.slice(0, 50)) {
    const o = typeof item === 'string' ? normalizeOrigin(item) : null;
    if (!o) throw new KeyInputError(`"${String(item)}" is not a valid origin. Use the form https://example.com (no path).`);
    out.add(o);
  }
  return [...out];
}

// "native" lets apps without a browser Origin header (Android, iOS) use a public key.
export function originAllowed(allowed: string[], origin: string | undefined): boolean {
  if (!origin) return allowed.includes('native');
  const o = normalizeOrigin(origin);
  if (!o || o === '*' || o === 'native') return false;
  for (const a of allowed) {
    if (a === '*' || a === o) return true;
    if (a.includes('://*.')) {
      const [scheme, rest] = a.split('://*.');
      const u = new URL(o);
      const host = u.host;
      if (u.protocol === `${scheme}:` && host.endsWith(`.${rest}`)) return true;
    }
  }
  return false;
}

// ---------- keys ----------

export interface CreateKeyInput {
  projectId: string;
  kind: KeyKind;
  name?: string;
  allowedOrigins?: string[];
  scopes?: string[];
  rateLimitPerMin?: number;
  monthlyTokenBudget?: number;
  expiresAt?: number | null;
}

function cleanScopes(kind: KeyKind, scopes: string[] | undefined): Scope[] {
  if (kind === 'public') return [...PUBLIC_SCOPES];
  if (!scopes) return [...SECRET_SCOPES];
  const bad = scopes.filter((s) => !(SECRET_SCOPES as readonly string[]).includes(s));
  if (bad.length) throw new KeyInputError(`Unknown scopes: ${bad.join(', ')}. Allowed: ${SECRET_SCOPES.join(', ')}.`);
  return [...new Set(scopes)] as Scope[];
}

export async function createKey(db: Db, input: CreateKeyInput, defaults: { rateLimitPerMin: number; monthlyTokenBudget: number }): Promise<{ key: ApiKey; plaintext: string }> {
  const prefix = input.kind === 'public' ? 'sct_pub_' : 'sct_sec_';
  const plaintext = prefix + randomBase62(40);
  const now = Date.now();
  const key: ApiKey = {
    id: newId('key'),
    projectId: input.projectId,
    kind: input.kind,
    name: (input.name ?? '').trim().slice(0, 80) || (input.kind === 'public' ? 'Website key' : 'Server key'),
    hint: `${plaintext.slice(0, 12)}…${plaintext.slice(-4)}`,
    scopes: cleanScopes(input.kind, input.scopes),
    allowedOrigins: input.kind === 'public' ? cleanOrigins(input.allowedOrigins ?? []) : [],
    rateLimitPerMin: Math.max(1, Math.min(100_000, Math.floor(input.rateLimitPerMin ?? defaults.rateLimitPerMin))),
    monthlyTokenBudget: Math.max(0, Math.floor(input.monthlyTokenBudget ?? defaults.monthlyTokenBudget)),
    expiresAt: input.expiresAt ?? null,
    revokedAt: null,
    replacedBy: null,
    lastUsedAt: null,
    createdAt: now,
  };
  await db.run(
    `INSERT INTO api_keys (id, project_id, kind, name, key_hash, key_hint, scopes, allowed_origins, rate_limit_per_min, monthly_token_budget, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [key.id, key.projectId, key.kind, key.name, sha256Hex(plaintext), key.hint, JSON.stringify(key.scopes), JSON.stringify(key.allowedOrigins), key.rateLimitPerMin, key.monthlyTokenBudget, key.expiresAt, now],
  );
  return { key, plaintext };
}

export async function getKey(db: Db, id: string): Promise<ApiKey | undefined> {
  const row = await db.get<KeyRow>('SELECT * FROM api_keys WHERE id = ?', [id]);
  return row ? toKey(row) : undefined;
}

export async function listKeys(db: Db, projectId?: string): Promise<ApiKey[]> {
  const rows = projectId
    ? await db.all<KeyRow>('SELECT * FROM api_keys WHERE project_id = ? ORDER BY created_at', [projectId])
    : await db.all<KeyRow>('SELECT * FROM api_keys ORDER BY created_at');
  return rows.map(toKey);
}

export type KeyCheck = { ok: true; key: ApiKey } | { ok: false; reason: 'not_found' | 'revoked' | 'expired' };

export function keyStatus(key: ApiKey, now = Date.now()): 'active' | 'revoked' | 'expired' {
  if (key.revokedAt !== null && key.revokedAt <= now) return 'revoked';
  if (key.expiresAt !== null && key.expiresAt <= now) return 'expired';
  return 'active';
}

const cache = new Map<string, { key: ApiKey; at: number }>();
const CACHE_MS = 15_000;

export function clearKeyCache(): void {
  cache.clear();
}

export async function verifyKey(db: Db, plaintext: string, now = Date.now()): Promise<KeyCheck> {
  if (!/^sct_(pub|sec)_[A-Za-z0-9]{20,80}$/.test(plaintext)) return { ok: false, reason: 'not_found' };
  const hash = sha256Hex(plaintext);
  let key = cache.get(hash);
  if (!key || now - key.at > CACHE_MS) {
    const row = await db.get<KeyRow>('SELECT * FROM api_keys WHERE key_hash = ?', [hash]);
    if (!row || !safeEqual(row.key_hash, hash)) return { ok: false, reason: 'not_found' };
    key = { key: toKey(row), at: now };
    cache.set(hash, key);
    if (key.key.lastUsedAt === null || now - key.key.lastUsedAt > 60_000) {
      await db.run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', [now, row.id]);
    }
  }
  const status = keyStatus(key.key, now);
  if (status !== 'active') return { ok: false, reason: status };
  return { ok: true, key: key.key };
}

export async function revokeKey(db: Db, id: string): Promise<boolean> {
  const r = await db.run('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [Date.now(), id]);
  clearKeyCache();
  return r.changes > 0;
}

// Makes a new key with the same settings. The old key keeps working for `graceMs`.
export async function rotateKey(db: Db, id: string, graceMs: number, defaults: { rateLimitPerMin: number; monthlyTokenBudget: number }) {
  const old = await getKey(db, id);
  if (!old || keyStatus(old) !== 'active') return undefined;
  return db.transaction(async (tx) => {
    const created = await createKey(
      tx,
      {
        projectId: old.projectId,
        kind: old.kind,
        name: old.name,
        allowedOrigins: old.allowedOrigins,
        scopes: old.scopes,
        rateLimitPerMin: old.rateLimitPerMin,
        monthlyTokenBudget: old.monthlyTokenBudget,
        expiresAt: old.expiresAt,
      },
      defaults,
    );
    await tx.run('UPDATE api_keys SET revoked_at = ?, replaced_by = ? WHERE id = ?', [Date.now() + Math.max(0, graceMs), created.key.id, id]);
    clearKeyCache();
    return created;
  });
}

export interface KeyPatch {
  name?: string;
  allowedOrigins?: string[];
  scopes?: string[];
  rateLimitPerMin?: number;
  monthlyTokenBudget?: number;
  expiresAt?: number | null;
}

export async function updateKey(db: Db, id: string, patch: KeyPatch): Promise<ApiKey | undefined> {
  const key = await getKey(db, id);
  if (!key) return undefined;
  const next: ApiKey = {
    ...key,
    name: patch.name !== undefined ? patch.name.trim().slice(0, 80) || key.name : key.name,
    allowedOrigins: patch.allowedOrigins !== undefined && key.kind === 'public' ? cleanOrigins(patch.allowedOrigins) : key.allowedOrigins,
    scopes: patch.scopes !== undefined ? cleanScopes(key.kind, patch.scopes) : key.scopes,
    rateLimitPerMin: patch.rateLimitPerMin !== undefined ? Math.max(1, Math.floor(patch.rateLimitPerMin)) : key.rateLimitPerMin,
    monthlyTokenBudget: patch.monthlyTokenBudget !== undefined ? Math.max(0, Math.floor(patch.monthlyTokenBudget)) : key.monthlyTokenBudget,
    expiresAt: patch.expiresAt !== undefined ? patch.expiresAt : key.expiresAt,
  };
  await db.run('UPDATE api_keys SET name = ?, allowed_origins = ?, scopes = ?, rate_limit_per_min = ?, monthly_token_budget = ?, expires_at = ? WHERE id = ?', [
    next.name,
    JSON.stringify(next.allowedOrigins),
    JSON.stringify(next.scopes),
    next.rateLimitPerMin,
    next.monthlyTokenBudget,
    next.expiresAt,
    id,
  ]);
  clearKeyCache();
  return next;
}

export function publicKeyView(key: ApiKey) {
  return {
    id: key.id,
    project_id: key.projectId,
    kind: key.kind,
    name: key.name,
    hint: key.hint,
    scopes: key.scopes,
    allowed_origins: key.allowedOrigins,
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
// A server holding a secret key mints a short-lived token so the website widget can
// chat as a known user without ever seeing the secret key.

export function mintUserToken(secrets: Secrets, projectId: string, userId: string, ttlSeconds: number, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ p: projectId, u: userId, exp: Math.floor(now / 1000) + ttlSeconds })).toString('base64url');
  return `sct_ut_${payload}.${secrets.sign(payload, 'user-token')}`;
}

export function verifyUserToken(secrets: Secrets, token: string, projectId: string, now = Date.now()): string | null {
  const m = /^sct_ut_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token);
  if (!m) return null;
  if (!safeEqual(secrets.sign(m[1]!, 'user-token'), m[2]!)) return null;
  try {
    const data = JSON.parse(Buffer.from(m[1]!, 'base64url').toString('utf8')) as { p: string; u: string; exp: number };
    if (data.p !== projectId || typeof data.u !== 'string' || data.exp * 1000 <= now) return null;
    return data.u;
  } catch {
    return null;
  }
}
