import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Db } from '../src/db/index.ts';
import {
  APP_SCOPES,
  cleanOrigins,
  clearKeyCache,
  createKey,
  findKeyByPlaintext,
  generateAppKey,
  getKey,
  KeyInputError,
  keyStatus,
  listKeys,
  mintUserToken,
  normalizeOrigin,
  originAllowed,
  revokeKey,
  rotateKey,
  verifyKey,
  verifyUserToken,
} from '../src/keys/keys.ts';
import { createProject } from '../src/keys/projects.ts';
import { confirmSetup, ensureAppKey, SetupError, setupStatus, setupView } from '../src/keys/setup.ts';
import { hmacHex, newId, randomBase62, safeEqual, Secrets, sha256Hex } from '../src/security/crypto.ts';
import { cleanText, maskEmail, redactDeep, redactText, stripSecretsFromUserText } from '../src/security/redact.ts';
import { TEST_SECRET, testConfig, testDb, testEnv } from './helpers.ts';

const OTHER_SECRET = 'a-completely-different-master-secret-0123456789';

// Flips one bit in one ":"-separated part of an encrypted payload (1 = iv, 2 = tag, 3 = ciphertext).
function tamperPart(payload: string, index: number): string {
  const parts = payload.split(':');
  const buf = Buffer.from(parts[index]!, 'base64url');
  buf[0] = buf[0]! ^ 0x01;
  parts[index] = buf.toString('base64url');
  return parts.join(':');
}

async function apiKeyRows(db: Db): Promise<Array<Record<string, unknown>>> {
  return db.all<Record<string, unknown>>('SELECT * FROM api_keys');
}

const SETUP_SETTING = 'setup.app_key';

async function readSetupRow(db: Db): Promise<string | undefined> {
  const row = await db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [SETUP_SETTING]);
  return row?.value;
}

// The owner's browser: it keeps the cookie Scout gives the first viewer of /setup.
const ownerTokens = new WeakMap<Db, string>();
async function ownerView(db: Db, secrets: Secrets) {
  const v = await setupView(db, secrets, ownerTokens.get(db));
  if (v.newViewerToken) ownerTokens.set(db, v.newViewerToken);
  return v;
}
const ownerConfirm = (db: Db) => confirmSetup(db, ownerTokens.get(db));

async function setupFixture(env: Record<string, string> = {}) {
  clearKeyCache();
  const db = await testDb();
  const config = testConfig(env);
  const secrets = new Secrets(TEST_SECRET);
  const project = await createProject(db, 'LoginLens');
  return { db, config, secrets, projectId: project.id };
}

// =====================================================================
// Secrets (encryption and signing)
// =====================================================================

test('Secrets refuses a master secret shorter than 32 characters', () => {
  assert.throws(() => new Secrets('too-short'), /at least 32 characters/);
  assert.throws(() => new Secrets('x'.repeat(31)));
  assert.doesNotThrow(() => new Secrets('x'.repeat(32)));
});

test('Secrets encrypts and decrypts a value for the same purpose', () => {
  const secrets = new Secrets(TEST_SECRET);
  for (const value of ['hello world', '', 'पासवर्ड 🔐 ünïcødé', 'x'.repeat(5000)]) {
    const enc = secrets.encrypt(value, 'connector-secret');
    assert.equal(secrets.decrypt(enc, 'connector-secret'), value);
  }
});

test('encrypted payloads use the v1 format, never contain the plaintext and differ every time', () => {
  const secrets = new Secrets(TEST_SECRET);
  const plaintext = 'sct_sec_supersecretvalue1234567890';
  const a = secrets.encrypt(plaintext, 'p');
  const b = secrets.encrypt(plaintext, 'p');
  assert.match(a, /^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]*$/);
  assert.ok(!a.includes(plaintext));
  assert.ok(!a.includes('supersecret'));
  assert.notEqual(a, b, 'a random IV must make each ciphertext unique');
  assert.equal(secrets.decrypt(a, 'p'), plaintext);
  assert.equal(secrets.decrypt(b, 'p'), plaintext);
});

test('decrypting with the wrong purpose fails', () => {
  const secrets = new Secrets(TEST_SECRET);
  const enc = secrets.encrypt('the secret', 'setup-key');
  assert.throws(() => secrets.decrypt(enc, 'connector-secret'));
  assert.throws(() => secrets.decrypt(enc, ''));
});

test('decrypting with a different master secret fails', () => {
  const enc = new Secrets(TEST_SECRET).encrypt('the secret', 'p');
  assert.throws(() => new Secrets(OTHER_SECRET).decrypt(enc, 'p'));
});

test('tampered ciphertext, auth tag or IV is rejected', () => {
  const secrets = new Secrets(TEST_SECRET);
  const enc = secrets.encrypt('transfer 100 to alice', 'p');
  assert.throws(() => secrets.decrypt(tamperPart(enc, 3), 'p'), 'tampered ciphertext');
  assert.throws(() => secrets.decrypt(tamperPart(enc, 2), 'p'), 'tampered tag');
  assert.throws(() => secrets.decrypt(tamperPart(enc, 1), 'p'), 'tampered iv');
  // Swapping in another payload's ciphertext under this tag also fails.
  const other = secrets.encrypt('transfer 999 to mallo', 'p').split(':');
  const parts = enc.split(':');
  assert.throws(() => secrets.decrypt([parts[0], parts[1], parts[2], other[3]].join(':'), 'p'));
});

test('malformed encrypted payloads are rejected', () => {
  const secrets = new Secrets(TEST_SECRET);
  const enc = secrets.encrypt('value', 'p');
  const [, iv, tag, ct] = enc.split(':');
  assert.throws(() => secrets.decrypt('', 'p'), /Unknown encrypted payload format/);
  assert.throws(() => secrets.decrypt('plain text', 'p'), /Unknown encrypted payload format/);
  assert.throws(() => secrets.decrypt(`v2:${iv}:${tag}:${ct}`, 'p'), /Unknown encrypted payload format/);
  assert.throws(() => secrets.decrypt(`v1:${iv}:${tag}`, 'p'), /Unknown encrypted payload format/);
  assert.throws(() => secrets.decrypt(`v1::${tag}:${ct}`, 'p'), /Unknown encrypted payload format/);
  assert.throws(() => secrets.decrypt(`v1:${iv}::${ct}`, 'p'));
});

test('sign is deterministic and separated by purpose and master secret', () => {
  const a = new Secrets(TEST_SECRET);
  const b = new Secrets(OTHER_SECRET);
  assert.equal(a.sign('payload', 'user-token'), a.sign('payload', 'user-token'));
  assert.notEqual(a.sign('payload', 'user-token'), a.sign('payload', 'other'));
  assert.notEqual(a.sign('payload', 'user-token'), a.sign('payload2', 'user-token'));
  assert.notEqual(a.sign('payload', 'user-token'), b.sign('payload', 'user-token'));
  assert.notDeepEqual(a.subkey('enc:x'), a.subkey('sig:x'));
  assert.equal(a.subkey('x').length, 32);
});

test('hash and random helpers behave as expected', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(hmacHex('key', 'value'), hmacHex(Buffer.from('key'), 'value'));
  assert.notEqual(hmacHex('key', 'value'), hmacHex('key2', 'value'));
  assert.equal(safeEqual('same', 'same'), true);
  assert.equal(safeEqual('same', 'samf'), false);
  assert.equal(safeEqual('short', 'longer value'), false);
  const r = randomBase62(64);
  assert.match(r, /^[0-9A-Za-z]{64}$/);
  assert.notEqual(randomBase62(32), randomBase62(32));
  assert.match(newId('key'), /^key_[0-9A-Za-z]{22}$/);
});

// =====================================================================
// redactText / maskEmail
// =====================================================================

test('redactText masks email addresses but keeps the domain', () => {
  assert.equal(redactText('Write to john.doe+news@mail.example.co.in today'), 'Write to j***@mail.example.co.in today');
  assert.equal(maskEmail('a@b.io and Zed_99@Example.COM'), 'a***@b.io and Z***@Example.COM');
  assert.ok(!redactText('contact: priya.sharma@gmail.com').includes('priya.sharma'));
});

test('redactText hides Scout app keys, user tokens and publishable keys', () => {
  const appKey = generateAppKey();
  const userToken = mintUserToken(new Secrets(TEST_SECRET), 'prj_1', 'user-1', 600).token;
  const out = redactText(`key=${appKey} token ${userToken} pub sct_pub_abcdEFGH1234`);
  assert.ok(!out.includes(appKey.slice(8)), out);
  assert.ok(!out.includes(userToken.slice(7)), out);
  assert.ok(!out.includes('abcdEFGH1234'), out);
  assert.match(out, /key=sct_sec_\[REDACTED\]/);
  assert.match(out, /token sct_ut_\[REDACTED\]/);
  assert.match(out, /pub sct_pub_\[REDACTED\]/);
});

test('redactText hides Bearer tokens', () => {
  assert.equal(redactText('Authorization: Bearer abcdef1234567890XYZ'), 'Authorization: Bearer [REDACTED]');
  assert.equal(redactText('authorization: bearer abc.def-ghi_jkl~mno'), 'authorization: bearer [REDACTED]');
  const out = redactText(`Bearer ${generateAppKey()}`);
  assert.ok(!/[A-Za-z0-9]{20,}/.test(out), out);
});

test('redactText hides Google OAuth tokens, refresh tokens and API keys', () => {
  assert.equal(redactText('access ya29.a0AfH6SMBx-abc_def.ghi123'), 'access [GOOGLE_TOKEN]');
  assert.equal(redactText('refresh 1//0gAbCdEfGhIjKlMnOpQrStUvWxYz'), 'refresh [GOOGLE_REFRESH_TOKEN]');
  assert.equal(redactText('key AIzaSyD-abcdefghijklmnopqrstuvwxyz012345'), 'key [GOOGLE_API_KEY]');
});

test('redactText hides sk-, gsk_, whsec_ keys, JWTs and long hex secrets', () => {
  assert.equal(redactText('use sk-ant-api03-abcdefghijklmnopqrstuvwxyz now'), 'use [API_KEY] now');
  assert.equal(redactText('use sk-proj-ABCDEFGHIJKLMNOP1234'), 'use [API_KEY]');
  assert.equal(redactText('groq gsk_ABCDEFGHIJKLMNOP1234'), 'groq [API_KEY]');
  assert.equal(redactText('hook whsec_abcd1234efgh'), 'hook whsec_[REDACTED]');
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  assert.equal(redactText(`id_token=${jwt}`), 'id_token=[JWT]');
  assert.equal(redactText(`hash ${'a1b2c3d4e5'.repeat(4)}`), 'hash [HEX_SECRET]');
});

test('redactText leaves ordinary text untouched', () => {
  for (const s of ['Hello, how are you?', 'Order #12345 shipped on 2026-10-19', 'sk-short', 'Bearer abc', 'The skeleton key was in a box', 'commit abc123f']) {
    assert.equal(redactText(s), s);
  }
});

// =====================================================================
// redactDeep
// =====================================================================

test('redactDeep hides values under sensitive keys at any level, case-insensitively', () => {
  const input = {
    Authorization: 'Bearer abc',
    cookie: 'sid=1',
    'Set-Cookie': 'sid=2',
    password: 'hunter2',
    passwd: 'x',
    secret: 's',
    token: 't',
    access_token: 'at',
    refresh_token: 'rt',
    api_key: 'k',
    apiKey: 'k2',
    'x-scout-key': 'sct_sec_whatever',
    'X-API-Key': 'k3',
    'x-goog-api-key': 'k4',
    signing_secret: 'ss',
    client_secret: 'cs',
    otp: '123456',
    code: '9999',
    nested: { deeper: { token: 'deep-token', keep: 'visible' } },
    list: [{ password: 'in-array' }, 'plain'],
  };
  const out = redactDeep(input) as Record<string, unknown>;
  for (const k of Object.keys(input)) {
    if (k === 'nested' || k === 'list') continue;
    assert.equal(out[k], '[REDACTED]', `key ${k} should be redacted`);
  }
  assert.deepEqual(out.nested, { deeper: { token: '[REDACTED]', keep: 'visible' } });
  assert.deepEqual(out.list, [{ password: '[REDACTED]' }, 'plain']);
  assert.ok(!JSON.stringify(out).includes('hunter2'));
  assert.ok(!JSON.stringify(out).includes('deep-token'));
});

test('redactDeep keeps non-sensitive keys and redacts secrets inside their string values', () => {
  const key = generateAppKey();
  const out = redactDeep({ tokens_used: 42, password_hint: 'pet name', ok: true, none: null, message: `mail bob@example.com with ${key}` }) as Record<string, unknown>;
  assert.equal(out.tokens_used, 42);
  assert.equal(out.password_hint, 'pet name');
  assert.equal(out.ok, true);
  assert.equal(out.none, null);
  assert.equal(out.message, 'mail b***@example.com with sct_sec_[REDACTED]');
});

test('redactDeep turns errors into name and redacted message only', () => {
  const err = new TypeError('failed for alice@example.com with Bearer abcdefghijklmnop');
  const out = redactDeep({ error: err }) as { error: Record<string, unknown> };
  assert.deepEqual(out.error, { name: 'TypeError', message: 'failed for a***@example.com with Bearer [REDACTED]' });
  assert.ok(!('stack' in out.error));
});

test('redactDeep caps nesting depth and array length', () => {
  let deep: Record<string, unknown> = { leaf: 'bottom' };
  for (let i = 0; i < 10; i++) deep = { child: deep };
  assert.ok(JSON.stringify(redactDeep(deep)).includes('[DEEP]'));
  assert.ok(!JSON.stringify(redactDeep(deep)).includes('bottom'));
  const arr = redactDeep(Array.from({ length: 120 }, (_, i) => i)) as number[];
  assert.equal(arr.length, 50);
  assert.equal(redactDeep('mail x@y.com'), 'mail x***@y.com');
  assert.equal(redactDeep(7), 7);
  assert.equal(redactDeep(undefined), undefined);
});

// =====================================================================
// stripSecretsFromUserText
// =====================================================================

test('stripSecretsFromUserText removes a password written as "my password is ..."', () => {
  const r = stripSecretsFromUserText('my password is hunter2');
  assert.equal(r.removedSecrets, true);
  assert.ok(!r.text.includes('hunter2'));
  assert.equal(r.text, 'my password is [removed]');
});

test('stripSecretsFromUserText removes "password: abc123" and similar forms', () => {
  assert.deepEqual(stripSecretsFromUserText('password: abc123'), { text: 'password: [removed]', removedSecrets: true });
  assert.equal(stripSecretsFromUserText('My Password Is Hunter2!').text, 'My Password Is [removed]');
  assert.equal(stripSecretsFromUserText('my pwd=s3cr3t please').text, 'my pwd=[removed] please');
  assert.equal(stripSecretsFromUserText('mera password hai abc123').text, 'mera password hai [removed]');
  assert.equal(stripSecretsFromUserText('passcode - 99xyz').text, 'passcode - [removed]');
});

test('stripSecretsFromUserText removes an OTP that follows the word OTP or code', () => {
  assert.deepEqual(stripSecretsFromUserText('OTP is 482913'), { text: 'OTP is [removed]', removedSecrets: true });
  assert.equal(stripSecretsFromUserText('your verification code is 123456.').text, 'your verification code is [removed].');
  assert.equal(stripSecretsFromUserText('the 2FA code: 7788').text, 'the 2FA code: [removed]');
});

test('stripSecretsFromUserText removes an OTP that comes before the word OTP', () => {
  const r = stripSecretsFromUserText('482913 is my otp');
  assert.equal(r.removedSecrets, true);
  assert.ok(!r.text.includes('482913'));
  assert.equal(r.text, '[removed] is my otp');
});

test('stripSecretsFromUserText removes a Hindi password written as "पासवर्ड: abc123"', () => {
  const r = stripSecretsFromUserText('पासवर्ड: abc123');
  assert.equal(r.removedSecrets, true);
  assert.ok(!r.text.includes('abc123'));
  assert.equal(r.text, 'पासवर्ड: [removed]');
  assert.ok(!stripSecretsFromUserText('ओटीपी 556677 है').text.includes('556677'));
});

test('stripSecretsFromUserText removes a Hindi password written as "पासवर्ड है abc123"', () => {
  // "है" is the Devanagari spelling of "hai", which is already treated as a separator.
  const r = stripSecretsFromUserText('मेरा पासवर्ड है abc123');
  assert.equal(r.removedSecrets, true);
  assert.ok(!r.text.includes('abc123'), r.text);
});

test('stripSecretsFromUserText removes pasted API keys and tokens', () => {
  const key = generateAppKey();
  const r = stripSecretsFromUserText(`here is my key ${key} and sk-abcdefghijklmnop1234`);
  assert.equal(r.removedSecrets, true);
  assert.ok(!r.text.includes(key.slice(8)));
  assert.ok(!r.text.includes('sk-abcdefghijklmnop1234'));
});

test('stripSecretsFromUserText leaves normal sentences alone', () => {
  for (const s of [
    'pass this test',
    'I have 2 accounts at netflix',
    'reset my password for netflix',
    'How do I change my password?',
    'I paid 250 rupees on 12 March',
    'Show my orders from 2025',
    'नमस्ते, मेरा ऑर्डर कहाँ है?',
  ]) {
    assert.deepEqual(stripSecretsFromUserText(s), { text: s, removedSecrets: false }, s);
  }
});

test('stripSecretsFromUserText does not mangle words after "password" that merely start with "is" or "h"', () => {
  for (const s of ['I have a password issue with netflix', 'my password hint is a pet name', 'show my password history']) {
    assert.deepEqual(stripSecretsFromUserText(s), { text: s, removedSecrets: false }, s);
  }
});

// =====================================================================
// cleanText
// =====================================================================

test('cleanText strips control characters but keeps tabs and newlines', () => {
  const input = 'a\u0000b\u0007c\u001Bd\u007Fe\u000Bf\u000Cg\th\ni\rj';
  assert.equal(cleanText(input, 100), 'abcdefg\th\ni\rj');
});

test('cleanText strips zero-width and bidirectional override characters', () => {
  const chars = ['​', '‌', '‍', '‎', '‏', '‪', '‫', '‬', '‭', '‮', '⁦', '⁧', '⁨', '⁩'];
  const input = chars.map((c, i) => `${c}x${i}`).join('');
  const out = cleanText(input, 1000);
  assert.equal(out, chars.map((_, i) => `x${i}`).join(''));
  assert.equal(cleanText('invoice‮fdp.exe', 100), 'invoicefdp.exe');
});

test('cleanText keeps normal text including Hindi and emoji, and limits the length after cleaning', () => {
  assert.equal(cleanText('नमस्ते दुनिया 👋 café', 100), 'नमस्ते दुनिया 👋 café');
  assert.equal(cleanText('​​abcdef', 3), 'abc');
  assert.equal(cleanText('abcdef', 0), '');
});

// =====================================================================
// App keys
// =====================================================================

test('createKey stores only a SHA-256 hash of the key, never the plaintext', async () => {
  const env = await testEnv();
  const { key, plaintext } = await createKey(env.db, { projectId: env.project.id, name: 'server key', rateLimitPerMin: 60 });
  assert.match(plaintext, /^sct_sec_[A-Za-z0-9]{40}$/);
  const row = await env.db.get<Record<string, unknown>>('SELECT * FROM api_keys WHERE id = ?', [key.id]);
  assert.ok(row);
  assert.equal(row.key_hash, sha256Hex(plaintext));
  const body = plaintext.slice('sct_sec_'.length);
  for (const r of await apiKeyRows(env.db)) {
    for (const [col, value] of Object.entries(r)) {
      const s = String(value);
      assert.ok(!s.includes(plaintext), `column ${col} contains the plaintext key`);
      assert.ok(!s.includes(body), `column ${col} contains the secret part of the key`);
      assert.ok(!s.includes(body.slice(4, 36)), `column ${col} contains a long run of the secret`);
    }
  }
  assert.equal(key.hint, `${plaintext.slice(0, 12)}…${plaintext.slice(-4)}`);
  assert.equal(row.key_hint, key.hint);
  await env.db.close();
});

test('createKey applies defaults and stores the settings it was given', async () => {
  const env = await testEnv();
  const { key } = await createKey(env.db, { projectId: env.project.id, name: '   ', rateLimitPerMin: 0 });
  assert.equal(key.name, 'App key');
  assert.deepEqual(key.scopes, [...APP_SCOPES]);
  assert.equal(key.rateLimitPerMin, 1);
  assert.equal(key.source, 'generated');
  const stored = await getKey(env.db, key.id);
  assert.deepEqual(stored?.scopes, [...APP_SCOPES]);
  assert.equal(stored?.revokedAt, null);
  await env.db.close();
});

test('verifyKey accepts a valid key and reports not_found for an unknown one', async () => {
  const env = await testEnv();
  const ok = await verifyKey(env.db, env.appKey);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.key.id, env.appKeyId);
  assert.deepEqual(await verifyKey(env.db, generateAppKey()), { ok: false, reason: 'not_found' });
  await env.db.close();
});

test('verifyKey rejects keys in the wrong format without a lookup match', async () => {
  const env = await testEnv();
  const body = env.appKey.slice('sct_sec_'.length);
  for (const bad of ['', 'sct_sec_', 'sct_sec_short', `sct_pub_${body}`, `SCT_SEC_${body}`, ` ${env.appKey}`, `${env.appKey} `, `Bearer ${env.appKey}`, `${env.appKey}!`, `sct_sec_${'a'.repeat(81)}`, body]) {
    assert.deepEqual(await verifyKey(env.db, bad), { ok: false, reason: 'not_found' }, JSON.stringify(bad));
  }
  await env.db.close();
});

test('createKey rejects a supplied plaintext in the wrong format', async () => {
  const env = await testEnv();
  const before = (await apiKeyRows(env.db)).length;
  for (const plaintext of ['hello', 'sct_sec_short', 'sct_pub_abcdefghijklmnopqrstuvwxyz', 'sct_sec_has spaces in it 1234567']) {
    await assert.rejects(createKey(env.db, { projectId: env.project.id, rateLimitPerMin: 10, plaintext }), KeyInputError);
  }
  assert.equal((await apiKeyRows(env.db)).length, before);
  await env.db.close();
});

test('verifyKey reports revoked after revokeKey, and revokeKey only succeeds once', async () => {
  const env = await testEnv();
  assert.equal((await verifyKey(env.db, env.appKey)).ok, true);
  assert.equal(await revokeKey(env.db, env.appKeyId), true);
  assert.deepEqual(await verifyKey(env.db, env.appKey), { ok: false, reason: 'revoked' });
  assert.equal(await revokeKey(env.db, env.appKeyId), false, 'already revoked');
  assert.equal(await revokeKey(env.db, 'key_doesnotexist'), false);
  await env.db.close();
});

test('revokeKey with a future time keeps the key working until then', async () => {
  const env = await testEnv();
  const at = Date.now() + 60_000;
  assert.equal(await revokeKey(env.db, env.appKeyId, at), true);
  assert.equal((await verifyKey(env.db, env.appKey)).ok, true);
  assert.deepEqual(await verifyKey(env.db, env.appKey, at), { ok: false, reason: 'revoked' });
  // A scheduled revocation can be brought forward to now.
  assert.equal(await revokeKey(env.db, env.appKeyId), true);
  assert.deepEqual(await verifyKey(env.db, env.appKey), { ok: false, reason: 'revoked' });
  await env.db.close();
});

test('verifyKey reports expired once a key passes its expiry time', async () => {
  const env = await testEnv();
  const expiresAt = Date.now() + 60_000;
  const { plaintext } = await createKey(env.db, { projectId: env.project.id, rateLimitPerMin: 10, expiresAt });
  assert.equal((await verifyKey(env.db, plaintext)).ok, true);
  assert.deepEqual(await verifyKey(env.db, plaintext, expiresAt), { ok: false, reason: 'expired' });
  assert.deepEqual(await verifyKey(env.db, plaintext, expiresAt + 3_600_000), { ok: false, reason: 'expired' });
  const past = await createKey(env.db, { projectId: env.project.id, rateLimitPerMin: 10, expiresAt: Date.now() - 1 });
  assert.deepEqual(await verifyKey(env.db, past.plaintext), { ok: false, reason: 'expired' });
  await env.db.close();
});

test('rotateKey issues a new key and keeps the old one working only during the grace period', async () => {
  const env = await testEnv();
  const { key: oldKey, plaintext: oldPlain } = await createKey(env.db, { projectId: env.project.id, name: 'rotating', scopes: ['chat', 'keys:rotate'], rateLimitPerMin: 77, monthlyTokenBudget: 5000 });
  const graceMs = 60_000;
  const before = Date.now();
  const rotated = await rotateKey(env.db, oldKey.id, graceMs);
  assert.ok(rotated);
  assert.notEqual(rotated.plaintext, oldPlain);
  assert.notEqual(rotated.key.id, oldKey.id);
  assert.equal(rotated.key.source, 'rotated');
  assert.equal(rotated.key.name, 'rotating');
  assert.deepEqual(rotated.key.scopes, ['chat', 'keys:rotate']);
  assert.equal(rotated.key.rateLimitPerMin, 77);
  assert.equal(rotated.key.monthlyTokenBudget, 5000);

  const fresh = await verifyKey(env.db, rotated.plaintext);
  assert.equal(fresh.ok, true);
  assert.equal((await verifyKey(env.db, oldPlain)).ok, true, 'old key still works during the grace period');

  const stored = await getKey(env.db, oldKey.id);
  assert.equal(stored?.replacedBy, rotated.key.id);
  assert.ok(stored?.revokedAt !== null && stored!.revokedAt! >= before + graceMs);

  const afterGrace = Date.now() + graceMs + 1_000;
  assert.deepEqual(await verifyKey(env.db, oldPlain, afterGrace), { ok: false, reason: 'revoked' });
  assert.equal((await verifyKey(env.db, rotated.plaintext, afterGrace)).ok, true);
  await env.db.close();
});

test('rotateKey with no grace period stops the old key immediately', async () => {
  const env = await testEnv();
  const rotated = await rotateKey(env.db, env.appKeyId, 0);
  assert.ok(rotated);
  assert.deepEqual(await verifyKey(env.db, env.appKey), { ok: false, reason: 'revoked' });
  assert.equal((await verifyKey(env.db, rotated.plaintext)).ok, true);
  // A negative grace is treated as zero, not as a back-dated revocation that is still "active".
  const again = await rotateKey(env.db, rotated.key.id, -5_000);
  assert.ok(again);
  assert.deepEqual(await verifyKey(env.db, rotated.plaintext), { ok: false, reason: 'revoked' });
  await env.db.close();
});

test('rotateKey refuses revoked and unknown keys', async () => {
  const env = await testEnv();
  await revokeKey(env.db, env.appKeyId);
  assert.equal(await rotateKey(env.db, env.appKeyId, 60_000), undefined);
  assert.equal(await rotateKey(env.db, 'key_missing', 60_000), undefined);
  assert.equal((await listKeys(env.db, env.project.id)).length, 1, 'no new key was created');
  await env.db.close();
});

test('createKey validates scopes and rejects unknown ones', async () => {
  const env = await testEnv();
  const before = (await apiKeyRows(env.db)).length;
  await assert.rejects(createKey(env.db, { projectId: env.project.id, rateLimitPerMin: 10, scopes: ['chat', 'admin'] }), (err: unknown) => {
    assert.ok(err instanceof KeyInputError);
    assert.match((err as Error).message, /Unknown scopes: admin/);
    return true;
  });
  await assert.rejects(createKey(env.db, { projectId: env.project.id, rateLimitPerMin: 10, scopes: ['CHAT'] }), KeyInputError);
  await assert.rejects(createKey(env.db, { projectId: env.project.id, rateLimitPerMin: 10, scopes: ['*'] }), KeyInputError);
  assert.equal((await apiKeyRows(env.db)).length, before, 'nothing stored for a rejected key');

  const { key } = await createKey(env.db, { projectId: env.project.id, rateLimitPerMin: 10, scopes: ['chat', 'chat', 'sessions:read'] });
  assert.deepEqual(key.scopes, ['chat', 'sessions:read']);
  assert.deepEqual((await getKey(env.db, key.id))?.scopes, ['chat', 'sessions:read']);
  await env.db.close();
});

// =====================================================================
// User tokens
// =====================================================================

test('mintUserToken creates a token that verifyUserToken accepts', () => {
  const secrets = new Secrets(TEST_SECRET);
  const now = Date.now();
  const { token, expiresAt } = mintUserToken(secrets, 'prj_abc', 'user@example.com', 600, now);
  assert.match(token, /^sct_ut_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(expiresAt, (Math.floor(now / 1000) + 600) * 1000);
  assert.deepEqual(verifyUserToken(secrets, token, now), { projectId: 'prj_abc', userId: 'user@example.com' });
  assert.deepEqual(verifyUserToken(secrets, token), { projectId: 'prj_abc', userId: 'user@example.com' });
});

test('verifyUserToken rejects an expired token', () => {
  const secrets = new Secrets(TEST_SECRET);
  const now = Date.now();
  const { token, expiresAt } = mintUserToken(secrets, 'prj_abc', 'u1', 60, now);
  assert.ok(verifyUserToken(secrets, token, expiresAt - 1));
  assert.equal(verifyUserToken(secrets, token, expiresAt), null);
  assert.equal(verifyUserToken(secrets, token, expiresAt + 86_400_000), null);
  const already = mintUserToken(secrets, 'prj_abc', 'u1', 0, now).token;
  assert.equal(verifyUserToken(secrets, already, now + 1000), null);
});

test('verifyUserToken rejects a token whose payload was changed', () => {
  const secrets = new Secrets(TEST_SECRET);
  const { token } = mintUserToken(secrets, 'prj_abc', 'alice', 600);
  const [payload, sig] = token.slice('sct_ut_'.length).split('.');
  const data = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as Record<string, unknown>;
  const forgeries = [
    { ...data, u: 'admin' },
    { ...data, p: 'prj_other' },
    { ...data, exp: (data.exp as number) + 86_400 * 365 },
  ];
  for (const forged of forgeries) {
    const p = Buffer.from(JSON.stringify(forged)).toString('base64url');
    assert.equal(verifyUserToken(secrets, `sct_ut_${p}.${sig}`), null);
  }
});

test('verifyUserToken rejects a token whose signature was changed', () => {
  const secrets = new Secrets(TEST_SECRET);
  const { token } = mintUserToken(secrets, 'prj_abc', 'alice', 600);
  const [payload, sig] = token.slice('sct_ut_'.length).split('.');
  const flipped = (sig![0] === 'A' ? 'B' : 'A') + sig!.slice(1);
  assert.equal(verifyUserToken(secrets, `sct_ut_${payload}.${flipped}`), null);
  assert.equal(verifyUserToken(secrets, `sct_ut_${payload}.${sig!.slice(0, -2)}`), null);
  assert.equal(verifyUserToken(secrets, `sct_ut_${payload}.`), null);
  assert.equal(verifyUserToken(secrets, `sct_ut_${payload}`), null);
  // The signature must come from the user-token purpose, not another purpose of the same master.
  assert.equal(verifyUserToken(secrets, `sct_ut_${payload}.${secrets.sign(payload!, 'other-purpose')}`), null);
});

test('verifyUserToken rejects a token signed with a different master secret', () => {
  const ours = new Secrets(TEST_SECRET);
  const theirs = new Secrets(OTHER_SECRET);
  const { token } = mintUserToken(theirs, 'prj_abc', 'alice', 600);
  assert.equal(verifyUserToken(ours, token), null);
  assert.ok(verifyUserToken(theirs, token));
});

test('verifyUserToken rejects malformed tokens and correctly signed payloads with bad contents', () => {
  const secrets = new Secrets(TEST_SECRET);
  for (const bad of ['', 'sct_ut_', 'sct_ut_.', 'garbage', generateAppKey(), 'sct_ut_a.b.c', 'sct_ut_abc def.xyz']) {
    assert.equal(verifyUserToken(secrets, bad), null, bad);
  }
  const signed = (obj: unknown) => {
    const p = Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)).toString('base64url');
    return `sct_ut_${p}.${secrets.sign(p, 'user-token')}`;
  };
  const exp = Math.floor(Date.now() / 1000) + 600;
  assert.equal(verifyUserToken(secrets, signed('not json')), null);
  assert.equal(verifyUserToken(secrets, signed({ p: 'prj', u: 'u', exp: String(exp) })), null);
  assert.equal(verifyUserToken(secrets, signed({ p: 'prj', u: 7, exp })), null);
  assert.equal(verifyUserToken(secrets, signed({ p: 'prj', exp })), null);
  assert.equal(verifyUserToken(secrets, signed(null)), null);
  assert.deepEqual(verifyUserToken(secrets, signed({ p: 'prj', u: 'u', exp })), { projectId: 'prj', userId: 'u' });
});

// =====================================================================
// Origins
// =====================================================================

test('normalizeOrigin lower-cases and reduces a URL to its origin', () => {
  assert.equal(normalizeOrigin('https://Example.COM'), 'https://example.com');
  assert.equal(normalizeOrigin('https://example.com/'), 'https://example.com');
  assert.equal(normalizeOrigin('  https://example.com  '), 'https://example.com');
  assert.equal(normalizeOrigin('https://example.com:443'), 'https://example.com');
  assert.equal(normalizeOrigin('http://localhost:3000'), 'http://localhost:3000');
  assert.equal(normalizeOrigin('https://app.example.com:8443/'), 'https://app.example.com:8443');
});

test('normalizeOrigin rejects paths, queries, fragments, credentials and other schemes', () => {
  for (const bad of [
    'https://example.com/path',
    'https://example.com/?q=1',
    'https://example.com?q=1',
    'https://example.com/#frag',
    'https://user@example.com',
    'https://user:pw@example.com',
    'ftp://example.com',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'example.com',
    '',
    'null',
    'https://*.example.com/path',
  ]) {
    assert.equal(normalizeOrigin(bad), null, bad);
  }
});

test('normalizeOrigin accepts the wildcard subdomain form', () => {
  assert.equal(normalizeOrigin('https://*.Example.com'), 'https://*.example.com');
  assert.equal(normalizeOrigin('http://*.example.com:8080'), 'http://*.example.com:8080');
});

test('cleanOrigins validates, normalizes and de-duplicates a list', () => {
  assert.deepEqual(cleanOrigins(['https://A.com', 'https://a.com/', 'https://*.B.com', 'http://localhost:5173']), ['https://a.com', 'https://*.b.com', 'http://localhost:5173']);
  assert.deepEqual(cleanOrigins([]), []);
});

test('cleanOrigins throws KeyInputError for bad input', () => {
  for (const notList of ['https://a.com', null, undefined, { 0: 'https://a.com' }, 42]) {
    assert.throws(() => cleanOrigins(notList), KeyInputError);
  }
  assert.throws(() => cleanOrigins(['https://a.com/path']), (err: unknown) => err instanceof KeyInputError && /is not a valid origin/.test((err as Error).message));
  assert.throws(() => cleanOrigins(['https://a.com', 123]), KeyInputError);
  assert.throws(() => cleanOrigins(['ftp://a.com']), KeyInputError);
  assert.throws(() => cleanOrigins(['']), KeyInputError);
});

test('originAllowed matches exact origins after normalization', () => {
  const allowed = ['https://loginlens.example.com', 'http://localhost:3000'];
  assert.equal(originAllowed(allowed, 'https://loginlens.example.com'), true);
  assert.equal(originAllowed(allowed, 'https://LoginLens.Example.com'), true);
  assert.equal(originAllowed(allowed, 'http://localhost:3000'), true);
  assert.equal(originAllowed(allowed, 'http://localhost:3001'), false);
  assert.equal(originAllowed(allowed, 'https://evil.example.com'), false);
  assert.equal(originAllowed(allowed, 'https://loginlens.example.com.evil.net'), false);
  assert.equal(originAllowed([], 'https://loginlens.example.com'), false);
});

test('originAllowed matches *.example.com subdomains but not the apex or look-alikes', () => {
  const allowed = ['https://*.example.com'];
  assert.equal(originAllowed(allowed, 'https://app.example.com'), true);
  assert.equal(originAllowed(allowed, 'https://a.b.example.com'), true);
  assert.equal(originAllowed(allowed, 'https://example.com'), false);
  assert.equal(originAllowed(allowed, 'https://evilexample.com'), false);
  assert.equal(originAllowed(allowed, 'https://example.com.evil.com'), false);
  assert.equal(originAllowed(allowed, 'https://app.example.com:8443'), false, 'port must match');
  assert.equal(originAllowed(['https://*.example.com:8443'], 'https://app.example.com:8443'), true);
  assert.equal(originAllowed(['https://*.example.com:8443'], 'https://app.example.com'), false);
});

test('originAllowed rejects a scheme mismatch', () => {
  assert.equal(originAllowed(['https://example.com'], 'http://example.com'), false);
  assert.equal(originAllowed(['https://*.example.com'], 'http://app.example.com'), false);
  assert.equal(originAllowed(['http://*.example.com'], 'https://app.example.com'), false);
});

test('originAllowed is false for a missing or unusable origin', () => {
  const allowed = ['https://example.com', 'https://*.example.com'];
  assert.equal(originAllowed(allowed, undefined), false);
  assert.equal(originAllowed(allowed, ''), false);
  assert.equal(originAllowed(allowed, 'null'), false);
  assert.equal(originAllowed(allowed, 'not a url'), false);
  assert.equal(originAllowed(allowed, 'https://example.com/path'), false);
});

test('originAllowed does not accept a wildcard pattern sent as the request origin', () => {
  // A real Origin header is always a concrete scheme://host[:port]; a pattern must never match.
  assert.equal(originAllowed(['https://*.example.com'], 'https://*.example.com'), false);
  assert.equal(originAllowed(['https://*.example.com'], 'https://*.sub.example.com'), false);
});

// =====================================================================
// First-run setup flow
// =====================================================================

test('first ensureAppKey starts a pending setup whose key is shown once and verifies', async () => {
  const { db, config, secrets, projectId } = await setupFixture({ SETUP_WINDOW_MINUTES: '15' });
  assert.equal(await setupStatus(db), 'none');
  const before = Date.now();
  const rec = await ensureAppKey(db, secrets, config, projectId);
  const after = Date.now();
  assert.equal(rec.status, 'pending');
  assert.ok(rec.keyId);
  assert.ok(rec.windowEndsAt! >= before + 15 * 60_000 && rec.windowEndsAt! <= after + 15 * 60_000);
  assert.equal(await setupStatus(db), 'pending');

  const view = await ownerView(db, secrets);
  assert.equal(view.status, 'pending');
  assert.ok(view.appKey);
  assert.equal(view.windowEndsAt, rec.windowEndsAt);
  const check = await verifyKey(db, view.appKey);
  assert.equal(check.ok, true);
  if (check.ok) assert.equal(check.key.id, rec.keyId);

  // The stored record holds the key only in encrypted form.
  const raw = await readSetupRow(db);
  assert.ok(raw);
  assert.ok(!raw.includes(view.appKey), 'settings row must not contain the plaintext key');
  assert.ok(!raw.includes(view.appKey.slice(8)));
  const stored = JSON.parse(raw) as { enc: string };
  assert.equal(secrets.decrypt(stored.enc, 'setup-key'), view.appKey);
  assert.throws(() => secrets.decrypt(stored.enc, 'other-purpose'));
  assert.throws(() => new Secrets(OTHER_SECRET).decrypt(stored.enc, 'setup-key'));
  await db.close();
});

test('SETUP_WINDOW_MINUTES is clamped to at least five minutes', async () => {
  const { db, config, secrets, projectId } = await setupFixture({ SETUP_WINDOW_MINUTES: '1' });
  assert.equal(config.setupWindowMinutes, 5);
  const before = Date.now();
  const rec = await ensureAppKey(db, secrets, config, projectId);
  assert.ok(rec.windowEndsAt! >= before + 5 * 60_000);
  await db.close();
});

test('restarting during an open setup window keeps the same pending key', async () => {
  const { db, config, secrets, projectId } = await setupFixture();
  const first = await ensureAppKey(db, secrets, config, projectId);
  const key1 = (await ownerView(db, secrets)).appKey;
  const second = await ensureAppKey(db, secrets, config, projectId);
  assert.equal(second.keyId, first.keyId);
  assert.equal(second.status, 'pending');
  assert.equal((await ownerView(db, secrets)).appKey, key1);
  assert.equal((await listKeys(db, projectId)).length, 1);
  await db.close();
});

test('confirmSetup forgets the key: setupView no longer returns it and the settings row drops the encrypted copy', async () => {
  const { db, config, secrets, projectId } = await setupFixture();
  const rec = await ensureAppKey(db, secrets, config, projectId);
  const view = await ownerView(db, secrets);
  const appKey = view.appKey!;
  const enc = (JSON.parse((await readSetupRow(db))!) as { enc: string }).enc;
  assert.ok(enc);

  assert.equal(await ownerConfirm(db), true);
  const after = await ownerView(db, secrets);
  assert.equal(after.status, 'claimed');
  assert.equal(after.appKey, undefined);
  assert.equal(await setupStatus(db), 'claimed');

  const raw = (await readSetupRow(db))!;
  const stored = JSON.parse(raw) as Record<string, unknown>;
  assert.equal(stored.status, 'claimed');
  assert.equal(stored.keyId, rec.keyId);
  assert.ok(!('enc' in stored));
  assert.ok(!raw.includes(enc));
  assert.ok(!raw.includes(appKey));

  // The key itself keeps working (only its hash is kept), and confirming twice is refused.
  assert.equal((await verifyKey(db, appKey)).ok, true);
  assert.equal(await ownerConfirm(db), false);

  // A restart after confirmation keeps the same key and does not reveal it again.
  const again = await ensureAppKey(db, secrets, config, projectId);
  assert.equal(again.keyId, rec.keyId);
  assert.equal(again.status, 'claimed');
  assert.equal((await ownerView(db, secrets)).appKey, undefined);
  await db.close();
});

test('confirmSetup without a pending setup does nothing', async () => {
  const { db } = await setupFixture();
  assert.equal(await ownerConfirm(db), false);
  assert.deepEqual(await ownerView(db, new Secrets(TEST_SECRET)), { status: 'expired' });
  assert.equal(await setupStatus(db), 'none');
  await db.close();
});

test('an expired setup window hides the key, and if the key was never used the next ensureAppKey issues a new one and revokes it', async () => {
  const { db, config, secrets, projectId } = await setupFixture();
  const first = await ensureAppKey(db, secrets, config, projectId);
  const oldKey = (await ownerView(db, secrets)).appKey!;
  assert.equal((await getKey(db, first.keyId))?.lastUsedAt, null, 'nobody has used the key');

  const rec = JSON.parse((await readSetupRow(db))!) as Record<string, unknown>;
  rec.windowEndsAt = Date.now() - 1_000;
  await db.run('UPDATE settings SET value = ? WHERE key = ?', [JSON.stringify(rec), SETUP_SETTING]);

  const view = await ownerView(db, secrets);
  assert.deepEqual(view, { status: 'expired' });
  const raw = (await readSetupRow(db))!;
  const stored = JSON.parse(raw) as Record<string, unknown>;
  assert.equal(stored.status, 'expired');
  assert.ok(!('enc' in stored), 'the encrypted key is dropped once the window has passed');
  assert.ok(!raw.includes(oldKey));
  assert.equal(await ownerConfirm(db), false, 'an expired setup cannot be confirmed');

  const next = await ensureAppKey(db, secrets, config, projectId);
  assert.equal(next.status, 'pending');
  assert.notEqual(next.keyId, first.keyId);
  const newKey = (await ownerView(db, secrets)).appKey!;
  assert.ok(newKey);
  assert.notEqual(newKey, oldKey);
  assert.equal((await verifyKey(db, newKey)).ok, true);
  assert.deepEqual(await verifyKey(db, oldKey), { ok: false, reason: 'revoked' });
  assert.equal((await getKey(db, first.keyId))?.revokedAt !== null, true);
  await db.close();
});

test('a key LoginLens already uses is kept when the setup window closes without "I saved the key"', async () => {
  const { db, config, secrets, projectId } = await setupFixture();
  const first = await ensureAppKey(db, secrets, config, projectId);
  const key = (await ownerView(db, secrets)).appKey!;
  assert.equal((await verifyKey(db, key)).ok, true, 'LoginLens calls Scout with the key');

  const rec = JSON.parse((await readSetupRow(db))!) as Record<string, unknown>;
  rec.windowEndsAt = Date.now() - 1_000;
  await db.run('UPDATE settings SET value = ? WHERE key = ?', [JSON.stringify(rec), SETUP_SETTING]);

  // Restart after the window: the used key is counted as saved, not replaced.
  const next = await ensureAppKey(db, secrets, config, projectId);
  assert.equal(next.status, 'claimed');
  assert.equal(next.keyId, first.keyId);
  clearKeyCache();
  assert.equal((await verifyKey(db, key)).ok, true, 'the key LoginLens uses keeps working');
  const view = await ownerView(db, secrets);
  assert.equal(view.status, 'claimed');
  assert.equal(view.appKey, undefined);
  const raw = (await readSetupRow(db))!;
  assert.ok(!raw.includes('"enc"'), 'the encrypted copy is dropped');
  assert.equal((await listKeys(db, projectId)).length, 1, 'no new key was made');
  await db.close();
});

test('a used key is also kept when the page closed the window first and Scout restarts later', async () => {
  const { db, config, secrets, projectId } = await setupFixture();
  const first = await ensureAppKey(db, secrets, config, projectId);
  const key = (await ownerView(db, secrets)).appKey!;
  const rec = JSON.parse((await readSetupRow(db))!) as Record<string, unknown>;
  rec.windowEndsAt = Date.now() - 1_000;
  await db.run('UPDATE settings SET value = ? WHERE key = ?', [JSON.stringify(rec), SETUP_SETTING]);
  // The page is opened after the window: nobody had used the key yet, so it is marked expired.
  assert.equal((await ownerView(db, secrets)).status, 'expired');
  // LoginLens starts using the key afterwards (the owner had copied it in time).
  assert.equal((await verifyKey(db, key)).ok, true);
  const next = await ensureAppKey(db, secrets, config, projectId);
  assert.equal(next.status, 'claimed');
  assert.equal(next.keyId, first.keyId);
  clearKeyCache();
  assert.equal((await verifyKey(db, key)).ok, true);
  await db.close();
});

test('two browsers opening setup at the same moment: only one gets the key', async () => {
  const { db, config, secrets, projectId } = await setupFixture();
  await ensureAppKey(db, secrets, config, projectId);
  const views = await Promise.all([setupView(db, secrets), setupView(db, secrets), setupView(db, secrets)]);
  const withKey = views.filter((v) => v.appKey);
  assert.equal(withKey.length, 1, JSON.stringify(views.map((v) => v.status)));
  assert.ok(withKey[0]!.newViewerToken);
  assert.equal(views.filter((v) => v.status === 'shown_elsewhere').length, 2);
  assert.equal(await confirmSetup(db, undefined), false);
  assert.equal(await confirmSetup(db, 'not-the-token-at-all-000000000000'), false);
  assert.equal(await confirmSetup(db, withKey[0]!.newViewerToken), true);
  await db.close();
});

test('SCOUT_APP_KEY makes the hosting secret the only valid key: earlier keys stop working', async () => {
  const { db, config, secrets, projectId } = await setupFixture();
  await ensureAppKey(db, secrets, config, projectId);
  const shownKey = (await ownerView(db, secrets)).appKey!;
  assert.equal((await verifyKey(db, shownKey)).ok, true);

  const envKey = `sct_sec_${'Zq9'.repeat(12)}`;
  for (const extra of [{}, { SCOUT_NEW_APP_KEY: 'true' }] as Array<Record<string, string>>) {
    const envConfig = testConfig({ SCOUT_APP_KEY: envKey, ...extra });
    const rec = await ensureAppKey(db, secrets, envConfig, projectId);
    assert.equal(rec.status, 'env');
    clearKeyCache();
    assert.deepEqual(await verifyKey(db, shownKey), { ok: false, reason: 'revoked' }, 'the key shown at /setup no longer works');
    assert.equal((await verifyKey(db, envKey)).ok, true);
    const active = (await listKeys(db, projectId)).filter((k) => keyStatus(k) === 'active');
    assert.deepEqual(active.map((k) => k.source), ['env']);
  }

  // Even if the env key was revoked somehow (e.g. an old rotation), the hosting secret wins on restart.
  const envRow = (await findKeyByPlaintext(db, envKey))!;
  await revokeKey(db, envRow.id);
  await ensureAppKey(db, secrets, testConfig({ SCOUT_APP_KEY: envKey }), projectId);
  clearKeyCache();
  assert.equal((await verifyKey(db, envKey)).ok, true);
  await db.close();
});

test('a pending window that lapsed before anyone opened setup is replaced on the next ensureAppKey', async () => {
  const { db, config, secrets, projectId } = await setupFixture();
  const first = await ensureAppKey(db, secrets, config, projectId);
  const oldKey = (await ownerView(db, secrets)).appKey!;
  const rec = JSON.parse((await readSetupRow(db))!) as Record<string, unknown>;
  rec.windowEndsAt = Date.now() - 1;
  await db.run('UPDATE settings SET value = ? WHERE key = ?', [JSON.stringify(rec), SETUP_SETTING]);

  const next = await ensureAppKey(db, secrets, config, projectId);
  assert.equal(next.status, 'pending');
  assert.notEqual(next.keyId, first.keyId);
  assert.deepEqual(await verifyKey(db, oldKey), { ok: false, reason: 'revoked' });
  const newKey = (await ownerView(db, secrets)).appKey!;
  assert.equal((await verifyKey(db, newKey)).ok, true);
  await db.close();
});

test('SCOUT_APP_KEY registers exactly that key in env mode and never reveals it through setup', async () => {
  const envKey = `sct_sec_${'Ab1'.repeat(10)}`;
  const { db, config, secrets, projectId } = await setupFixture({ SCOUT_APP_KEY: envKey });
  const rec = await ensureAppKey(db, secrets, config, projectId);
  assert.equal(rec.status, 'env');
  assert.equal(rec.enc, undefined);

  const key = await findKeyByPlaintext(db, envKey);
  assert.ok(key);
  assert.equal(key.id, rec.keyId);
  assert.equal(key.source, 'env');
  const check = await verifyKey(db, envKey);
  assert.equal(check.ok, true);

  assert.deepEqual(await ownerView(db, secrets), { status: 'env' });
  assert.equal(await ownerConfirm(db), false);
  const raw = (await readSetupRow(db))!;
  assert.ok(!raw.includes(envKey));
  for (const r of await apiKeyRows(db)) {
    for (const value of Object.values(r)) assert.ok(!String(value).includes(envKey));
  }

  // Restarting with the same env key reuses the stored key instead of adding another.
  const again = await ensureAppKey(db, secrets, config, projectId);
  assert.equal(again.keyId, rec.keyId);
  assert.equal((await listKeys(db, projectId)).length, 1);
  await db.close();
});

test('an invalid SCOUT_APP_KEY throws SetupError and creates nothing', async () => {
  for (const bad of ['hello', 'sct_sec_short', `sct_pub_${'a'.repeat(30)}`, `sct_sec_${'a'.repeat(20)}!`]) {
    const { db, config, secrets, projectId } = await setupFixture({ SCOUT_APP_KEY: bad });
    await assert.rejects(ensureAppKey(db, secrets, config, projectId), SetupError, bad);
    assert.equal((await listKeys(db, projectId)).length, 0);
    assert.equal(await setupStatus(db), 'none');
    await db.close();
  }
});

test('SCOUT_NEW_APP_KEY=true issues a fresh key and revokes all previous keys', async () => {
  const { db, config, secrets, projectId } = await setupFixture();
  const first = await ensureAppKey(db, secrets, config, projectId);
  const firstKey = (await ownerView(db, secrets)).appKey!;
  assert.equal(await ownerConfirm(db), true);
  const extra = await createKey(db, { projectId, name: 'manual', rateLimitPerMin: 10 });

  const newConfig = testConfig({ SCOUT_NEW_APP_KEY: 'true' });
  assert.equal(newConfig.newAppKeyOnStart, true);
  const next = await ensureAppKey(db, secrets, newConfig, projectId);
  assert.equal(next.status, 'pending');
  assert.notEqual(next.keyId, first.keyId);

  const freshKey = (await ownerView(db, secrets)).appKey!;
  assert.ok(freshKey);
  assert.notEqual(freshKey, firstKey);
  assert.equal((await verifyKey(db, freshKey)).ok, true);
  assert.deepEqual(await verifyKey(db, firstKey), { ok: false, reason: 'revoked' });
  assert.deepEqual(await verifyKey(db, extra.plaintext), { ok: false, reason: 'revoked' });
  const active = (await listKeys(db, projectId)).filter((k) => k.revokedAt === null);
  assert.deepEqual(active.map((k) => k.id), [next.keyId]);
  await db.close();
});
