import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function randomBase62(length: number): string {
  let out = '';
  while (out.length < length) {
    const bytes = crypto.randomBytes(length * 2);
    for (const b of bytes) {
      // 248 = 62 * 4, so bytes >= 248 are rejected to keep every character equally likely.
      if (b < 248 && out.length < length) out += BASE62[b % 62];
    }
  }
  return out;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBase62(22)}`;
}

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export function hmacHex(key: Buffer | string, value: string): string {
  return crypto.createHmac('sha256', key).update(value, 'utf8').digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export class Secrets {
  private readonly master: Buffer;

  constructor(masterSecret: string) {
    if (masterSecret.length < 32) {
      throw new Error('SCOUT_ENCRYPTION_KEY must be at least 32 characters long.');
    }
    this.master = Buffer.from(masterSecret, 'utf8');
  }

  subkey(purpose: string): Buffer {
    return Buffer.from(crypto.hkdfSync('sha256', this.master, Buffer.from('scout-v1'), Buffer.from(purpose), 32));
  }

  encrypt(plaintext: string, purpose: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.subkey(`enc:${purpose}`), iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${ct.toString('base64url')}`;
  }

  decrypt(payload: string, purpose: string): string {
    const [version, ivB64, tagB64, ctB64] = payload.split(':');
    if (version !== 'v1' || !ivB64 || !tagB64 || ctB64 === undefined) throw new Error('Unknown encrypted payload format');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.subkey(`enc:${purpose}`), Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8');
  }

  sign(value: string, purpose: string): string {
    return crypto.createHmac('sha256', this.subkey(`sig:${purpose}`)).update(value).digest('base64url');
  }
}

export interface MasterSecretResult {
  secret: string;
  source: 'env' | 'file' | 'generated';
  file?: string;
}

// Without SCOUT_ENCRYPTION_KEY a random secret is created once and kept in the data folder.
export function resolveMasterSecret(envValue: string, dataDir: string): MasterSecretResult {
  if (envValue) return { secret: envValue, source: 'env' };
  const file = path.join(dataDir, '.scout-secret');
  if (fs.existsSync(file)) {
    return { secret: fs.readFileSync(file, 'utf8').trim(), source: 'file', file };
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const secret = randomBase62(48);
  fs.writeFileSync(file, secret + '\n', { mode: 0o600 });
  return { secret, source: 'generated', file };
}
