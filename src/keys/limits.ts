import type { Db } from '../db/index.ts';

// Sliding-window counter per key (and per visitor IP for public keys). In memory, so
// each server instance counts separately; that is fine for one instance.
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number; prev: number }>();
  private readonly windowMs: number;

  constructor(windowMs = 60_000) {
    this.windowMs = windowMs;
  }

  hit(id: string, limit: number, now = Date.now()): { allowed: boolean; retryAfterSec: number; remaining: number } {
    let w = this.windows.get(id);
    const start = now - (now % this.windowMs);
    if (!w || start - w.start >= 2 * this.windowMs) w = { start, count: 0, prev: 0 };
    else if (start !== w.start) w = { start, count: 0, prev: w.count };
    const weight = 1 - (now - start) / this.windowMs;
    const used = w.prev * weight + w.count;
    if (used + 1 > limit) {
      this.windows.set(id, w);
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((start + this.windowMs - now) / 1000)), remaining: 0 };
    }
    w.count += 1;
    this.windows.set(id, w);
    if (this.windows.size > 50_000) this.prune(now);
    return { allowed: true, retryAfterSec: 0, remaining: Math.max(0, Math.floor(limit - used - 1)) };
  }

  private prune(now: number): void {
    for (const [k, w] of this.windows) if (now - w.start > 2 * this.windowMs) this.windows.delete(k);
  }
}

export function monthKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 7);
}

export interface MonthUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
  alert80Sent: boolean;
}

export async function getMonthUsage(db: Db, keyId: string, month = monthKey()): Promise<MonthUsage> {
  const r = await db.get<{ requests: number; input_tokens: number; output_tokens: number; cost_micro_usd: number; alert_80_sent: number }>(
    'SELECT requests, input_tokens, output_tokens, cost_micro_usd, alert_80_sent FROM usage_monthly WHERE key_id = ? AND month = ?',
    [keyId, month],
  );
  return {
    requests: Number(r?.requests ?? 0),
    inputTokens: Number(r?.input_tokens ?? 0),
    outputTokens: Number(r?.output_tokens ?? 0),
    costMicroUsd: Number(r?.cost_micro_usd ?? 0),
    alert80Sent: Number(r?.alert_80_sent ?? 0) === 1,
  };
}

export async function addUsage(
  db: Db,
  keyId: string,
  projectId: string,
  delta: { requests?: number; inputTokens?: number; outputTokens?: number; costMicroUsd?: number },
  month = monthKey(),
): Promise<void> {
  await db.run(
    `INSERT INTO usage_monthly (key_id, month, project_id, requests, input_tokens, output_tokens, cost_micro_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (key_id, month) DO UPDATE SET
       requests = usage_monthly.requests + excluded.requests,
       input_tokens = usage_monthly.input_tokens + excluded.input_tokens,
       output_tokens = usage_monthly.output_tokens + excluded.output_tokens,
       cost_micro_usd = usage_monthly.cost_micro_usd + excluded.cost_micro_usd`,
    [keyId, month, projectId, delta.requests ?? 0, delta.inputTokens ?? 0, delta.outputTokens ?? 0, delta.costMicroUsd ?? 0],
  );
}

export interface BudgetState {
  used: number;
  budget: number;
  exhausted: boolean;
  ratio: number;
}

export async function budgetState(db: Db, keyId: string, budget: number): Promise<BudgetState> {
  const u = await getMonthUsage(db, keyId);
  const used = u.inputTokens + u.outputTokens;
  if (budget <= 0) return { used, budget: 0, exhausted: false, ratio: 0 };
  return { used, budget, exhausted: used >= budget, ratio: used / budget };
}

// Returns true only the first time a key passes 80% of its budget in a month.
export async function claimBudgetAlert(db: Db, keyId: string, month = monthKey()): Promise<boolean> {
  const r = await db.run('UPDATE usage_monthly SET alert_80_sent = 1 WHERE key_id = ? AND month = ? AND alert_80_sent = 0', [keyId, month]);
  return r.changes > 0;
}
