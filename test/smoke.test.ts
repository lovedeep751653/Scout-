import assert from 'node:assert/strict';
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
