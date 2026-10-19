import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { randomBase62, safeEqual, sha256Hex, type Secrets } from '../security/crypto.ts';
import { activeKeys, APP_KEY_PATTERN, createKey, findKeyByPlaintext, getKey, keyStatus, reactivateKey, revokeKey } from './keys.ts';

// First-run flow: Scout creates its own app key, keeps it (encrypted) only until the
// owner opens /setup and confirms they saved it, then forgets it and keeps the hash.
// Only the first browser that opens /setup sees the key (it gets a cookie); anyone
// else is told the key was already shown, so a stolen key cannot go unnoticed.
// The key is never written to logs. SCOUT_APP_KEY (a hosting secret) skips all this.
export interface SetupRecord {
  status: 'pending' | 'claimed' | 'env' | 'expired';
  keyId: string;
  enc?: string;
  windowEndsAt?: number;
  claimedAt?: number;
  viewer?: string;
  shownAt?: number;
}

const SETTING = 'setup.app_key';

async function readRaw(db: Db): Promise<{ rec: SetupRecord; raw: string } | undefined> {
  const row = await db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [SETTING]);
  return row ? { rec: JSON.parse(row.value) as SetupRecord, raw: row.value } : undefined;
}

async function read(db: Db): Promise<SetupRecord | undefined> {
  return (await readRaw(db))?.rec;
}

async function write(db: Db, rec: SetupRecord): Promise<void> {
  await db.run(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    [SETTING, JSON.stringify(rec), Date.now()],
  );
}

// Writes only if nobody changed the record since `before` was read.
async function replace(db: Db, before: string, rec: SetupRecord): Promise<boolean> {
  const r = await db.run('UPDATE settings SET value = ?, updated_at = ? WHERE key = ? AND value = ?', [JSON.stringify(rec), Date.now(), SETTING, before]);
  return r.changes === 1;
}

export class SetupError extends Error {}

async function startNewKey(db: Db, secrets: Secrets, config: Config, projectId: string): Promise<SetupRecord> {
  for (const k of await activeKeys(db, projectId)) await revokeKey(db, k.id);
  const { key, plaintext } = await createKey(db, { projectId, name: 'LoginLens app key', rateLimitPerMin: config.limits.appKeyRequestsPerMinute });
  const rec: SetupRecord = {
    status: 'pending',
    keyId: key.id,
    enc: secrets.encrypt(plaintext, 'setup-key'),
    windowEndsAt: Date.now() + config.setupWindowMinutes * 60_000,
  };
  await write(db, rec);
  return rec;
}

// When the setup window closes without "I saved the key", a key that LoginLens has
// already used is kept (and counted as saved). Only a key nobody ever used is dropped.
async function closeWindow(db: Db, rec: SetupRecord): Promise<SetupRecord> {
  const key = await getKey(db, rec.keyId);
  const next: SetupRecord =
    key && keyStatus(key) === 'active' && key.lastUsedAt !== null ? { status: 'claimed', keyId: rec.keyId, claimedAt: Date.now() } : { status: 'expired', keyId: rec.keyId };
  await write(db, next);
  return next;
}

const windowClosed = (rec: SetupRecord) => rec.status === 'pending' && (!rec.enc || (rec.windowEndsAt ?? 0) <= Date.now());

export async function ensureAppKey(db: Db, secrets: Secrets, config: Config, projectId: string): Promise<SetupRecord> {
  if (config.appKeyFromEnv) {
    if (!APP_KEY_PATTERN.test(config.appKeyFromEnv)) {
      throw new SetupError('SCOUT_APP_KEY must look like sct_sec_ followed by 20-80 letters and numbers. Remove it to let Scout create one for you.');
    }
    let key = await findKeyByPlaintext(db, config.appKeyFromEnv);
    if (!key) {
      key = (await createKey(db, { projectId, name: 'App key from SCOUT_APP_KEY', source: 'env', plaintext: config.appKeyFromEnv, rateLimitPerMin: config.limits.appKeyRequestsPerMinute })).key;
    } else if (keyStatus(key) !== 'active') {
      await reactivateKey(db, key.id);
    }
    // The hosting secret is the one valid key: any other key (e.g. one shown at /setup
    // earlier) stops working.
    for (const k of await activeKeys(db, projectId)) if (k.id !== key.id) await revokeKey(db, k.id);
    const rec: SetupRecord = { status: 'env', keyId: key.id };
    await write(db, rec);
    return rec;
  }
  let existing = await read(db);
  const active = await activeKeys(db, projectId);
  if (config.newAppKeyOnStart || !existing || existing.status === 'env' || active.length === 0) {
    return startNewKey(db, secrets, config, projectId);
  }
  if (windowClosed(existing) || existing.status === 'expired') existing = await closeWindow(db, existing);
  if (existing.status === 'expired') return startNewKey(db, secrets, config, projectId);
  return existing;
}

export interface SetupView {
  status: SetupRecord['status'] | 'shown_elsewhere';
  appKey?: string;
  windowEndsAt?: number;
  shownAt?: number;
  // Set when this browser is the first to see the key: send it back as a cookie.
  newViewerToken?: string;
}

const viewerMatches = (rec: SetupRecord, token: string | undefined) => !!rec.viewer && !!token && safeEqual(sha256Hex(token), rec.viewer);

export async function setupView(db: Db, secrets: Secrets, viewerToken?: string, attempt = 0): Promise<SetupView> {
  const row = await readRaw(db);
  if (!row) return { status: 'expired' };
  const { rec, raw } = row;
  if (windowClosed(rec)) return { status: (await closeWindow(db, rec)).status };
  if (rec.status !== 'pending') return { status: rec.status };
  const appKey = () => secrets.decrypt(rec.enc!, 'setup-key');
  if (rec.viewer) {
    if (viewerMatches(rec, viewerToken)) return { status: 'pending', appKey: appKey(), windowEndsAt: rec.windowEndsAt };
    return { status: 'shown_elsewhere', shownAt: rec.shownAt, windowEndsAt: rec.windowEndsAt };
  }
  const token = randomBase62(32);
  if (!(await replace(db, raw, { ...rec, viewer: sha256Hex(token), shownAt: Date.now() }))) {
    // Another browser got there at the same moment; look again.
    return attempt < 3 ? setupView(db, secrets, viewerToken, attempt + 1) : { status: 'shown_elsewhere', windowEndsAt: rec.windowEndsAt };
  }
  return { status: 'pending', appKey: appKey(), windowEndsAt: rec.windowEndsAt, newViewerToken: token };
}

// Only the browser that was shown the key can confirm it was saved.
export async function confirmSetup(db: Db, viewerToken: string | undefined): Promise<boolean> {
  const row = await readRaw(db);
  if (!row || row.rec.status !== 'pending' || windowClosed(row.rec) || !viewerMatches(row.rec, viewerToken)) return false;
  return replace(db, row.raw, { status: 'claimed', keyId: row.rec.keyId, claimedAt: Date.now() });
}

export async function setupWindowOpen(db: Db): Promise<boolean> {
  const rec = await read(db);
  return !!rec && rec.status === 'pending' && !windowClosed(rec);
}

export async function setupStatus(db: Db): Promise<SetupRecord['status'] | 'none'> {
  return (await read(db))?.status ?? 'none';
}
