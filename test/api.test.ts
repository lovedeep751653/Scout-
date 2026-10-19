import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createKey, mintUserToken, revokeKey } from '../src/keys/keys.ts';
import { createProject } from '../src/keys/projects.ts';
import { ensureAppKey, setupView } from '../src/keys/setup.ts';
import { Secrets } from '../src/security/crypto.ts';
import { parseSseBody, testApp, testEnv, type TestEnv } from './helpers.ts';

// End-to-end tests of the HTTP API through app.inject. Every test builds its own
// database, app and rate limiter, and closes them even when an assertion fails.

type App = Awaited<ReturnType<typeof testApp>>;
type Ctx = { env: TestEnv; app: App };

async function withApp(opts: Parameters<typeof testEnv>[0], fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const env = await testEnv(opts);
  const app = await testApp(env);
  try {
    await fn({ env, app });
  } finally {
    await app.close();
    await env.db.close();
  }
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const appAuth = (env: TestEnv) => auth(env.appKey);
const LOGINLENS = 'https://loginlens.example';

async function mintToken({ env, app }: Ctx, userId: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/v1/users/token', headers: appAuth(env), payload: { user_id: userId } });
  assert.equal(res.statusCode, 200, res.body);
  const token = res.json().token as string;
  assert.match(token, /^sct_ut_/);
  return token;
}

async function chatAs({ env, app }: Ctx, userId: string, message: string, extra: Record<string, unknown> = {}) {
  const res = await app.inject({ method: 'POST', url: '/v1/chat', headers: appAuth(env), payload: { user_id: userId, message, ...extra } });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as {
    session_id: string;
    message_id: string;
    reply: string;
    pending_actions: Array<{ id: string; tool: string; summary: string; expires_at: number }>;
  };
}

async function enableTools({ env, app }: Ctx, tools: string[]): Promise<void> {
  const res = await app.inject({ method: 'PUT', url: '/v1/settings', headers: appAuth(env), payload: { enabled_tools: tools } });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().enabled_tools, tools);
}

async function count(env: TestEnv, sql: string, params: string[]): Promise<number> {
  const row = await env.db.get<{ n: number | string }>(sql, params);
  return Number(row?.n ?? 0);
}

function errorCode(res: { json(): unknown }): string {
  return (res.json() as { error: { code: string } }).error.code;
}

// =====================================================================
// Health and setup pages
// =====================================================================

test('GET /health reports ok, the version, the database and the AI state without needing a key', async () => {
  await withApp({}, async ({ env, app }) => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type']), /application\/json/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.deepEqual(res.json(), { status: 'ok', version: env.config.version, database: 'ok', ai: { state: 'ready', model: 'mock-1' } });
  });
});

test('GET /health says starting with download progress while the local AI downloads', async () => {
  await withApp({}, async ({ env, app }) => {
    env.deps.runtime = { ready: false, status: () => ({ state: 'downloading', model: 'local-model', message: 'Downloading the AI model.', percent: 42, since: Date.now() }) };
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { status: 'starting', version: env.config.version, database: 'ok', ai: { state: 'downloading', model: 'local-model', percent: 42 } });
  });
});

test('GET /health says degraded when the database does not answer', async () => {
  await withApp({}, async ({ env, app }) => {
    const realPing = env.db.ping;
    env.db.ping = async () => {
      throw new Error('database is down');
    };
    try {
      const res = await app.inject({ method: 'GET', url: '/health' });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().status, 'degraded');
      assert.equal(res.json().database, 'error');
    } finally {
      env.db.ping = realPing;
    }
  });
});

test('GET /setup shows the new app key once, and after POST /setup/confirm it is gone', async () => {
  await withApp({}, async (ctx) => {
    const { env, app } = ctx;
    const rec = await ensureAppKey(env.db, env.secrets, env.config, env.project.id);
    assert.equal(rec.status, 'pending');
    const key = (await setupView(env.db, env.secrets)).appKey;
    assert.ok(key);

    const page = await app.inject({ method: 'GET', url: '/setup' });
    assert.equal(page.statusCode, 200);
    assert.match(String(page.headers['content-type']), /text\/html/);
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.equal(page.headers['x-robots-tag'], 'noindex');
    assert.ok(page.body.includes(key), 'the setup page shows the pending key');

    // The key shown on the page is a working app key.
    const status = await app.inject({ method: 'GET', url: '/v1/status', headers: auth(key) });
    assert.equal(status.statusCode, 200, status.body);
    assert.equal(status.json().setup, 'pending');

    const confirm = await app.inject({ method: 'POST', url: '/setup/confirm' });
    assert.equal(confirm.statusCode, 200);
    assert.deepEqual(confirm.json(), { ok: true });

    const after = await app.inject({ method: 'GET', url: '/setup' });
    assert.equal(after.statusCode, 200);
    assert.equal(after.headers['cache-control'], 'no-store');
    assert.ok(!after.body.includes(key), 'the key is never shown again after confirming');
    assert.ok(!after.body.includes(key.slice(8)), 'not even the random part of the key is shown');
    assert.match(after.body, /Scout is set up/);

    // A second confirm has nothing left to confirm.
    const again = await app.inject({ method: 'POST', url: '/setup/confirm' });
    assert.deepEqual(again.json(), { ok: false });

    // The key itself keeps working after setup is confirmed.
    const stillWorks = await app.inject({ method: 'GET', url: '/v1/status', headers: auth(key) });
    assert.equal(stillWorks.statusCode, 200);
    assert.equal(stillWorks.json().setup, 'claimed');
  });
});

test('a cross-origin POST /setup/confirm is rejected and the key stays pending', async () => {
  await withApp({}, async ({ env, app }) => {
    await ensureAppKey(env.db, env.secrets, env.config, env.project.id);
    const key = (await setupView(env.db, env.secrets)).appKey!;

    for (const origin of ['https://evil.example', 'null', LOGINLENS]) {
      const res = await app.inject({ method: 'POST', url: '/setup/confirm', headers: { origin } });
      assert.equal(res.statusCode, 403, `origin ${origin} must not confirm setup`);
      assert.equal(errorCode(res), 'forbidden');
    }

    const page = await app.inject({ method: 'GET', url: '/setup' });
    assert.ok(page.body.includes(key), 'the key is still shown because setup was not confirmed');
  });
});

test('POST /setup/confirm from Scout\'s own public origin is accepted', async () => {
  await withApp({}, async ({ env, app }) => {
    await ensureAppKey(env.db, env.secrets, env.config, env.project.id);
    const res = await app.inject({ method: 'POST', url: '/setup/confirm', headers: { origin: 'https://scout.test' } });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), { ok: true });
  });
});

test('GET /setup without a pending key shows no key and is not cached', async () => {
  await withApp({}, async ({ env, app }) => {
    const res = await app.inject({ method: 'GET', url: '/setup' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.ok(!res.body.includes(env.appKey));
    assert.doesNotMatch(res.body, /sct_sec_/);
  });
});

// =====================================================================
// Authentication
// =====================================================================

test('requests without credentials get 401', async () => {
  await withApp({}, async ({ app }) => {
    for (const [method, url] of [
      ['GET', '/v1/status'],
      ['POST', '/v1/chat'],
      ['GET', '/v1/sessions'],
      ['PUT', '/v1/settings'],
      ['GET', '/v1/widget/config'],
    ] as const) {
      const res = await app.inject({ method, url, payload: method === 'GET' ? undefined : {} });
      assert.equal(res.statusCode, 401, `${method} ${url}`);
      assert.equal(errorCode(res), 'unauthorized');
    }
  });
});

test('an unknown app key, or a value that is not a Scout key, gets 401', async () => {
  await withApp({}, async ({ app }) => {
    const unknown = await app.inject({ method: 'GET', url: '/v1/status', headers: auth(`sct_sec_${'A'.repeat(40)}`) });
    assert.equal(unknown.statusCode, 401);
    assert.equal(errorCode(unknown), 'unauthorized');
    assert.match(unknown.json().error.message, /Unknown app key/);

    const notAKey = await app.inject({ method: 'GET', url: '/v1/status', headers: auth('hello-world') });
    assert.equal(notAKey.statusCode, 401);
  });
});

test('the app key is also accepted in the x-scout-key header', async () => {
  await withApp({}, async ({ env, app }) => {
    const res = await app.inject({ method: 'GET', url: '/v1/status', headers: { 'x-scout-key': env.appKey } });
    assert.equal(res.statusCode, 200, res.body);
  });
});

test('a revoked app key gets 401', async () => {
  await withApp({}, async ({ env, app }) => {
    const before = await app.inject({ method: 'GET', url: '/v1/status', headers: appAuth(env) });
    assert.equal(before.statusCode, 200);
    assert.equal(await revokeKey(env.db, env.appKeyId), true);
    const after = await app.inject({ method: 'GET', url: '/v1/status', headers: appAuth(env) });
    assert.equal(after.statusCode, 401);
    assert.equal(errorCode(after), 'unauthorized');
    assert.match(after.json().error.message, /revoked/);
    const chat = await app.inject({ method: 'POST', url: '/v1/chat', headers: appAuth(env), payload: { user_id: 'u1', message: 'hi' } });
    assert.equal(chat.statusCode, 401);
  });
});

test('an expired app key gets 401', async () => {
  await withApp({}, async ({ env, app }) => {
    const { plaintext } = await createKey(env.db, { projectId: env.project.id, rateLimitPerMin: 1000, expiresAt: Date.now() - 1000 });
    const res = await app.inject({ method: 'GET', url: '/v1/status', headers: auth(plaintext) });
    assert.equal(res.statusCode, 401);
    assert.match(res.json().error.message, /expired/);
  });
});

test('an app key sent with an Origin header is refused with 403 app_key_in_browser', async () => {
  await withApp({}, async ({ env, app }) => {
    // Scout's own public origin passes the CORS check, so the key check itself is what refuses.
    const res = await app.inject({ method: 'GET', url: '/v1/status', headers: { ...appAuth(env), origin: 'https://scout.test' } });
    assert.equal(res.statusCode, 403);
    assert.equal(errorCode(res), 'app_key_in_browser');

    // Even from an origin the owner allowed, an app key must not come from a browser.
    const put = await app.inject({ method: 'PUT', url: '/v1/settings', headers: appAuth(env), payload: { allowed_origins: [LOGINLENS] } });
    assert.equal(put.statusCode, 200);
    const chat = await app.inject({ method: 'POST', url: '/v1/chat', headers: { ...appAuth(env), origin: LOGINLENS }, payload: { user_id: 'u1', message: 'hi' } });
    assert.equal(chat.statusCode, 403);
    assert.equal(errorCode(chat), 'app_key_in_browser');
  });
});

test('many failed sign-in attempts from one IP are eventually rate limited with 429', async () => {
  await withApp({}, async ({ app }) => {
    const attacker = { 'x-forwarded-for': '198.51.100.7' };
    const codes: number[] = [];
    let limited: Awaited<ReturnType<App['inject']>> | undefined;
    for (let i = 0; i < 30; i++) {
      const res = await app.inject({ method: 'GET', url: '/v1/status', headers: { ...attacker, ...auth(`sct_sec_${String(i).padStart(30, 'x')}`) } });
      codes.push(res.statusCode);
      if (res.statusCode === 429) {
        limited = res;
        break;
      }
    }
    assert.ok(limited, `expected a 429 after repeated failures, got ${codes.join(',')}`);
    assert.ok(codes.slice(0, -1).every((c) => c === 401), 'failures before the limit are 401');
    assert.ok(codes.length > 1, 'the very first failure is not rate limited');
    assert.equal(errorCode(limited), 'rate_limited');
    const retryAfter = Number(limited.headers['retry-after']);
    assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1, `retry-after should be a positive integer, got ${limited.headers['retry-after']}`);

    // Garbage user tokens from the same IP are also limited.
    const token = await app.inject({ method: 'GET', url: '/v1/widget/config', headers: { ...attacker, ...auth('sct_ut_garbage.garbage') } });
    assert.equal(token.statusCode, 429);

    // Another IP is not affected.
    const other = await app.inject({ method: 'GET', url: '/v1/status', headers: { 'x-forwarded-for': '198.51.100.8', ...auth(`sct_sec_${'B'.repeat(30)}`) } });
    assert.equal(other.statusCode, 401);
  });
});

test('an app key without the settings scope gets 403 on PUT /v1/settings but can still chat', async () => {
  await withApp({}, async ({ env, app }) => {
    const { plaintext } = await createKey(env.db, { projectId: env.project.id, name: 'chat only', scopes: ['chat'], rateLimitPerMin: 1000 });
    const put = await app.inject({ method: 'PUT', url: '/v1/settings', headers: auth(plaintext), payload: { agent_name: 'Hijacked' } });
    assert.equal(put.statusCode, 403);
    assert.equal(errorCode(put), 'missing_scope');

    const get = await app.inject({ method: 'GET', url: '/v1/settings', headers: auth(plaintext) });
    assert.equal(get.statusCode, 403);

    for (const [method, url] of [
      ['POST', '/v1/users/token'],
      ['POST', '/v1/app-key/rotate'],
      ['PUT', '/v1/connectors/loginlens'],
      ['GET', '/v1/users/u1/export'],
      ['DELETE', '/v1/users/u1'],
    ] as const) {
      const res = await app.inject({ method, url, headers: auth(plaintext), payload: method === 'GET' || method === 'DELETE' ? undefined : { user_id: 'u1' } });
      assert.equal(res.statusCode, 403, `${method} ${url}`);
      assert.equal(errorCode(res), 'missing_scope');
    }

    const chat = await app.inject({ method: 'POST', url: '/v1/chat', headers: auth(plaintext), payload: { user_id: 'u1', message: 'hello' } });
    assert.equal(chat.statusCode, 200, chat.body);

    // The settings were not changed by the refused request.
    const settings = await app.inject({ method: 'GET', url: '/v1/settings', headers: appAuth(env) });
    assert.equal(settings.json().agent_name, 'Scout');
  });
});

// =====================================================================
// CORS and allowed origins
// =====================================================================

test('a preflight from an origin that is not allowed yet is refused with 403', async () => {
  await withApp({}, async ({ app }) => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/v1/chat',
      headers: { origin: LOGINLENS, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type' },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  });
});

test('after PUT /v1/settings allows an origin, its preflight gets 204 with CORS headers and other origins stay blocked', async () => {
  await withApp({}, async (ctx) => {
    const { env, app } = ctx;
    const put = await app.inject({ method: 'PUT', url: '/v1/settings', headers: appAuth(env), payload: { allowed_origins: [LOGINLENS] } });
    assert.equal(put.statusCode, 200, put.body);
    assert.deepEqual(put.json().allowed_origins, [LOGINLENS]);

    const pre = await app.inject({ method: 'OPTIONS', url: '/v1/chat', headers: { origin: LOGINLENS, 'access-control-request-method': 'POST' } });
    assert.equal(pre.statusCode, 204);
    assert.equal(pre.headers['access-control-allow-origin'], LOGINLENS);
    assert.match(String(pre.headers['access-control-allow-headers']), /authorization/);
    assert.match(String(pre.headers['access-control-allow-methods']), /POST/);
    assert.equal(pre.headers.vary, 'Origin');

    // The browser chat window (user token) works from the allowed origin.
    const token = await mintToken(ctx, 'u1');
    const chat = await app.inject({ method: 'POST', url: '/v1/chat', headers: { ...auth(token), origin: LOGINLENS }, payload: { message: 'hello' } });
    assert.equal(chat.statusCode, 200, chat.body);
    assert.equal(chat.headers['access-control-allow-origin'], LOGINLENS);

    // Other origins, look-alikes and scheme changes are still refused on /v1/*.
    for (const origin of ['https://evil.example', 'https://loginlens.example.evil.com', 'http://loginlens.example', 'https://sub.loginlens.example', 'null']) {
      const preflight = await app.inject({ method: 'OPTIONS', url: '/v1/chat', headers: { origin, 'access-control-request-method': 'POST' } });
      assert.equal(preflight.statusCode, 403, `preflight from ${origin}`);
      assert.equal(preflight.headers['access-control-allow-origin'], undefined);

      const res = await app.inject({ method: 'POST', url: '/v1/chat', headers: { ...auth(token), origin }, payload: { message: 'hello' } });
      assert.equal(res.statusCode, 403, `request from ${origin}`);
      assert.equal(errorCode(res), 'origin_not_allowed');
      assert.equal(res.headers['access-control-allow-origin'], undefined);

      const cfg = await app.inject({ method: 'GET', url: '/v1/widget/config', headers: { ...auth(token), origin } });
      assert.equal(cfg.statusCode, 403);
    }
  });
});

test('origins from SCOUT_ALLOWED_ORIGINS are allowed without any settings change', async () => {
  await withApp({ env: { SCOUT_ALLOWED_ORIGINS: LOGINLENS } }, async ({ app }) => {
    const pre = await app.inject({ method: 'OPTIONS', url: '/v1/chat', headers: { origin: LOGINLENS, 'access-control-request-method': 'POST' } });
    assert.equal(pre.statusCode, 204);
    assert.equal(pre.headers['access-control-allow-origin'], LOGINLENS);
  });
});

test('PUT /v1/settings rejects allowed_origins that are not plain origins', async () => {
  await withApp({}, async ({ env, app }) => {
    for (const bad of [['https://loginlens.example/path'], ['javascript:alert(1)'], 'https://loginlens.example', [42]]) {
      const res = await app.inject({ method: 'PUT', url: '/v1/settings', headers: appAuth(env), payload: { allowed_origins: bad } });
      assert.equal(res.statusCode, 400, `allowed_origins ${JSON.stringify(bad)}`);
      assert.equal(errorCode(res), 'invalid_input');
    }
    const settings = await app.inject({ method: 'GET', url: '/v1/settings', headers: appAuth(env) });
    assert.deepEqual(settings.json().allowed_origins, []);
  });
});

// =====================================================================
// User tokens
// =====================================================================

test('POST /v1/users/token returns a short-lived token for one user', async () => {
  await withApp({}, async ({ env, app }) => {
    const before = Date.now();
    const res = await app.inject({ method: 'POST', url: '/v1/users/token', headers: appAuth(env), payload: { user_id: 'u1' } });
    assert.equal(res.statusCode, 200, res.body);
    const { token, expires_at } = res.json() as { token: string; expires_at: number };
    assert.match(token, /^sct_ut_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.ok(!token.includes(env.appKey));
    // Default lifetime is 15 minutes.
    assert.ok(expires_at >= before + 899_000 && expires_at <= Date.now() + 900_000 + 1000, `expires_at ${expires_at}`);

    // A requested lifetime is capped at USER_TOKEN_MAX_TTL_SECONDS (default 1 hour).
    const long = await app.inject({ method: 'POST', url: '/v1/users/token', headers: appAuth(env), payload: { user_id: 'u1', ttl_seconds: 999_999 } });
    assert.equal(long.statusCode, 200);
    assert.ok(long.json().expires_at <= Date.now() + 3600_000 + 1000);
  });
});

test('POST /v1/users/token needs a valid user_id', async () => {
  await withApp({}, async ({ env, app }) => {
    for (const payload of [{}, { user_id: '' }, { user_id: 'has space' }, { user_id: 'a/b' }, { user_id: 'x'.repeat(129) }, { user_id: 7 }]) {
      const res = await app.inject({ method: 'POST', url: '/v1/users/token', headers: appAuth(env), payload });
      assert.equal(res.statusCode, 400, JSON.stringify(payload));
      assert.equal(errorCode(res), 'user_id_required');
    }
  });
});

test('chatting with a user token works without sending user_id', async () => {
  await withApp({}, async (ctx) => {
    const { env, app } = ctx;
    const token = await mintToken(ctx, 'u1');
    const res = await app.inject({ method: 'POST', url: '/v1/chat', headers: auth(token), payload: { message: 'hello from the widget' } });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.match(body.reply, /Mock reply/);
    assert.ok(body.session_id);

    const list = await app.inject({ method: 'GET', url: '/v1/sessions?user_id=u1', headers: appAuth(env) });
    assert.deepEqual(
      list.json().sessions.map((s: { id: string }) => s.id),
      [body.session_id],
    );
  });
});

test('a user_id sent with a user token is ignored: the session belongs to the token\'s user', async () => {
  await withApp({}, async (ctx) => {
    const { env, app } = ctx;
    const token = await mintToken(ctx, 'u1');
    const res = await app.inject({ method: 'POST', url: '/v1/chat', headers: auth(token), payload: { message: 'who am i', user_id: 'u2' } });
    assert.equal(res.statusCode, 200, res.body);
    const sessionId = res.json().session_id as string;

    const u1 = await app.inject({ method: 'GET', url: '/v1/sessions?user_id=u1', headers: appAuth(env) });
    assert.deepEqual(
      u1.json().sessions.map((s: { id: string }) => s.id),
      [sessionId],
    );
    const u2 = await app.inject({ method: 'GET', url: '/v1/sessions?user_id=u2', headers: appAuth(env) });
    assert.deepEqual(u2.json().sessions, []);
    const owner = await env.db.get<{ user_id: string }>('SELECT user_id FROM sessions WHERE id = ?', [sessionId]);
    assert.equal(owner?.user_id, 'u1');

    // Reading with the token and a different user_id in the query still shows only u1's data.
    const u2Chat = await chatAs(ctx, 'u2', 'secret u2 chat');
    const mine = await app.inject({ method: 'GET', url: '/v1/sessions?user_id=u2', headers: auth(token) });
    assert.deepEqual(
      mine.json().sessions.map((s: { id: string }) => s.id),
      [sessionId],
    );
    const theirs = await app.inject({ method: 'GET', url: `/v1/sessions/${u2Chat.session_id}/messages?user_id=u2`, headers: auth(token) });
    assert.equal(theirs.statusCode, 404);
  });
});

test('a user token cannot call server-only routes such as /v1/settings or /v1/users/token', async () => {
  await withApp({}, async (ctx) => {
    const { env, app } = ctx;
    const token = await mintToken(ctx, 'u1');
    for (const [method, url, payload] of [
      ['GET', '/v1/settings', undefined],
      ['PUT', '/v1/settings', { agent_name: 'Hijacked', allowed_origins: ['https://evil.example'] }],
      ['POST', '/v1/users/token', { user_id: 'admin' }],
      ['GET', '/v1/status', undefined],
      ['POST', '/v1/app-key/rotate', {}],
      ['PUT', '/v1/connectors/loginlens', { url: 'https://evil.example/hook' }],
      ['GET', '/v1/users/u1/export', undefined],
      ['DELETE', '/v1/users/u1', undefined],
      ['GET', '/v1/tools', undefined],
    ] as const) {
      const res = await app.inject({ method, url, headers: auth(token), payload });
      assert.equal(res.statusCode, 403, `${method} ${url}`);
      assert.equal(errorCode(res), 'forbidden');
    }
    const settings = await app.inject({ method: 'GET', url: '/v1/settings', headers: appAuth(env) });
    assert.equal(settings.json().agent_name, 'Scout');
    assert.deepEqual(settings.json().allowed_origins, []);
  });
});

test('garbage, tampered, expired and foreign user tokens get 401', async () => {
  await withApp({}, async (ctx) => {
    const { env, app } = ctx;
    const good = await mintToken(ctx, 'u1');
    const [payload, sig] = good.slice('sct_ut_'.length).split('.') as [string, string];
    const forged = Buffer.from(JSON.stringify({ p: env.project.id, u: 'u2', exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url');
    const expired = mintUserToken(env.secrets, env.project.id, 'u1', 60, Date.now() - 3600_000).token;
    const foreign = mintUserToken(new Secrets('a-completely-different-master-secret-0987654321'), env.project.id, 'u1', 600).token;
    const flipped = `sct_ut_${payload}.${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`;

    for (const token of ['sct_ut_garbage', 'sct_ut_garbage.garbage', `sct_ut_${forged}.${sig}`, flipped, expired, foreign]) {
      const res = await app.inject({ method: 'POST', url: '/v1/chat', headers: auth(token), payload: { message: 'hello' } });
      assert.equal(res.statusCode, 401, `token ${token.slice(0, 30)}...`);
      assert.equal(errorCode(res), 'unauthorized');
    }
    const ok = await app.inject({ method: 'POST', url: '/v1/chat', headers: auth(good), payload: { message: 'hello' } });
    assert.equal(ok.statusCode, 200);
  });
});

// =====================================================================
// Chat
// =====================================================================

test('POST /v1/chat with an app key requires a valid user_id', async () => {
  await withApp({}, async ({ env, app }) => {
    for (const payload of [{ message: 'hi' }, { message: 'hi', user_id: '' }, { message: 'hi', user_id: 'not ok' }, { message: 'hi', user_id: 12 }]) {
      const res = await app.inject({ method: 'POST', url: '/v1/chat', headers: appAuth(env), payload });
      assert.equal(res.statusCode, 400, JSON.stringify(payload));
      assert.equal(errorCode(res), 'user_id_required');
    }
    assert.equal(await count(env, 'SELECT COUNT(*) AS n FROM sessions WHERE project_id = ?', [env.project.id]), 0);
  });
});

test('POST /v1/chat rejects a message that is too long or empty with 400', async () => {
  await withApp({}, async ({ env, app }) => {
    const long = await app.inject({ method: 'POST', url: '/v1/chat', headers: appAuth(env), payload: { user_id: 'u1', message: 'a'.repeat(env.config.maxMessageChars + 1) } });
    assert.equal(long.statusCode, 400);
    assert.equal(errorCode(long), 'message_too_long');

    const exact = await app.inject({ method: 'POST', url: '/v1/chat', headers: appAuth(env), payload: { user_id: 'u1', message: 'a'.repeat(env.config.maxMessageChars) } });
    assert.equal(exact.statusCode, 200, 'a message of exactly the maximum length is fine');

    for (const message of ['', '   ', undefined]) {
      const res = await app.inject({ method: 'POST', url: '/v1/chat', headers: appAuth(env), payload: { user_id: 'u1', message } });
      assert.equal(res.statusCode, 400);
      assert.equal(errorCode(res), 'empty_message');
    }
  });
});

test('POST /v1/chat replies with the mock AI and stores the conversation', async () => {
  await withApp({}, async (ctx) => {
    const { env, app } = ctx;
    const r = await chatAs(ctx, 'u1', 'hello there');
    assert.match(r.reply, /Mock reply/);
    assert.match(r.reply, /hello there/);
    assert.ok(r.session_id && r.message_id);
    assert.deepEqual(r.pending_actions, []);

    const msgs = await app.inject({ method: 'GET', url: `/v1/sessions/${r.session_id}/messages?user_id=u1`, headers: appAuth(env) });
    assert.equal(msgs.statusCode, 200);
    const list = msgs.json().messages as Array<{ id: string; role: string; text: string }>;
    assert.deepEqual(
      list.map((m) => m.role),
      ['user', 'assistant'],
    );
    assert.equal(list[0]!.text, 'hello there');
    assert.equal(list[1]!.id, r.message_id);

    // Continuing the same session adds to it.
    const next = await chatAs(ctx, 'u1', 'second message', { session_id: r.session_id });
    assert.equal(next.session_id, r.session_id);
  });
});

test('POST /v1/chat/stream sends start, delta and done events as text/event-stream', async () => {
  await withApp({}, async ({ env, app }) => {
    const res = await app.inject({ method: 'POST', url: '/v1/chat/stream', headers: appAuth(env), payload: { user_id: 'u1', message: 'hello stream' } });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type']), /^text\/event-stream/);
    assert.match(String(res.headers['cache-control']), /no-cache/);

    const events = parseSseBody(res.body);
    const names = events.map((e) => e.event);
    assert.equal(names[0], 'start');
    assert.equal(names[names.length - 1], 'done');
    assert.ok(names.includes('delta'), `expected delta events, got ${names.join(',')}`);
    assert.ok(!names.includes('error'));

    const start = events[0]!.data as { session_id: string; language: string };
    const done = events[events.length - 1]!.data as { session_id: string; reply: string; message_id: string };
    assert.ok(start.session_id);
    assert.equal(done.session_id, start.session_id);
    assert.match(done.reply, /hello stream/);
    const streamed = events.filter((e) => e.event === 'delta').map((e) => (e.data as { text: string }).text).join('');
    assert.equal(streamed, done.reply, 'the deltas add up to the final reply');

    const owner = await env.db.get<{ user_id: string }>('SELECT user_id FROM sessions WHERE id = ?', [done.session_id]);
    assert.equal(owner?.user_id, 'u1');
  });
});

test('POST /v1/chat/stream works with a user token and rejects bad input before streaming', async () => {
  await withApp({}, async (ctx) => {
    const { env, app } = ctx;
    const token = await mintToken(ctx, 'u1');
    const ok = await app.inject({ method: 'POST', url: '/v1/chat/stream', headers: auth(token), payload: { message: 'hi' } });
    assert.equal(ok.statusCode, 200);
    assert.equal(parseSseBody(ok.body).at(-1)!.event, 'done');

    const empty = await app.inject({ method: 'POST', url: '/v1/chat/stream', headers: auth(token), payload: { message: '  ' } });
    assert.equal(empty.statusCode, 400);
    assert.equal(errorCode(empty), 'empty_message');

    const noUser = await app.inject({ method: 'POST', url: '/v1/chat/stream', headers: appAuth(env), payload: { message: 'hi' } });
    assert.equal(noUser.statusCode, 400);
    assert.equal(errorCode(noUser), 'user_id_required');

    const noAuth = await app.inject({ method: 'POST', url: '/v1/chat/stream', payload: { message: 'hi' } });
    assert.equal(noAuth.statusCode, 401);

    // A message that is too long is reported as an error event on the stream.
    const long = await app.inject({ method: 'POST', url: '/v1/chat/stream', headers: auth(token), payload: { message: 'a'.repeat(env.config.maxMessageChars + 1) } });
    const events = parseSseBody(long.body);
    assert.equal(events.at(-1)!.event, 'error');
    assert.equal((events.at(-1)!.data as { code: string }).code, 'message_too_long');
  });
});

test('with USER_MESSAGES_PER_MINUTE=2 the third message from a user gets 429 with retry-after', async () => {
  await withApp({ env: { USER_MESSAGES_PER_MINUTE: '2' } }, async (ctx) => {
    const { env, app } = ctx;
    await chatAs(ctx, 'u1', 'one');
    await chatAs(ctx, 'u1', 'two');
    const third = await app.inject({ method: 'POST', url: '/v1/chat', headers: appAuth(env), payload: { user_id: 'u1', message: 'three' } });
    assert.equal(third.statusCode, 429);
    assert.equal(errorCode(third), 'rate_limited');
    const retryAfter = Number(third.headers['retry-after']);
    assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 120, `retry-after ${third.headers['retry-after']}`);

    // The stream endpoint shares the same per-user limit.
    const stream = await app.inject({ method: 'POST', url: '/v1/chat/stream', headers: appAuth(env), payload: { user_id: 'u1', message: 'four' } });
    assert.equal(stream.statusCode, 429);

    // Other users are not affected.
    await chatAs(ctx, 'u2', 'hello');
  });
});

// =====================================================================
// Confirmed actions
// =====================================================================

test('a write tool waits for Confirm: confirming saves the note once, a second confirm is 409', async () => {
  await withApp({}, async (ctx) => {
    const { env, app } = ctx;
    await enableTools(ctx, ['remember_note']);
    const r = await chatAs(ctx, 'u1', 'remember that I prefer Hindi');
    assert.equal(r.pending_actions.length, 1, JSON.stringify(r));
    const action = r.pending_actions[0]!;
    assert.equal(action.tool, 'remember_note');
    assert.match(action.summary, /I prefer Hindi/);
    // Nothing is saved before the user confirms.
    assert.equal(await count(env, 'SELECT COUNT(*) AS n FROM user_notes WHERE user_id = ?', ['u1']), 0);

    // Another user cannot see or confirm this action.
    const other = await app.inject({ method: 'POST', url: `/v1/actions/${action.id}/confirm`, headers: appAuth(env), payload: { user_id: 'u2' } });
    assert.equal(other.statusCode, 404);
    assert.equal(errorCode(other), 'not_found');
    const otherToken = await mintToken(ctx, 'u2');
    const otherViaToken = await app.inject({ method: 'POST', url: `/v1/actions/${action.id}/cancel`, headers: auth(otherToken), payload: {} });
    assert.equal(otherViaToken.statusCode, 404);
    assert.equal(await count(env, 'SELECT COUNT(*) AS n FROM user_notes', []), 0);

    const confirm = await app.inject({ method: 'POST', url: `/v1/actions/${action.id}/confirm`, headers: appAuth(env), payload: { user_id: 'u1' } });
    assert.equal(confirm.statusCode, 200, confirm.body);
    const body = confirm.json();
    assert.equal(body.ok, true);
    assert.equal(body.status, 'confirmed');
    assert.equal(body.result.saved, true);

    const notes = await env.db.all<{ text: string; user_id: string; project_id: string }>('SELECT text, user_id, project_id FROM user_notes', []);
    assert.deepEqual(notes, [{ text: 'I prefer Hindi', user_id: 'u1', project_id: env.project.id }]);

    const second = await app.inject({ method: 'POST', url: `/v1/actions/${action.id}/confirm`, headers: appAuth(env), payload: { user_id: 'u1' } });
    assert.equal(second.statusCode, 409);
    assert.equal(errorCode(second), 'already_done');
    assert.equal(await count(env, 'SELECT COUNT(*) AS n FROM user_notes', []), 1, 'the note is saved only once');

    // The confirmation is added to the conversation.
    const msgs = await app.inject({ method: 'GET', url: `/v1/sessions/${r.session_id}/messages?user_id=u1`, headers: appAuth(env) });
    assert.equal(msgs.json().messages.at(-1).role, 'assistant');
  });
});

test('cancelling a pending action saves nothing and it cannot be confirmed afterwards', async () => {
  await withApp({}, async (ctx) => {
    const { env, app } = ctx;
    await enableTools(ctx, ['remember_note']);
    const token = await mintToken(ctx, 'u1');
    const res = await app.inject({ method: 'POST', url: '/v1/chat', headers: auth(token), payload: { message: 'remember that I like tea' } });
    assert.equal(res.statusCode, 200, res.body);
    const action = res.json().pending_actions[0] as { id: string };
    assert.ok(action);

    const cancel = await app.inject({ method: 'POST', url: `/v1/actions/${action.id}/cancel`, headers: auth(token), payload: {} });
    assert.equal(cancel.statusCode, 200, cancel.body);
    assert.equal(cancel.json().ok, true);
    assert.equal(cancel.json().status, 'cancelled');
    assert.equal(cancel.json().result, undefined);

    const confirm = await app.inject({ method: 'POST', url: `/v1/actions/${action.id}/confirm`, headers: auth(token), payload: {} });
    assert.equal(confirm.statusCode, 409);
    assert.equal(await count(env, 'SELECT COUNT(*) AS n FROM user_notes', []), 0);
    const row = await env.db.get<{ status: string }>('SELECT status FROM pending_actions WHERE id = ?', [action.id]);
    assert.equal(row?.status, 'cancelled');
  });
});

test('actions: an unknown decision or an unknown action id is 404', async () => {
  await withApp({}, async (ctx) => {
    const { env, app } = ctx;
    await enableTools(ctx, ['remember_note']);
    const r = await chatAs(ctx, 'u1', 'remember that I prefer Hindi');
    const id = r.pending_actions[0]!.id;
    const approve = await app.inject({ method: 'POST', url: `/v1/actions/${id}/approve`, headers: appAuth(env), payload: { user_id: 'u1' } });
    assert.equal(approve.statusCode, 404);
    const unknown = await app.inject({ method: 'POST', url: '/v1/actions/act_doesnotexist/confirm', headers: appAuth(env), payload: { user_id: 'u1' } });
    assert.equal(unknown.statusCode, 404);
    assert.equal(await count(env, 'SELECT COUNT(*) AS n FROM user_notes', []), 0);
  });
});

test('write tools are off by default: without enabled_tools no action is offered', async () => {
  await withApp({}, async (ctx) => {
    const { env } = ctx;
    const r = await chatAs(ctx, 'u1', 'remember that I prefer Hindi');
    assert.deepEqual(r.pending_actions, []);
    assert.equal(await count(env, 'SELECT COUNT(*) AS n FROM pending_actions', []), 0);
  });
});

// =====================================================================
// Sessions and feedback
// =====================================================================

test('GET /v1/sessions lists only the caller\'s own sessions', async () => {
  await withApp({}, async (ctx) => {
    const { env, app } = ctx;
    const a = await chatAs(ctx, 'u1', 'first chat');
    const b = await chatAs(ctx, 'u1', 'second chat');
    const c = await chatAs(ctx, 'u2', 'someone else');

    const u1 = await app.inject({ method: 'GET', url: '/v1/sessions?user_id=u1', headers: appAuth(env) });
    assert.equal(u1.statusCode, 200);
    const ids = (u1.json().sessions as Array<{ id: string; title: string }>).map((s) => s.id).sort();
    assert.deepEqual(ids, [a.session_id, b.session_id].sort());
    assert.ok(!ids.includes(c.session_id));

    const u2 = await app.inject({ method: 'GET', url: '/v1/sessions?user_id=u2', headers: appAuth(env) });
    assert.deepEqual(
      u2.json().sessions.map((s: { id: string }) => s.id),
      [c.session_id],
    );

    const nobody = await app.inject({ method: 'GET', url: '/v1/sessions?user_id=u3', headers: appAuth(env) });
    assert.deepEqual(nobody.json().sessions, []);

    const missing = await app.inject({ method: 'GET', url: '/v1/sessions', headers: appAuth(env) });
    assert.equal(missing.statusCode, 400);
  });
});

test('another user cannot read, continue or delete someone\'s session (404)', async () => {
  await withApp({}, async (ctx) => {
    const { env, app } = ctx;
    const mine = await chatAs(ctx, 'u1', 'private conversation');

    const read = await app.inject({ method: 'GET', url: `/v1/sessions/${mine.session_id}/messages?user_id=u2`, headers: appAuth(env) });
    assert.equal(read.statusCode, 404);
    assert.equal(errorCode(read), 'session_not_found');
    assert.ok(!read.body.includes('private conversation'));

    const cont = await app.inject({ method: 'POST', url: '/v1/chat', headers: appAuth(env), payload: { user_id: 'u2', message: 'hi', session_id: mine.session_id } });
    assert.equal(cont.statusCode, 404);
    assert.equal(errorCode(cont), 'session_not_found');

    const del = await app.inject({ method: 'DELETE', url: `/v1/sessions/${mine.session_id}?user_id=u2`, headers: appAuth(env) });
    assert.equal(del.statusCode, 404);

    const still = await app.inject({ method: 'GET', url: `/v1/sessions/${mine.session_id}/messages?user_id=u1`, headers: appAuth(env) });
    assert.equal(still.statusCode, 200);
    assert.equal(still.json().messages.length, 2);
  });
});

test('DELETE /v1/sessions/<id> removes the session and its messages', async () => {
  await withApp({}, async (ctx) => {
    const { env, app } = ctx;
    const keep = await chatAs(ctx, 'u1', 'keep me');
    const gone = await chatAs(ctx, 'u1', 'delete me');

    const del = await app.inject({ method: 'DELETE', url: `/v1/sessions/${gone.session_id}?user_id=u1`, headers: appAuth(env) });
    assert.equal(del.statusCode, 200, del.body);
    assert.deepEqual(del.json(), { deleted: true });

    const read = await app.inject({ method: 'GET', url: `/v1/sessions/${gone.session_id}/messages?user_id=u1`, headers: appAuth(env) });
    assert.equal(read.statusCode, 404);
    assert.equal(await count(env, 'SELECT COUNT(*) AS n FROM messages WHERE session_id = ?', [gone.session_id]), 0);

    const list = await app.inject({ method: 'GET', url: '/v1/sessions?user_id=u1', headers: appAuth(env) });
    assert.deepEqual(
      list.json().sessions.map((s: { id: string }) => s.id),
      [keep.session_id],
    );

    const again = await app.inject({ method: 'DELETE', url: `/v1/sessions/${gone.session_id}?user_id=u1`, headers: appAuth(env) });
    assert.equal(again.statusCode, 404);
  });
});

test('feedback on an assistant message is saved; another user\'s message is 404', async () => {
  await withApp({}, async (ctx) => {
    const { env, app } = ctx;
    const r = await chatAs(ctx, 'u1', 'rate me');
    const up = await app.inject({ method: 'POST', url: `/v1/messages/${r.message_id}/feedback`, headers: appAuth(env), payload: { user_id: 'u1', value: 1 } });
    assert.equal(up.statusCode, 200, up.body);
    assert.deepEqual(up.json(), { ok: true });

    const msgs = await app.inject({ method: 'GET', url: `/v1/sessions/${r.session_id}/messages?user_id=u1`, headers: appAuth(env) });
    const list = msgs.json().messages as Array<{ id: string; role: string; feedback: number | null }>;
    assert.equal(list.find((m) => m.id === r.message_id)?.feedback, 1);

    const other = await app.inject({ method: 'POST', url: `/v1/messages/${r.message_id}/feedback`, headers: appAuth(env), payload: { user_id: 'u2', value: -1 } });
    assert.equal(other.statusCode, 404);
    assert.equal(errorCode(other), 'message_not_found');
    const row = await env.db.get<{ feedback: number | null }>('SELECT feedback FROM messages WHERE id = ?', [r.message_id]);
    assert.equal(Number(row?.feedback), 1, 'the other user did not change the feedback');

    // Feedback is only for assistant messages.
    const userMsg = list.find((m) => m.role === 'user')!;
    const onUser = await app.inject({ method: 'POST', url: `/v1/messages/${userMsg.id}/feedback`, headers: appAuth(env), payload: { user_id: 'u1', value: 1 } });
    assert.equal(onUser.statusCode, 404);

    const bad = await app.inject({ method: 'POST', url: `/v1/messages/${r.message_id}/feedback`, headers: appAuth(env), payload: { user_id: 'u1', value: 5 } });
    assert.equal(bad.statusCode, 400);
    assert.equal(errorCode(bad), 'bad_value');

    const clear = await app.inject({ method: 'POST', url: `/v1/messages/${r.message_id}/feedback`, headers: appAuth(env), payload: { user_id: 'u1', value: null } });
    assert.equal(clear.statusCode, 200);
    const cleared = await env.db.get<{ feedback: number | null }>('SELECT feedback FROM messages WHERE id = ?', [r.message_id]);
    assert.equal(cleared?.feedback, null);
  });
});

// =====================================================================
// Data rights: export and delete
// =====================================================================

test('GET /v1/users/u1/export contains the user\'s chats and notes, and nothing from other users', async () => {
  await withApp({}, async (ctx) => {
    const { env, app } = ctx;
    await enableTools(ctx, ['remember_note']);
    const chat = await chatAs(ctx, 'u1', 'hello export please');
    const note = await chatAs(ctx, 'u1', 'remember that I prefer Hindi');
    const confirm = await app.inject({ method: 'POST', url: `/v1/actions/${note.pending_actions[0]!.id}/confirm`, headers: appAuth(env), payload: { user_id: 'u1' } });
    assert.equal(confirm.statusCode, 200, confirm.body);
    await chatAs(ctx, 'u2', 'u2 secret message');

    const res = await app.inject({ method: 'GET', url: '/v1/users/u1/export', headers: appAuth(env) });
    assert.equal(res.statusCode, 200, res.body);
    const data = res.json() as {
      user_id: string;
      sessions: Array<{ id: string; messages: Array<{ role: string; text: string }> }>;
      notes: Array<{ text: string }>;
      actions: Array<{ tool_name: string; status: string }>;
    };
    assert.equal(data.user_id, 'u1');
    const ids = data.sessions.map((s) => s.id).sort();
    assert.deepEqual(ids, [chat.session_id, note.session_id].sort());
    const texts = data.sessions.flatMap((s) => s.messages.map((m) => m.text));
    assert.ok(texts.includes('hello export please'));
    assert.ok(texts.some((t) => /Mock reply/.test(t)));
    assert.deepEqual(
      data.notes.map((n) => n.text),
      ['I prefer Hindi'],
    );
    assert.deepEqual(
      data.actions.map((a) => [a.tool_name, a.status]),
      [['remember_note', 'confirmed']],
    );
    assert.ok(!res.body.includes('u2 secret message'));

    const bad = await app.inject({ method: 'GET', url: '/v1/users/bad%20id/export', headers: appAuth(env) });
    assert.equal(bad.statusCode, 400);
  });
});

test('DELETE /v1/users/u1 removes that user\'s sessions, messages, notes and actions only', async () => {
  await withApp({}, async (ctx) => {
    const { env, app } = ctx;
    await enableTools(ctx, ['remember_note']);
    const s1 = await chatAs(ctx, 'u1', 'hello');
    const note = await chatAs(ctx, 'u1', 'remember that I prefer Hindi');
    await app.inject({ method: 'POST', url: `/v1/actions/${note.pending_actions[0]!.id}/confirm`, headers: appAuth(env), payload: { user_id: 'u1' } });
    const other = await chatAs(ctx, 'u2', 'remember that I like tea');

    const res = await app.inject({ method: 'DELETE', url: '/v1/users/u1', headers: appAuth(env) });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json().deleted, { sessions: 2, notes: 1, actions: 1 });

    assert.equal(await count(env, 'SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', ['u1']), 0);
    assert.equal(await count(env, 'SELECT COUNT(*) AS n FROM messages WHERE session_id IN (?, ?)', [s1.session_id, note.session_id]), 0);
    assert.equal(await count(env, 'SELECT COUNT(*) AS n FROM user_notes WHERE user_id = ?', ['u1']), 0);
    assert.equal(await count(env, 'SELECT COUNT(*) AS n FROM pending_actions WHERE user_id = ?', ['u1']), 0);

    const exported = await app.inject({ method: 'GET', url: '/v1/users/u1/export', headers: appAuth(env) });
    assert.deepEqual(exported.json().sessions, []);
    assert.deepEqual(exported.json().notes, []);

    // u2 keeps everything.
    assert.equal(await count(env, 'SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', ['u2']), 1);
    assert.ok((await count(env, 'SELECT COUNT(*) AS n FROM messages WHERE session_id = ?', [other.session_id])) > 0);
    assert.equal(await count(env, 'SELECT COUNT(*) AS n FROM pending_actions WHERE user_id = ?', ['u2']), 1);
  });
});

// =====================================================================
// Status and the LoginLens connector
// =====================================================================

test('GET /v1/status shows the setup warnings and never the app key itself', async () => {
  await withApp({}, async ({ env, app }) => {
    const res = await app.inject({ method: 'GET', url: '/v1/status', headers: appAuth(env) });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    const codes = (body.warnings as Array<{ code: string }>).map((w) => w.code);
    for (const code of ['loginlens_not_connected', 'no_allowed_origins', 'mock_ai']) assert.ok(codes.includes(code), `missing warning ${code}: ${codes.join(',')}`);
    assert.ok(!res.body.includes(env.appKey), 'the status must never contain the app key');
    assert.ok(!res.body.includes(env.appKey.slice(8, 30)), 'nor a long piece of it');
    assert.equal(body.project.id, env.project.id);
    assert.equal(body.app_key.id, env.appKeyId);
    assert.equal(body.app_key.status, 'active');
    assert.equal(body.loginlens_connector, null);
    assert.equal(body.ai.provider, 'mock');
  });
});

test('PUT /v1/connectors/loginlens refuses private and plain-http addresses by default', async () => {
  await withApp({}, async ({ env, app }) => {
    for (const url of ['http://127.0.0.1:4000/scout', 'https://127.0.0.1/scout', 'https://localhost/scout', 'https://10.0.0.5/scout', 'https://169.254.169.254/latest', 'not a url']) {
      const res = await app.inject({ method: 'PUT', url: '/v1/connectors/loginlens', headers: appAuth(env), payload: { url } });
      assert.equal(res.statusCode, 400, `${url} -> ${res.body}`);
      assert.equal(errorCode(res), 'invalid_input');
    }
    const missing = await app.inject({ method: 'PUT', url: '/v1/connectors/loginlens', headers: appAuth(env), payload: {} });
    assert.equal(missing.statusCode, 400);
    assert.equal(errorCode(missing), 'url_required');
    assert.equal(await count(env, 'SELECT COUNT(*) AS n FROM connectors', []), 0);
  });
});

test('with CONNECTOR_ALLOW_PRIVATE_NETWORK=true a local LoginLens address is accepted and a signing secret is returned', async () => {
  await withApp({ env: { CONNECTOR_ALLOW_PRIVATE_NETWORK: 'true' } }, async ({ env, app }) => {
    const url = 'http://127.0.0.1:4000/scout';
    const res = await app.inject({ method: 'PUT', url: '/v1/connectors/loginlens', headers: appAuth(env), payload: { url } });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { url: string; signing_secret: string };
    assert.equal(body.url, url);
    assert.match(body.signing_secret, /^whsec_[A-Za-z0-9]{20,}$/);

    // The signing secret is stored only in encrypted form.
    const row = await env.db.get<{ secret_enc: string }>('SELECT secret_enc FROM connectors WHERE project_id = ?', [env.project.id]);
    assert.ok(row && !row.secret_enc.includes(body.signing_secret));

    // Status now reports the connector, without the secret, and no longer warns about it.
    const put = await app.inject({ method: 'PUT', url: '/v1/settings', headers: appAuth(env), payload: { allowed_origins: [LOGINLENS] } });
    assert.equal(put.statusCode, 200);
    const status = await app.inject({ method: 'GET', url: '/v1/status', headers: appAuth(env) });
    const codes = (status.json().warnings as Array<{ code: string }>).map((w) => w.code);
    assert.ok(!codes.includes('loginlens_not_connected'));
    assert.ok(!codes.includes('no_allowed_origins'));
    assert.deepEqual(status.json().loginlens_connector, { url });
    assert.ok(!status.body.includes(body.signing_secret));
  });
});

// =====================================================================
// App key rotation
// =====================================================================

test('POST /v1/app-key/rotate returns a new working key; the old key keeps working during the grace period', async () => {
  await withApp({}, async ({ env, app }) => {
    const res = await app.inject({ method: 'POST', url: '/v1/app-key/rotate', headers: appAuth(env), payload: {} });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { app_key: string; key: { id: string; source: string; scopes: string[] }; old_key_valid_until: number };
    assert.match(body.app_key, /^sct_sec_[A-Za-z0-9]{20,80}$/);
    assert.notEqual(body.app_key, env.appKey);
    assert.equal(body.key.source, 'rotated');
    assert.ok(body.old_key_valid_until > Date.now() + 3000_000, 'the default grace period is about an hour');

    const fresh = await app.inject({ method: 'GET', url: '/v1/status', headers: auth(body.app_key) });
    assert.equal(fresh.statusCode, 200, fresh.body);
    assert.equal(fresh.json().app_key.id, body.key.id);

    const old = await app.inject({ method: 'GET', url: '/v1/status', headers: appAuth(env) });
    assert.equal(old.statusCode, 200, 'the old key still works during the grace period');

    // The new key can do everything the old one could.
    const chat = await app.inject({ method: 'POST', url: '/v1/chat', headers: auth(body.app_key), payload: { user_id: 'u1', message: 'hi' } });
    assert.equal(chat.statusCode, 200);
  });
});

test('POST /v1/app-key/rotate with grace_seconds 0 stops the old key at once', async () => {
  await withApp({}, async ({ env, app }) => {
    const res = await app.inject({ method: 'POST', url: '/v1/app-key/rotate', headers: appAuth(env), payload: { grace_seconds: 0 } });
    assert.equal(res.statusCode, 200, res.body);
    const newKey = res.json().app_key as string;

    const old = await app.inject({ method: 'GET', url: '/v1/status', headers: appAuth(env) });
    assert.equal(old.statusCode, 401);
    const oldRotate = await app.inject({ method: 'POST', url: '/v1/app-key/rotate', headers: appAuth(env), payload: { grace_seconds: 0 } });
    assert.equal(oldRotate.statusCode, 401, 'a stopped key cannot rotate again');

    const fresh = await app.inject({ method: 'GET', url: '/v1/status', headers: auth(newKey) });
    assert.equal(fresh.statusCode, 200);
  });
});

// =====================================================================
// Widget
// =====================================================================

test('GET /scout.js serves the widget JavaScript', async () => {
  await withApp({}, async ({ app }) => {
    const res = await app.inject({ method: 'GET', url: '/scout.js' });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type']), /^application\/javascript/);
    assert.equal(res.headers['access-control-allow-origin'], '*');
    assert.match(res.body, /__scoutLoaded/);
    assert.doesNotMatch(res.body, /sct_sec_[A-Za-z0-9]{20}/);
  });
});

test('GET /v1/widget/config works with a user token and shows only public settings', async () => {
  await withApp({}, async (ctx) => {
    const { env, app } = ctx;
    const put = await app.inject({
      method: 'PUT',
      url: '/v1/settings',
      headers: appAuth(env),
      payload: { agent_name: 'Lens Helper', welcome_text: 'Hi there!', instructions: 'internal-only instructions', primary_color: '#112233', quick_replies: ['Am I on Netflix?'] },
    });
    assert.equal(put.statusCode, 200, put.body);

    const token = await mintToken(ctx, 'u1');
    const res = await app.inject({ method: 'GET', url: '/v1/widget/config', headers: auth(token) });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.agent_name, 'Lens Helper');
    assert.equal(body.welcome_text, 'Hi there!');
    assert.equal(body.primary_color, '#112233');
    assert.deepEqual(body.quick_replies, ['Am I on Netflix?']);
    assert.equal(body.position, 'bottom-right');
    assert.deepEqual(body.ai, { state: 'ready' });
    assert.ok(!res.body.includes('internal-only instructions'), 'instructions are not shown to browsers');
    assert.equal(body.allowed_origins, undefined);

    const noAuth = await app.inject({ method: 'GET', url: '/v1/widget/config' });
    assert.equal(noAuth.statusCode, 401);
  });
});

// =====================================================================
// Extra limits, isolation and input edge cases
// =====================================================================

test('rotating with a non-numeric grace_seconds never leaves the old key valid forever', async () => {
  await withApp({}, async ({ env, app }) => {
    const res = await app.inject({ method: 'POST', url: '/v1/app-key/rotate', headers: appAuth(env), payload: { grace_seconds: 'soon' } });
    assert.ok(res.statusCode === 200 || res.statusCode === 400, `expected 200 (default grace) or 400 (rejected), got ${res.statusCode}: ${res.body}`);
    const old = await env.db.get<{ revoked_at: number | string | null }>('SELECT revoked_at FROM api_keys WHERE id = ?', [env.appKeyId]);
    if (res.statusCode === 200) {
      assert.notEqual(old?.revoked_at ?? null, null, 'a replaced key must get an end time, or it keeps working forever');
      assert.ok(Number.isFinite(Number(old?.revoked_at)));
      assert.equal(typeof res.json().old_key_valid_until, 'number');
    } else {
      assert.equal(old?.revoked_at ?? null, null);
      assert.equal(await count(env, 'SELECT COUNT(*) AS n FROM api_keys', []), 1, 'no new key is issued when the input is rejected');
    }
  });
});

test('GET /v1/sessions honours ?limit and never fails with a server error on an odd limit', async () => {
  await withApp({}, async (ctx) => {
    const { env, app } = ctx;
    await chatAs(ctx, 'u1', 'one');
    await chatAs(ctx, 'u1', 'two');
    const one = await app.inject({ method: 'GET', url: '/v1/sessions?user_id=u1&limit=1', headers: appAuth(env) });
    assert.equal(one.statusCode, 200);
    assert.equal(one.json().sessions.length, 1);

    for (const limit of ['-1', '0.5', '2.5', 'abc']) {
      const res = await app.inject({ method: 'GET', url: `/v1/sessions?user_id=u1&limit=${limit}`, headers: appAuth(env) });
      assert.ok(res.statusCode === 200 || res.statusCode === 400, `limit=${limit} gave ${res.statusCode}: ${res.body}`);
      if (res.statusCode === 200) assert.ok(res.json().sessions.length <= 100);
    }
  });
});

test('a pending action that has expired cannot be confirmed (409 expired)', async () => {
  await withApp({}, async (ctx) => {
    const { env, app } = ctx;
    await enableTools(ctx, ['remember_note']);
    const r = await chatAs(ctx, 'u1', 'remember that I prefer Hindi');
    const id = r.pending_actions[0]!.id;
    await env.db.run('UPDATE pending_actions SET expires_at = ? WHERE id = ?', [Date.now() - 1000, id]);
    const res = await app.inject({ method: 'POST', url: `/v1/actions/${id}/confirm`, headers: appAuth(env), payload: { user_id: 'u1' } });
    assert.equal(res.statusCode, 409);
    assert.equal(errorCode(res), 'expired');
    assert.equal(await count(env, 'SELECT COUNT(*) AS n FROM user_notes', []), 0);
  });
});

test('turning a tool off before Confirm stops the pending action from running (409 tool_unavailable)', async () => {
  await withApp({}, async (ctx) => {
    const { env, app } = ctx;
    await enableTools(ctx, ['remember_note']);
    const r = await chatAs(ctx, 'u1', 'remember that I prefer Hindi');
    await enableTools(ctx, []);
    const res = await app.inject({ method: 'POST', url: `/v1/actions/${r.pending_actions[0]!.id}/confirm`, headers: appAuth(env), payload: { user_id: 'u1' } });
    assert.equal(res.statusCode, 409);
    assert.equal(errorCode(res), 'tool_unavailable');
    assert.equal(await count(env, 'SELECT COUNT(*) AS n FROM user_notes', []), 0);
  });
});

test('apps are isolated: another project\'s key and tokens cannot see or act on this project\'s users', async () => {
  await withApp({}, async (ctx) => {
    const { env, app } = ctx;
    await enableTools(ctx, ['remember_note']);
    const r = await chatAs(ctx, 'u1', 'remember that I prefer Hindi');
    const actionId = r.pending_actions[0]!.id;

    const other = await createProject(env.db, 'Other app');
    const { plaintext: otherKey } = await createKey(env.db, { projectId: other.id, rateLimitPerMin: 1000 });
    const otherAuth = auth(otherKey);

    const list = await app.inject({ method: 'GET', url: '/v1/sessions?user_id=u1', headers: otherAuth });
    assert.deepEqual(list.json().sessions, []);
    const read = await app.inject({ method: 'GET', url: `/v1/sessions/${r.session_id}/messages?user_id=u1`, headers: otherAuth });
    assert.equal(read.statusCode, 404);
    const confirm = await app.inject({ method: 'POST', url: `/v1/actions/${actionId}/confirm`, headers: otherAuth, payload: { user_id: 'u1' } });
    assert.equal(confirm.statusCode, 404);
    const feedback = await app.inject({ method: 'POST', url: `/v1/messages/${r.message_id}/feedback`, headers: otherAuth, payload: { user_id: 'u1', value: -1 } });
    assert.equal(feedback.statusCode, 404);
    const exported = await app.inject({ method: 'GET', url: '/v1/users/u1/export', headers: otherAuth });
    assert.deepEqual(exported.json().sessions, []);
    const del = await app.inject({ method: 'DELETE', url: '/v1/users/u1', headers: otherAuth });
    assert.deepEqual(del.json().deleted, { sessions: 0, notes: 0, actions: 0 });

    const otherToken = mintUserToken(env.secrets, other.id, 'u1', 600).token;
    const viaToken = await app.inject({ method: 'GET', url: `/v1/sessions/${r.session_id}/messages`, headers: auth(otherToken) });
    assert.equal(viaToken.statusCode, 404);

    // Everything is still there for the real owner.
    assert.equal(await count(env, 'SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', ['u1']), 1);
    assert.equal(await count(env, "SELECT COUNT(*) AS n FROM pending_actions WHERE status = 'pending'", []), 1);
  });
});

test('user-token requests are limited per IP address (IP_REQUESTS_PER_MINUTE)', async () => {
  await withApp({ env: { IP_REQUESTS_PER_MINUTE: '3' } }, async (ctx) => {
    const { app } = ctx;
    const token = await mintToken(ctx, 'u1');
    const ip = { 'x-forwarded-for': '203.0.113.50' };
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ method: 'GET', url: '/v1/widget/config', headers: { ...ip, ...auth(token) } });
      assert.equal(res.statusCode, 200, `request ${i + 1}`);
    }
    const blocked = await app.inject({ method: 'GET', url: '/v1/widget/config', headers: { ...ip, ...auth(token) } });
    assert.equal(blocked.statusCode, 429);
    assert.ok(Number(blocked.headers['retry-after']) >= 1);
    const otherIp = await app.inject({ method: 'GET', url: '/v1/widget/config', headers: { 'x-forwarded-for': '203.0.113.51', ...auth(token) } });
    assert.equal(otherIp.statusCode, 200);
  });
});

test('each app key has its own per-minute request limit', async () => {
  await withApp({}, async ({ env, app }) => {
    const { plaintext } = await createKey(env.db, { projectId: env.project.id, rateLimitPerMin: 2 });
    for (let i = 0; i < 2; i++) assert.equal((await app.inject({ method: 'GET', url: '/v1/status', headers: auth(plaintext) })).statusCode, 200);
    const blocked = await app.inject({ method: 'GET', url: '/v1/status', headers: auth(plaintext) });
    assert.equal(blocked.statusCode, 429);
    assert.equal(errorCode(blocked), 'rate_limited');
    assert.ok(Number(blocked.headers['retry-after']) >= 1);
    // The main key is not affected.
    assert.equal((await app.inject({ method: 'GET', url: '/v1/status', headers: appAuth(env) })).statusCode, 200);
  });
});

test('the chat stream from an allowed origin carries the CORS and security headers', async () => {
  await withApp({}, async (ctx) => {
    const { env, app } = ctx;
    await app.inject({ method: 'PUT', url: '/v1/settings', headers: appAuth(env), payload: { allowed_origins: [LOGINLENS] } });
    const token = await mintToken(ctx, 'u1');
    const res = await app.inject({ method: 'POST', url: '/v1/chat/stream', headers: { ...auth(token), origin: LOGINLENS }, payload: { message: 'hi' } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['access-control-allow-origin'], LOGINLENS);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(parseSseBody(res.body).at(-1)!.event, 'done');
  });
});

test('an oversized body gets 413 and broken JSON gets 400, both as JSON errors', async () => {
  await withApp({}, async ({ env, app }) => {
    const big = await app.inject({ method: 'POST', url: '/v1/chat', headers: appAuth(env), payload: { user_id: 'u1', message: 'x'.repeat(70_000) } });
    assert.equal(big.statusCode, 413);
    assert.ok(errorCode(big));
    const broken = await app.inject({ method: 'POST', url: '/v1/chat', headers: { ...appAuth(env), 'content-type': 'application/json' }, payload: '{not json' });
    assert.equal(broken.statusCode, 400);
    assert.ok(errorCode(broken));
    assert.equal(await count(env, 'SELECT COUNT(*) AS n FROM sessions', []), 0);
  });
});

test('unknown addresses get a JSON 404', async () => {
  await withApp({}, async ({ app }) => {
    const res = await app.inject({ method: 'GET', url: '/v1/nope' });
    assert.equal(res.statusCode, 404);
    assert.equal(errorCode(res), 'not_found');
  });
});
