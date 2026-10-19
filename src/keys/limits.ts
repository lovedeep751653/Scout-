import type { Db } from '../db/index.ts';

// Sliding-window counter. Kept in memory, so each server instance counts on its own.
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number; prev: number }>();
  private readonly windowMs: number;

  constructor(windowMs = 60_000) {
    this.windowMs = windowMs;
  }

  hit(id: string, limit: number, now = Date.now()): { allowed: boolean; retryAfterSec: number } {
    let w = this.windows.get(id);
    const start = now - (now % this.windowMs);
    if (!w || start - w.start >= 2 * this.windowMs) w = { start, count: 0, prev: 0 };
    else if (start !== w.start) w = { start, count: 0, prev: w.count };
    const weight = 1 - (now - start) / this.windowMs;
    const used = w.prev * weight + w.count;
    this.windows.set(id, w);
    if (used + 1 > limit) {
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((start + this.windowMs - now) / 1000)) };
    }
    w.count += 1;
    if (this.windows.size > 50_000) this.prune(now);
    return { allowed: true, retryAfterSec: 0 };
  }

  private prune(now: number): void {
    for (const [k, w] of this.windows) if (now - w.start > 2 * this.windowMs) this.windows.delete(k);
  }
}

// One chat at a time keeps a small CPU server responsive; others wait in a short line.
export class ChatQueue {
  private running = 0;
  private readonly waiting: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  private readonly maxRunning: number;
  private readonly maxWaiting: number;

  constructor(maxRunning: number, maxWaiting: number) {
    this.maxRunning = maxRunning;
    this.maxWaiting = maxWaiting;
  }

  get length(): number {
    return this.waiting.length;
  }

  // Resolves with a release function. Rejects with QueueFullError when the line is full.
  async enter(signal?: AbortSignal, onWait?: (position: number) => void): Promise<() => void> {
    if (this.running < this.maxRunning) {
      this.running++;
      return this.releaser();
    }
    if (this.waiting.length >= this.maxWaiting) throw new QueueFullError();
    await new Promise<void>((resolve, reject) => {
      const entry = { resolve, reject };
      this.waiting.push(entry);
      onWait?.(this.waiting.length);
      signal?.addEventListener(
        'abort',
        () => {
          const i = this.waiting.indexOf(entry);
          if (i !== -1) this.waiting.splice(i, 1);
          reject(new Error('aborted'));
        },
        { once: true },
      );
    });
    return this.releaser();
  }

  private releaser(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.waiting.shift();
      if (next) next.resolve();
      else this.running--;
    };
  }
}

export class QueueFullError extends Error {}

export function userSubject(projectId: string, userId: string): string {
  return `user:${projectId}:${userId}`;
}

export function monthKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 7);
}

export function dayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export interface Counter {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
  alertSent: boolean;
}

export async function getCounter(db: Db, subject: string, period: string): Promise<Counter> {
  const r = await db.get<{ requests: number; input_tokens: number; output_tokens: number; cost_micro_usd: number; alert_sent: number }>(
    'SELECT requests, input_tokens, output_tokens, cost_micro_usd, alert_sent FROM usage_counters WHERE subject = ? AND period = ?',
    [subject, period],
  );
  return {
    requests: Number(r?.requests ?? 0),
    inputTokens: Number(r?.input_tokens ?? 0),
    outputTokens: Number(r?.output_tokens ?? 0),
    costMicroUsd: Number(r?.cost_micro_usd ?? 0),
    alertSent: Number(r?.alert_sent ?? 0) === 1,
  };
}

export interface UsageDelta {
  requests?: number;
  inputTokens?: number;
  outputTokens?: number;
  costMicroUsd?: number;
}

async function bump(db: Db, subject: string, period: string, projectId: string, d: UsageDelta): Promise<void> {
  await db.run(
    `INSERT INTO usage_counters (subject, period, project_id, requests, input_tokens, output_tokens, cost_micro_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (subject, period) DO UPDATE SET
       requests = usage_counters.requests + excluded.requests,
       input_tokens = usage_counters.input_tokens + excluded.input_tokens,
       output_tokens = usage_counters.output_tokens + excluded.output_tokens,
       cost_micro_usd = usage_counters.cost_micro_usd + excluded.cost_micro_usd`,
    [subject, period, projectId, d.requests ?? 0, d.inputTokens ?? 0, d.outputTokens ?? 0, d.costMicroUsd ?? 0],
  );
}

// Counts usage per user (day + month), per app key (month) and for the whole project.
export async function recordUsage(db: Db, s: { projectId: string; userSubject: string; keyId: string | null }, d: UsageDelta, now = Date.now()): Promise<void> {
  const month = monthKey(now);
  await bump(db, s.userSubject, month, s.projectId, d);
  await bump(db, s.userSubject, dayKey(now), s.projectId, d);
  if (s.keyId) await bump(db, `key:${s.keyId}`, month, s.projectId, d);
  await bump(db, `project:${s.projectId}`, month, s.projectId, d);
}

export type LimitBreach = 'daily_messages' | 'monthly_tokens' | 'key_budget' | null;

export async function checkUsageLimits(
  db: Db,
  s: { userSubject: string; keyId: string | null; keyBudget: number },
  limits: { userMessagesPerDay: number; userMonthlyTokens: number },
  now = Date.now(),
): Promise<LimitBreach> {
  const day = await getCounter(db, s.userSubject, dayKey(now));
  if (day.requests >= limits.userMessagesPerDay) return 'daily_messages';
  if (limits.userMonthlyTokens > 0) {
    const month = await getCounter(db, s.userSubject, monthKey(now));
    if (month.inputTokens + month.outputTokens >= limits.userMonthlyTokens) return 'monthly_tokens';
  }
  if (s.keyId && s.keyBudget > 0) {
    const k = await getCounter(db, `key:${s.keyId}`, monthKey(now));
    if (k.inputTokens + k.outputTokens >= s.keyBudget) return 'key_budget';
  }
  return null;
}
