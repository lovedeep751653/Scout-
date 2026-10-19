import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ChatQueue,
  QueueFullError,
  RateLimiter,
  checkUsageLimits,
  dayKey,
  getCounter,
  monthKey,
  recordUsage,
  userSubject,
} from '../src/keys/limits.ts';
import { createProject } from '../src/keys/projects.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { costMicroUsd, priceFor } from '../src/providers/pricing.ts';
import type { Usage } from '../src/providers/types.ts';
import { testApp, testEnv } from './helpers.ts';

// ---------- helpers ----------

const W = 60_000;
// A moment that sits exactly on a one-minute window boundary.
const T0 = W * 29_000_000;

// 2026-10-19 12:00:00 UTC
const NOON = Date.UTC(2026, 9, 19, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

interface Tracked<T> {
  state: 'pending' | 'resolved' | 'rejected';
  value?: T;
  error?: unknown;
}

function track<T>(p: Promise<T>): Tracked<T> {
  const t: Tracked<T> = { state: 'pending' };
  p.then(
    (v) => {
      t.state = 'resolved';
      t.value = v;
    },
    (e: unknown) => {
      t.state = 'rejected';
      t.error = e;
    },
  );
  return t;
}

// ---------- RateLimiter ----------

test('rate limiter allows requests up to the limit and then blocks with a positive retry-after', () => {
  const limiter = new RateLimiter(W);
  const now = T0 + 1_000;
  for (let i = 0; i < 3; i++) {
    const r = limiter.hit('user:a', 3, now);
    assert.equal(r.allowed, true, `hit ${i + 1} should be allowed`);
    assert.equal(r.retryAfterSec, 0);
  }
  const blocked = limiter.hit('user:a', 3, now);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSec > 0, 'a blocked hit must say how long to wait');
  assert.ok(Number.isInteger(blocked.retryAfterSec), 'retry-after is whole seconds');
  // Still blocked a moment later in the same window.
  assert.equal(limiter.hit('user:a', 3, now + 5_000).allowed, false);
});

test('rate limiter with a limit of zero blocks every request', () => {
  const limiter = new RateLimiter(W);
  const r = limiter.hit('x', 0, T0 + 10);
  assert.equal(r.allowed, false);
  assert.ok(r.retryAfterSec > 0);
});

test('a block in the last millisecond of a window still advises waiting at least one second', () => {
  const limiter = new RateLimiter(W);
  assert.equal(limiter.hit('x', 1, T0 + W - 1).allowed, true);
  const r = limiter.hit('x', 1, T0 + W - 1);
  assert.equal(r.allowed, false);
  assert.ok(r.retryAfterSec >= 1);
});

test('rate limiter counts separate ids independently', () => {
  const limiter = new RateLimiter(W);
  const now = T0 + 500;
  assert.equal(limiter.hit('user:p1:alice', 2, now).allowed, true);
  assert.equal(limiter.hit('user:p1:alice', 2, now).allowed, true);
  assert.equal(limiter.hit('user:p1:alice', 2, now).allowed, false);
  // Another id has its own budget, even when it looks similar.
  assert.equal(limiter.hit('user:p1:bob', 2, now).allowed, true);
  assert.equal(limiter.hit('user:p2:alice', 2, now).allowed, true);
  assert.equal(limiter.hit('user:p1:alice2', 2, now).allowed, true);
  assert.equal(limiter.hit('user:p1:bob', 2, now).allowed, true);
  assert.equal(limiter.hit('user:p1:bob', 2, now).allowed, false);
  // Alice is still blocked.
  assert.equal(limiter.hit('user:p1:alice', 2, now).allowed, false);
});

test('the sliding window gradually forgets the previous window', () => {
  const limiter = new RateLimiter(W);
  for (let i = 0; i < 4; i++) assert.equal(limiter.hit('id', 4, T0).allowed, true);
  assert.equal(limiter.hit('id', 4, T0 + 1).allowed, false);

  // Right at the start of the next window the old hits still count in full.
  assert.equal(limiter.hit('id', 4, T0 + W).allowed, false);

  // Half way through the next window, half of the previous 4 hits still count (2),
  // so exactly 2 more are allowed.
  const half = T0 + W + W / 2;
  assert.equal(limiter.hit('id', 4, half).allowed, true);
  assert.equal(limiter.hit('id', 4, half).allowed, true);
  assert.equal(limiter.hit('id', 4, half).allowed, false);
});

test('the rate limit fully recovers after two quiet windows', () => {
  const limiter = new RateLimiter(W);
  for (let i = 0; i < 3; i++) limiter.hit('id', 3, T0 + 100);
  assert.equal(limiter.hit('id', 3, T0 + 200).allowed, false);
  const later = T0 + 2 * W + 100;
  for (let i = 0; i < 3; i++) assert.equal(limiter.hit('id', 3, later).allowed, true, `hit ${i + 1} after recovery`);
  assert.equal(limiter.hit('id', 3, later).allowed, false);
});

test('blocked requests do not use up budget for later windows', () => {
  const limiter = new RateLimiter(W);
  assert.equal(limiter.hit('id', 2, T0).allowed, true);
  assert.equal(limiter.hit('id', 2, T0).allowed, true);
  for (let i = 0; i < 100; i++) assert.equal(limiter.hit('id', 2, T0 + 1_000 + i).allowed, false);
  // Half way through the next window only the 2 allowed hits count, weighted by 1/2 = 1.
  const half = T0 + W + W / 2;
  assert.equal(limiter.hit('id', 2, half).allowed, true);
  assert.equal(limiter.hit('id', 2, half).allowed, false);
});

test('a client that waits the advised retry-after is let through', () => {
  const limiter = new RateLimiter(W);
  const now = T0 + 10_000;
  for (let i = 0; i < 3; i++) assert.equal(limiter.hit('id', 3, now).allowed, true);
  const blocked = limiter.hit('id', 3, now);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSec > 0);
  // The server sends this value as the Retry-After header; honouring it should work.
  const retry = limiter.hit('id', 3, now + blocked.retryAfterSec * 1000);
  assert.equal(retry.allowed, true, `still blocked after waiting the advised ${blocked.retryAfterSec}s (next advice: ${retry.retryAfterSec}s)`);
});

// ---------- ChatQueue ----------

test('chat queue runs up to maxRunning chats at once and makes the next one wait', async () => {
  const q = new ChatQueue(2, 5);
  const a = await q.enter();
  const b = await q.enter();
  assert.equal(q.length, 0);
  const c = track(q.enter());
  await flush();
  assert.equal(c.state, 'pending', 'the third chat must wait for a free slot');
  assert.equal(q.length, 1);
  a();
  await flush();
  assert.equal(c.state, 'resolved');
  assert.equal(q.length, 0);
  b();
  c.value!();
  // Both slots are free again.
  const d = await q.enter();
  const e = await q.enter();
  d();
  e();
});

test('chat queue lets waiting chats in first come, first served and reports positions', async () => {
  const q = new ChatQueue(1, 5);
  const first = await q.enter();
  const order: string[] = [];
  const positions: Record<string, number> = {};
  const enter = (name: string) =>
    track(
      q
        .enter(undefined, (p) => {
          positions[name] = p;
        })
        .then((release) => {
          order.push(name);
          return release;
        }),
    );
  const two = enter('two');
  const three = enter('three');
  const four = enter('four');
  await flush();
  assert.deepEqual(positions, { two: 1, three: 2, four: 3 });
  assert.equal(q.length, 3);
  assert.deepEqual(order, []);

  first();
  await flush();
  assert.deepEqual(order, ['two']);
  assert.equal(three.state, 'pending');
  assert.equal(four.state, 'pending');

  two.value!();
  await flush();
  assert.deepEqual(order, ['two', 'three']);
  assert.equal(four.state, 'pending');

  three.value!();
  await flush();
  assert.deepEqual(order, ['two', 'three', 'four']);
  four.value!();
  assert.equal(q.length, 0);
});

test('chat queue throws QueueFullError when the line is full', async () => {
  const q = new ChatQueue(1, 2);
  const running = await q.enter();
  const w1 = track(q.enter());
  const w2 = track(q.enter());
  await flush();
  assert.equal(q.length, 2);
  await assert.rejects(q.enter(), (err: unknown) => err instanceof QueueFullError);
  assert.equal(q.length, 2, 'a rejected chat does not join the line');
  running();
  await flush();
  assert.equal(w1.state, 'resolved');
  assert.equal(w2.state, 'pending');
  // There is room in the line again.
  const w3 = track(q.enter());
  await flush();
  assert.equal(w3.state, 'pending');
  assert.equal(q.length, 2);
  w1.value!();
  await flush();
  w2.value!();
  await flush();
  w3.value!();
});

test('chat queue with no waiting room rejects as soon as all slots are busy', async () => {
  const q = new ChatQueue(1, 0);
  const running = await q.enter();
  await assert.rejects(q.enter(), QueueFullError);
  running();
  const next = await q.enter();
  next();
});

test('an aborted waiter leaves the line and the next waiter gets the slot', async () => {
  const q = new ChatQueue(1, 3);
  const running = await q.enter();
  const ctrl = new AbortController();
  const order: string[] = [];
  const aborted = track(q.enter(ctrl.signal).then((r) => (order.push('aborted'), r)));
  const next = track(q.enter().then((r) => (order.push('next'), r)));
  await flush();
  assert.equal(q.length, 2);

  ctrl.abort();
  await flush();
  assert.equal(aborted.state, 'rejected');
  assert.match((aborted.error as Error).message, /abort/);
  assert.equal(q.length, 1, 'the aborted waiter is removed from the line');

  running();
  await flush();
  assert.equal(next.state, 'resolved');
  assert.deepEqual(order, ['next']);
  next.value!();
  // Nothing is left holding a slot.
  const again = await q.enter();
  again();
  assert.equal(q.length, 0);
});

test('aborting a waiter frees its place so another chat can join a full line', async () => {
  const q = new ChatQueue(1, 1);
  const running = await q.enter();
  const ctrl = new AbortController();
  const waiting = track(q.enter(ctrl.signal));
  await flush();
  await assert.rejects(q.enter(), QueueFullError);
  ctrl.abort();
  await flush();
  assert.equal(waiting.state, 'rejected');
  const replacement = track(q.enter());
  await flush();
  assert.equal(replacement.state, 'pending');
  running();
  await flush();
  assert.equal(replacement.state, 'resolved');
  replacement.value!();
});

test('aborting after a waiter already got its slot changes nothing', async () => {
  const q = new ChatQueue(1, 2);
  const running = await q.enter();
  const ctrl = new AbortController();
  const w = track(q.enter(ctrl.signal));
  await flush();
  running();
  await flush();
  assert.equal(w.state, 'resolved');
  ctrl.abort();
  await flush();
  assert.equal(w.state, 'resolved');
  // The slot is still held by w: a new chat waits.
  const other = track(q.enter());
  await flush();
  assert.equal(other.state, 'pending');
  w.value!();
  await flush();
  assert.equal(other.state, 'resolved');
  other.value!();
});

test('a chat whose signal is already aborted does not take a place in the line', async () => {
  const q = new ChatQueue(1, 1);
  const running = await q.enter();
  const dead = track(q.enter(AbortSignal.abort()));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const deadState = dead.state;
  const lineLength = q.length;
  // Clean up whatever happened so nothing is left hanging.
  running();
  await flush();
  if (dead.state === 'resolved') dead.value!();
  assert.equal(deadState, 'rejected', 'an already-cancelled request should be turned away, not left waiting');
  assert.equal(lineLength, 0, 'an already-cancelled request must not fill the waiting line');
});

test('releasing the same slot twice is harmless', async () => {
  const q = new ChatQueue(1, 5);
  const a = await q.enter();
  a();
  a();
  // Only one slot exists: a second release must not have created an extra one.
  const b = await q.enter();
  const c = track(q.enter());
  await flush();
  assert.equal(c.state, 'pending', 'a double release must not let two chats run at once');
  b();
  await flush();
  assert.equal(c.state, 'resolved');
  c.value!();
});

test('releasing twice while others wait only lets one waiter in', async () => {
  const q = new ChatQueue(1, 5);
  const a = await q.enter();
  const b = track(q.enter());
  const c = track(q.enter());
  await flush();
  a();
  a();
  await flush();
  assert.equal(b.state, 'resolved');
  assert.equal(c.state, 'pending', 'the second release of the same slot must not hand out another slot');
  assert.equal(q.length, 1);
  b.value!();
  await flush();
  assert.equal(c.state, 'resolved');
  c.value!();
  c.value!();
  const d = await q.enter();
  const e = track(q.enter());
  await flush();
  assert.equal(e.state, 'pending');
  d();
  await flush();
  e.value!();
});

// ---------- period keys ----------

test('month and day keys use UTC calendar periods', () => {
  assert.equal(monthKey(NOON), '2026-10');
  assert.equal(dayKey(NOON), '2026-10-19');
  const lastMs = Date.UTC(2026, 9, 31, 23, 59, 59, 999);
  assert.equal(monthKey(lastMs), '2026-10');
  assert.equal(dayKey(lastMs), '2026-10-31');
  assert.equal(monthKey(lastMs + 1), '2026-11');
  assert.equal(dayKey(lastMs + 1), '2026-11-01');
});

// ---------- recordUsage ----------

test('recordUsage writes user day and month, key month and project month counters', async () => {
  const env = await testEnv();
  const pid = env.project.id;
  const subject = userSubject(pid, 'u1');
  await recordUsage(env.db, { projectId: pid, userSubject: subject, keyId: env.appKeyId }, { requests: 1, inputTokens: 120, outputTokens: 30, costMicroUsd: 7 }, NOON);

  const expected = { requests: 1, inputTokens: 120, outputTokens: 30, costMicroUsd: 7, alertSent: false };
  assert.deepEqual(await getCounter(env.db, subject, '2026-10'), expected);
  assert.deepEqual(await getCounter(env.db, subject, '2026-10-19'), expected);
  assert.deepEqual(await getCounter(env.db, `key:${env.appKeyId}`, '2026-10'), expected);
  assert.deepEqual(await getCounter(env.db, `project:${pid}`, '2026-10'), expected);

  const rows = await env.db.all<{ subject: string; period: string; project_id: string }>('SELECT subject, period, project_id FROM usage_counters ORDER BY subject, period');
  assert.deepEqual(
    rows.map((r) => `${r.subject}|${r.period}`).sort(),
    [`key:${env.appKeyId}|2026-10`, `project:${pid}|2026-10`, `${subject}|2026-10`, `${subject}|2026-10-19`].sort(),
    'exactly four counters: no key or project day counters',
  );
  for (const r of rows) assert.equal(r.project_id, pid);
  await env.db.close();
});

test('recordUsage adds up repeated usage instead of overwriting it', async () => {
  const env = await testEnv();
  const pid = env.project.id;
  const subject = userSubject(pid, 'u1');
  const who = { projectId: pid, userSubject: subject, keyId: env.appKeyId };
  await recordUsage(env.db, who, { requests: 1 }, NOON);
  await recordUsage(env.db, who, { inputTokens: 100, outputTokens: 40, costMicroUsd: 3 }, NOON);
  await recordUsage(env.db, who, { requests: 1, inputTokens: 50, outputTokens: 10, costMicroUsd: 2 }, NOON + 1_000);

  const expected = { requests: 2, inputTokens: 150, outputTokens: 50, costMicroUsd: 5, alertSent: false };
  assert.deepEqual(await getCounter(env.db, subject, '2026-10'), expected);
  assert.deepEqual(await getCounter(env.db, subject, '2026-10-19'), expected);
  assert.deepEqual(await getCounter(env.db, `key:${env.appKeyId}`, '2026-10'), expected);
  assert.deepEqual(await getCounter(env.db, `project:${pid}`, '2026-10'), expected);
  await env.db.close();
});

test('recordUsage without an app key skips the key counter', async () => {
  const env = await testEnv();
  const pid = env.project.id;
  const subject = userSubject(pid, 'widget-user');
  await recordUsage(env.db, { projectId: pid, userSubject: subject, keyId: null }, { requests: 1, inputTokens: 10, outputTokens: 5 }, NOON);
  const rows = await env.db.all<{ subject: string }>('SELECT subject FROM usage_counters');
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => !r.subject.startsWith('key:')), 'no key counter is written');
  assert.equal((await getCounter(env.db, `project:${pid}`, '2026-10')).requests, 1);
  assert.equal((await getCounter(env.db, subject, '2026-10-19')).inputTokens, 10);
  await env.db.close();
});

test('recordUsage keeps a separate day counter per day but sums the month', async () => {
  const env = await testEnv();
  const pid = env.project.id;
  const subject = userSubject(pid, 'u1');
  const who = { projectId: pid, userSubject: subject, keyId: env.appKeyId };
  await recordUsage(env.db, who, { requests: 2, inputTokens: 100 }, NOON);
  await recordUsage(env.db, who, { requests: 3, inputTokens: 50 }, NOON + DAY_MS);

  assert.equal((await getCounter(env.db, subject, '2026-10-19')).requests, 2);
  assert.equal((await getCounter(env.db, subject, '2026-10-20')).requests, 3);
  const month = await getCounter(env.db, subject, '2026-10');
  assert.equal(month.requests, 5);
  assert.equal(month.inputTokens, 150);
  assert.equal((await getCounter(env.db, `key:${env.appKeyId}`, '2026-10')).inputTokens, 150);
  await env.db.close();
});

test('recordUsage starts fresh counters in a new month', async () => {
  const env = await testEnv();
  const pid = env.project.id;
  const subject = userSubject(pid, 'u1');
  const who = { projectId: pid, userSubject: subject, keyId: env.appKeyId };
  const lastMs = Date.UTC(2026, 9, 31, 23, 59, 59, 999);
  await recordUsage(env.db, who, { requests: 1, inputTokens: 10 }, lastMs);
  await recordUsage(env.db, who, { requests: 1, inputTokens: 20 }, lastMs + 1);

  assert.equal((await getCounter(env.db, subject, '2026-10')).inputTokens, 10);
  assert.equal((await getCounter(env.db, subject, '2026-11')).inputTokens, 20);
  assert.equal((await getCounter(env.db, `key:${env.appKeyId}`, '2026-11')).inputTokens, 20);
  assert.equal((await getCounter(env.db, `project:${pid}`, '2026-10')).inputTokens, 10);
  assert.equal((await getCounter(env.db, `project:${pid}`, '2026-11')).inputTokens, 20);
  await env.db.close();
});

test('token counts beyond the 32-bit range are stored and read back as numbers', async () => {
  const env = await testEnv();
  const pid = env.project.id;
  const subject = userSubject(pid, 'heavy');
  const who = { projectId: pid, userSubject: subject, keyId: env.appKeyId };
  await recordUsage(env.db, who, { inputTokens: 3_000_000_000, outputTokens: 2_500_000_000, costMicroUsd: 4_000_000_000 }, NOON);
  await recordUsage(env.db, who, { inputTokens: 3_000_000_000, outputTokens: 1, costMicroUsd: 1 }, NOON);
  const c = await getCounter(env.db, `project:${pid}`, '2026-10');
  assert.equal(typeof c.inputTokens, 'number');
  assert.equal(c.inputTokens, 6_000_000_000);
  assert.equal(c.outputTokens, 2_500_000_001);
  assert.equal(c.costMicroUsd, 4_000_000_001);
  await env.db.close();
});

test('getCounter returns zeros for a subject with no usage', async () => {
  const env = await testEnv();
  assert.deepEqual(await getCounter(env.db, userSubject(env.project.id, 'nobody'), '2026-10'), {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    costMicroUsd: 0,
    alertSent: false,
  });
  await env.db.close();
});

// ---------- checkUsageLimits ----------

const LIMITS = { userMessagesPerDay: 3, userMonthlyTokens: 1_000 };

test('checkUsageLimits returns null while a user is below every limit', async () => {
  const env = await testEnv();
  const pid = env.project.id;
  const subject = userSubject(pid, 'u1');
  const who = { projectId: pid, userSubject: subject, keyId: env.appKeyId };
  const s = { userSubject: subject, keyId: env.appKeyId, keyBudget: 5_000 };
  assert.equal(await checkUsageLimits(env.db, s, LIMITS, NOON), null, 'no usage at all');
  await recordUsage(env.db, who, { requests: 2, inputTokens: 600, outputTokens: 399 }, NOON);
  assert.equal(await checkUsageLimits(env.db, s, LIMITS, NOON), null, '2 of 3 messages and 999 of 1000 tokens');
  await env.db.close();
});

test('checkUsageLimits reports daily_messages once the day limit is reached', async () => {
  const env = await testEnv();
  const pid = env.project.id;
  const subject = userSubject(pid, 'u1');
  const who = { projectId: pid, userSubject: subject, keyId: env.appKeyId };
  const s = { userSubject: subject, keyId: env.appKeyId, keyBudget: 0 };
  await recordUsage(env.db, who, { requests: 2 }, NOON);
  assert.equal(await checkUsageLimits(env.db, s, LIMITS, NOON), null);
  await recordUsage(env.db, who, { requests: 1 }, NOON);
  assert.equal(await checkUsageLimits(env.db, s, LIMITS, NOON), 'daily_messages');
  // The next day the user may chat again (same month).
  assert.equal(await checkUsageLimits(env.db, s, LIMITS, NOON + DAY_MS), null);
  await env.db.close();
});

test('checkUsageLimits reports monthly_tokens once input plus output tokens reach the limit', async () => {
  const env = await testEnv();
  const pid = env.project.id;
  const subject = userSubject(pid, 'u1');
  const who = { projectId: pid, userSubject: subject, keyId: env.appKeyId };
  const s = { userSubject: subject, keyId: env.appKeyId, keyBudget: 0 };
  await recordUsage(env.db, who, { inputTokens: 700, outputTokens: 299 }, NOON);
  assert.equal(await checkUsageLimits(env.db, s, LIMITS, NOON), null);
  await recordUsage(env.db, who, { outputTokens: 1 }, NOON);
  assert.equal(await checkUsageLimits(env.db, s, LIMITS, NOON), 'monthly_tokens');
  // Tokens used on an earlier day of the month still count.
  assert.equal(await checkUsageLimits(env.db, s, LIMITS, NOON + 5 * DAY_MS), 'monthly_tokens');
  // A new month starts over.
  assert.equal(await checkUsageLimits(env.db, s, LIMITS, Date.UTC(2026, 10, 1, 0, 0, 0)), null);
  await env.db.close();
});

test('a monthly token limit of zero means no monthly limit', async () => {
  const env = await testEnv();
  const pid = env.project.id;
  const subject = userSubject(pid, 'u1');
  await recordUsage(env.db, { projectId: pid, userSubject: subject, keyId: null }, { inputTokens: 10_000_000, outputTokens: 10_000_000 }, NOON);
  const r = await checkUsageLimits(env.db, { userSubject: subject, keyId: null, keyBudget: 0 }, { userMessagesPerDay: 3, userMonthlyTokens: 0 }, NOON);
  assert.equal(r, null);
  await env.db.close();
});

test('checkUsageLimits reports key_budget when all users of a key together reach its budget', async () => {
  const env = await testEnv();
  const pid = env.project.id;
  const keyId = env.appKeyId;
  const limits = { userMessagesPerDay: 100, userMonthlyTokens: 1_000_000 };
  await recordUsage(env.db, { projectId: pid, userSubject: userSubject(pid, 'a'), keyId }, { inputTokens: 200, outputTokens: 100 }, NOON);
  await recordUsage(env.db, { projectId: pid, userSubject: userSubject(pid, 'b'), keyId }, { inputTokens: 150, outputTokens: 49 }, NOON);
  const fresh = { userSubject: userSubject(pid, 'c'), keyId, keyBudget: 500 };
  assert.equal(await checkUsageLimits(env.db, fresh, limits, NOON), null, '499 of 500');
  await recordUsage(env.db, { projectId: pid, userSubject: userSubject(pid, 'b'), keyId }, { outputTokens: 1 }, NOON);
  assert.equal(await checkUsageLimits(env.db, fresh, limits, NOON), 'key_budget', 'a brand new user is blocked by the key budget');
  // A budget of zero means unlimited, and so does having no key.
  assert.equal(await checkUsageLimits(env.db, { ...fresh, keyBudget: 0 }, limits, NOON), null);
  assert.equal(await checkUsageLimits(env.db, { ...fresh, keyId: null }, limits, NOON), null);
  // Another key's usage is not counted against this one.
  assert.equal(await checkUsageLimits(env.db, { ...fresh, keyId: 'key_other' }, limits, NOON), null);
  // The key budget is monthly.
  assert.equal(await checkUsageLimits(env.db, fresh, limits, Date.UTC(2026, 10, 2)), null);
  await env.db.close();
});

test('the daily message limit is reported before the token limits', async () => {
  const env = await testEnv();
  const pid = env.project.id;
  const subject = userSubject(pid, 'u1');
  await recordUsage(env.db, { projectId: pid, userSubject: subject, keyId: env.appKeyId }, { requests: 3, inputTokens: 5_000, outputTokens: 5_000 }, NOON);
  const s = { userSubject: subject, keyId: env.appKeyId, keyBudget: 100 };
  assert.equal(await checkUsageLimits(env.db, s, LIMITS, NOON), 'daily_messages');
  // Next day the messages reset, so the monthly token limit is what blocks.
  assert.equal(await checkUsageLimits(env.db, s, LIMITS, NOON + DAY_MS), 'monthly_tokens');
  // Without a monthly user limit, the key budget is what blocks.
  assert.equal(await checkUsageLimits(env.db, s, { userMessagesPerDay: 3, userMonthlyTokens: 0 }, NOON + DAY_MS), 'key_budget');
  await env.db.close();
});

// ---------- userSubject ----------

test('userSubject includes the project id', () => {
  const a = userSubject('prj_a', 'u1');
  const b = userSubject('prj_b', 'u1');
  assert.ok(a.includes('prj_a') && a.includes('u1'));
  assert.notEqual(a, b);
  assert.notEqual(userSubject('prj_a', 'u1'), userSubject('prj_a', 'u2'));
  assert.ok(!a.startsWith('key:') && !a.startsWith('project:'), 'user counters cannot collide with key or project counters');
});

test('two projects with the same user id do not share usage counters', async () => {
  const env = await testEnv();
  const other = await createProject(env.db, 'Other app');
  assert.notEqual(other.id, env.project.id);
  const mine = userSubject(env.project.id, 'shared-user');
  const theirs = userSubject(other.id, 'shared-user');
  await recordUsage(env.db, { projectId: env.project.id, userSubject: mine, keyId: env.appKeyId }, { requests: 3, inputTokens: 2_000 }, NOON);

  assert.equal(await checkUsageLimits(env.db, { userSubject: mine, keyId: null, keyBudget: 0 }, LIMITS, NOON), 'daily_messages');
  assert.equal(await checkUsageLimits(env.db, { userSubject: theirs, keyId: null, keyBudget: 0 }, LIMITS, NOON), null);
  assert.equal((await getCounter(env.db, theirs, '2026-10')).requests, 0);
  assert.equal((await getCounter(env.db, theirs, '2026-10-19')).requests, 0);
  assert.equal((await getCounter(env.db, `project:${other.id}`, '2026-10')).requests, 0);
  assert.equal((await getCounter(env.db, `project:${env.project.id}`, '2026-10')).requests, 3);
  await env.db.close();
});

// ---------- pricing ----------

const haiku = () => {
  const p = priceFor('claude-haiku-5-5');
  assert.ok(p, 'claude-haiku-5-5 has a known price');
  return p;
};

test('costMicroUsd prices claude-haiku-5-5 at the standard rate below the 100K prompt tier', () => {
  // $0.10 per million input tokens, $0.50 per million output tokens.
  assert.equal(costMicroUsd({ inputTokens: 10_000, outputTokens: 2_000 }, haiku()), 2_000);
  assert.equal(costMicroUsd({ inputTokens: 50_000, outputTokens: 0 }, haiku()), 5_000);
  assert.equal(costMicroUsd({ inputTokens: 0, outputTokens: 1_000_000 }, haiku()), 500_000);
  // Exactly 100K prompt tokens is still the standard tier.
  assert.equal(costMicroUsd({ inputTokens: 100_000, outputTokens: 1_000 }, haiku()), 10_500);
  assert.equal(costMicroUsd({ inputTokens: 0, outputTokens: 0 }, haiku()), 0);
});

test('costMicroUsd bills the whole claude-haiku-5-5 request at the long rate above 100K prompt tokens', () => {
  // $0.50 input and $2.50 output per million once the prompt is over 100K.
  assert.equal(costMicroUsd({ inputTokens: 200_000, outputTokens: 1_000 }, haiku()), 102_500);
  assert.equal(costMicroUsd({ inputTokens: 100_001, outputTokens: 0 }, haiku()), Math.round(100_001 * 0.5));
  assert.ok(
    costMicroUsd({ inputTokens: 100_001, outputTokens: 1_000 }, haiku()) > 4 * costMicroUsd({ inputTokens: 100_000, outputTokens: 1_000 }, haiku()),
    'crossing the tier raises the price of every token',
  );
});

test('costMicroUsd charges claude-haiku-5-5 cache reads at 0.1x and cache writes at 1.25x', () => {
  // 10K prompt = 2K plain + 6K read from cache + 2K written to cache; 1K output.
  const usage: Usage = { inputTokens: 10_000, outputTokens: 1_000, cachedInputTokens: 6_000, cacheWriteTokens: 2_000 };
  // 2000*0.1 + 6000*0.1*0.1 + 2000*0.1*1.25 + 1000*0.5 = 200 + 60 + 250 + 500
  assert.equal(costMicroUsd(usage, haiku()), 1_010);
  // Reading from cache is cheaper than sending the same prompt uncached.
  assert.ok(costMicroUsd({ inputTokens: 10_000, outputTokens: 0, cachedInputTokens: 10_000 }, haiku()) < costMicroUsd({ inputTokens: 10_000, outputTokens: 0 }, haiku()));
  assert.equal(costMicroUsd({ inputTokens: 10_000, outputTokens: 0, cachedInputTokens: 10_000 }, haiku()), 100);
  assert.equal(costMicroUsd({ inputTokens: 10_000, outputTokens: 0, cacheWriteTokens: 10_000 }, haiku()), 1_250);
});

test('cached tokens count toward the claude-haiku-5-5 long prompt tier', () => {
  // 150K prompt = 30K plain + 100K cache read + 20K cache write; 2K output; long rates apply.
  const usage: Usage = { inputTokens: 150_000, outputTokens: 2_000, cachedInputTokens: 100_000, cacheWriteTokens: 20_000 };
  // 30000*0.5 + 100000*0.5*0.1 + 20000*0.5*1.25 + 2000*2.5 = 15000 + 5000 + 12500 + 5000
  assert.equal(costMicroUsd(usage, haiku()), 37_500);
});

test('costMicroUsd returns whole micro-dollars and never goes negative', () => {
  const c = costMicroUsd({ inputTokens: 3, outputTokens: 3 }, haiku());
  assert.ok(Number.isInteger(c));
  assert.equal(c, 2); // 0.3 + 1.5 = 1.8 -> 2
  // Inconsistent cache numbers from a provider must not produce a negative charge.
  const odd = costMicroUsd({ inputTokens: 100, outputTokens: 0, cachedInputTokens: 500 }, haiku());
  assert.ok(odd >= 0);
});

test('priceFor returns null for an unknown model and its cost is zero', () => {
  assert.equal(priceFor('some-unknown-model'), null);
  assert.equal(priceFor('gemini-3-flash'), null);
  assert.equal(priceFor('claude-haiku-5-55'), null, 'a similar name is not a dated version');
  assert.equal(priceFor('claude-haiku-5'), null);
  assert.equal(costMicroUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, priceFor('some-unknown-model')), 0);
});

test('priceFor matches a dated model id to its family price', () => {
  const dated = priceFor('claude-haiku-5-5-20261001');
  assert.deepEqual(dated, haiku());
  // The longest family name must win: opus 5.5 is cheaper than opus 5.
  assert.equal(priceFor('claude-opus-5-5-20261001')?.inputPerM, 4);
  assert.equal(priceFor('claude-opus-5-20260101')?.inputPerM, 5);
});

test('a configured price override wins over the built-in table', () => {
  const p = priceFor('claude-haiku-5-5', { inputPerM: 3, outputPerM: 15 });
  assert.deepEqual(p, { inputPerM: 3, outputPerM: 15 });
  // The override has no long-prompt tier or cache discount.
  assert.equal(costMicroUsd({ inputTokens: 200_000, outputTokens: 1_000 }, p), 615_000);
  // An override also prices a model Scout does not know.
  assert.deepEqual(priceFor('my-self-hosted-model', { inputPerM: 0.2, outputPerM: 0.4 }), { inputPerM: 0.2, outputPerM: 0.4 });
  // An override of zero makes it free rather than unknown.
  assert.deepEqual(priceFor('claude-opus-5-5', { inputPerM: 0, outputPerM: 0 }), { inputPerM: 0, outputPerM: 0 });
});

test('a half-set price override is ignored', () => {
  assert.equal(priceFor('claude-haiku-5-5', { inputPerM: 9, outputPerM: null })?.inputPerM, 0.1);
  assert.equal(priceFor('claude-haiku-5-5', { inputPerM: null, outputPerM: 9 })?.outputPerM, 0.5);
  assert.equal(priceFor('claude-haiku-5-5', { inputPerM: null, outputPerM: null })?.inputPerM, 0.1);
  assert.equal(priceFor('unknown-model', { inputPerM: 1, outputPerM: null }), null);
});

test('the mock-1 model is free', () => {
  const p = priceFor('mock-1');
  assert.ok(p);
  assert.equal(p.inputPerM, 0);
  assert.equal(p.outputPerM, 0);
  assert.equal(costMicroUsd({ inputTokens: 5_000_000, outputTokens: 5_000_000, cachedInputTokens: 1_000 }, p), 0);
});

// ---------- through the HTTP API ----------

test('a chat through the API records the same usage for the user, the app key and the project', async () => {
  const env = await testEnv();
  const app = await testApp(env);
  const res = await app.inject({ method: 'POST', url: '/v1/chat', headers: { authorization: `Bearer ${env.appKey}` }, payload: { user_id: 'u1', message: 'hello' } });
  assert.equal(res.statusCode, 200, res.body);
  const now = Date.now();
  const subject = userSubject(env.project.id, 'u1');
  const userMonth = await getCounter(env.db, subject, monthKey(now));
  assert.equal(userMonth.requests, 1);
  assert.ok(userMonth.inputTokens > 0 && userMonth.outputTokens > 0);
  assert.equal(userMonth.costMicroUsd, 0, 'the mock model is free');
  assert.deepEqual(await getCounter(env.db, subject, dayKey(now)), userMonth);
  assert.deepEqual(await getCounter(env.db, `key:${env.appKeyId}`, monthKey(now)), userMonth);
  assert.deepEqual(await getCounter(env.db, `project:${env.project.id}`, monthKey(now)), userMonth);
  await app.close();
  await env.db.close();
});

test('a user over the daily message limit gets a limit reply and the AI is not called', async () => {
  const provider = new MockProvider();
  const env = await testEnv({ env: { USER_MESSAGES_PER_DAY: '2' }, provider });
  const app = await testApp(env);
  const chat = (user: string) =>
    app.inject({ method: 'POST', url: '/v1/chat', headers: { authorization: `Bearer ${env.appKey}` }, payload: { user_id: user, message: 'hello' } });
  for (let i = 0; i < 2; i++) {
    const ok = await chat('u1');
    assert.equal(ok.statusCode, 200, ok.body);
    assert.notEqual(ok.json().stopped, 'limit');
  }
  const calls = provider.requests.length;
  const over = await chat('u1');
  assert.equal(over.statusCode, 200, over.body);
  assert.equal(over.json().stopped, 'limit');
  assert.equal(provider.requests.length, calls, 'no model call for a user over the limit');
  assert.equal((await getCounter(env.db, userSubject(env.project.id, 'u1'), dayKey())).requests, 2, 'the refused message is not counted');
  // Another user of the same app is not affected.
  const other = await chat('u2');
  assert.notEqual(other.json().stopped, 'limit');
  await app.close();
  await env.db.close();
});

test('too many messages per minute answers 429 with a Retry-After header', async () => {
  const env = await testEnv({ env: { USER_MESSAGES_PER_MINUTE: '2' } });
  const app = await testApp(env);
  const chat = (user: string) =>
    app.inject({ method: 'POST', url: '/v1/chat', headers: { authorization: `Bearer ${env.appKey}` }, payload: { user_id: user, message: 'hi' } });
  assert.equal((await chat('u1')).statusCode, 200);
  assert.equal((await chat('u1')).statusCode, 200);
  const res = await chat('u1');
  assert.equal(res.statusCode, 429, res.body);
  assert.equal(res.json().error.code, 'rate_limited');
  const retryAfter = Number(res.headers['retry-after']);
  assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60, `retry-after was ${res.headers['retry-after']}`);
  assert.equal((await chat('u2')).statusCode, 200, 'other users keep their own per-minute budget');
  await app.close();
  await env.db.close();
});
