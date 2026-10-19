import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import type { Secrets } from '../security/crypto.ts';
import { activeKeys, APP_KEY_PATTERN, createKey, findKeyByPlaintext, revokeKey } from './keys.ts';

// First-run flow: Scout creates its own app key, keeps it (encrypted) only until the
// owner opens /setup and confirms they saved it, then forgets it and keeps the hash.
// The key is never written to logs. SCOUT_APP_KEY (a hosting secret) skips all this.
export interface SetupRecord {
  status: 'pending' | 'claimed' | 'env' | 'expired';
  keyId: string;
  enc?: string;
  windowEndsAt?: number;
  claimedAt?: number;
}

const SETTING = 'setup.app_key';

async function read(db: Db): Promise<SetupRecord | undefined> {
  const row = await db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [SETTING]);
  return row ? (JSON.parse(row.value) as SetupRecord) : undefined;
}

async function write(db: Db, rec: SetupRecord): Promise<void> {
  await db.run(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    [SETTING, JSON.stringify(rec), Date.now()],
  );
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

export async function ensureAppKey(db: Db, secrets: Secrets, config: Config, projectId: string): Promise<SetupRecord> {
  if (config.appKeyFromEnv) {
    if (!APP_KEY_PATTERN.test(config.appKeyFromEnv)) {
      throw new SetupError('SCOUT_APP_KEY must look like sct_sec_ followed by 20-80 letters and numbers. Remove it to let Scout create one for you.');
    }
    let key = await findKeyByPlaintext(db, config.appKeyFromEnv);
    if (!key) {
      key = (await createKey(db, { projectId, name: 'App key from SCOUT_APP_KEY', source: 'env', plaintext: config.appKeyFromEnv, rateLimitPerMin: config.limits.appKeyRequestsPerMinute })).key;
    }
    const rec: SetupRecord = { status: 'env', keyId: key.id };
    await write(db, rec);
    return rec;
  }
  const existing = await read(db);
  const active = await activeKeys(db, projectId);
  if (config.newAppKeyOnStart || !existing || existing.status === 'env' || active.length === 0) {
    return startNewKey(db, secrets, config, projectId);
  }
  // A window that closed before the owner confirmed: issue a fresh key on restart.
  if (existing.status === 'expired' || (existing.status === 'pending' && (existing.windowEndsAt ?? 0) <= Date.now())) {
    return startNewKey(db, secrets, config, projectId);
  }
  return existing;
}

export interface SetupView {
  status: SetupRecord['status'];
  appKey?: string;
  windowEndsAt?: number;
}

export async function setupView(db: Db, secrets: Secrets): Promise<SetupView> {
  const rec = await read(db);
  if (!rec) return { status: 'expired' };
  if (rec.status !== 'pending') return { status: rec.status };
  if (!rec.enc || (rec.windowEndsAt ?? 0) <= Date.now()) {
    await write(db, { status: 'expired', keyId: rec.keyId });
    return { status: 'expired' };
  }
  return { status: 'pending', appKey: secrets.decrypt(rec.enc, 'setup-key'), windowEndsAt: rec.windowEndsAt };
}

export async function confirmSetup(db: Db): Promise<boolean> {
  const rec = await read(db);
  if (!rec || rec.status !== 'pending') return false;
  await write(db, { status: 'claimed', keyId: rec.keyId, claimedAt: Date.now() });
  return true;
}

export async function setupStatus(db: Db): Promise<SetupRecord['status'] | 'none'> {
  return (await read(db))?.status ?? 'none';
}
