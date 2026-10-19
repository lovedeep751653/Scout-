import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { testApp, testEnv } from './helpers.ts';

test('health endpoint answers and reports the database', async () => {
  const env = await testEnv();
  const app = await testApp(env);
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().database, 'ok');
  await app.close();
  await env.db.close();
});

test('chat through the API with the mock AI', async () => {
  const env = await testEnv();
  const app = await testApp(env);
  const res = await app.inject({ method: 'POST', url: '/v1/chat', headers: { authorization: `Bearer ${env.appKey}` }, payload: { user_id: 'u1', message: 'hello' } });
  assert.equal(res.statusCode, 200, res.body);
  assert.match(res.json().reply, /Mock reply/);
  await app.close();
  await env.db.close();
});

test('npm run doctor explains the setup and changes nothing', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-doctor-'));
  const dataDir = path.join(base, 'data');
  try {
    const run = (env: Record<string, string>) =>
      spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/cli.ts', 'doctor'], {
        encoding: 'utf8',
        timeout: 30_000,
        env: { PATH: process.env.PATH ?? '', DATA_DIR: dataDir, PORT: '1', ...env },
      });
    const ok = run({ MODEL_PROVIDER: 'mock' });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /Settings are valid/);
    assert.match(ok.stdout, /No database yet/);
    assert.match(ok.stdout, /Scout is not running on port 1/);
    assert.equal(fs.existsSync(dataDir), false, 'the doctor must not create the data folder');

    const missingKey = run({ MODEL_PROVIDER: 'groq' });
    assert.equal(missingKey.status, 1);
    assert.match(missingKey.stdout, /needs SCOUT_MODEL_API_KEY/);

    const shortKey = run({ MODEL_PROVIDER: 'mock', SCOUT_ENCRYPTION_KEY: 'too-short' });
    assert.equal(shortKey.status, 1, 'a key Scout would refuse at start is reported as a problem');
    assert.match(shortKey.stdout, /SCOUT_ENCRYPTION_KEY is too short/);
    assert.ok(!shortKey.stdout.includes('too-short'), 'the key itself is not printed');

    const secret = 'gsk_doctor_must_not_print_this_123';
    const withKey = run({ MODEL_PROVIDER: 'groq', SCOUT_MODEL_API_KEY: secret, SCOUT_APP_KEY: `sct_sec_${'a'.repeat(40)}` });
    assert.equal(withKey.status, 0, withKey.stdout);
    assert.ok(!withKey.stdout.includes(secret) && !withKey.stdout.includes('a'.repeat(40)), 'secrets are never printed');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
