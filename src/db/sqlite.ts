import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Db, RunResult, SqlValue } from './types.ts';

// node:sqlite is synchronous, but a transaction callback can await. The lock makes
// other queries wait until an open transaction finishes, so they never mix into it.
class Lock {
  tail: Promise<void> = Promise.resolve();
  held = false;

  async acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => (release = resolve));
    const prev = this.tail;
    this.tail = prev.then(() => next);
    await prev;
    this.held = true;
    return () => {
      this.held = false;
      release();
    };
  }
}

function toPlain<T>(row: unknown): T {
  return row && typeof row === 'object' ? ({ ...(row as object) } as T) : (row as T);
}

class SqliteOps implements Db {
  readonly dialect = 'sqlite' as const;
  private readonly raw: DatabaseSync;
  private readonly lock: Lock;
  private readonly inTx: boolean;

  constructor(raw: DatabaseSync, lock: Lock, inTx: boolean) {
    this.raw = raw;
    this.lock = lock;
    this.inTx = inTx;
  }

  private async exclusive<T>(fn: () => T): Promise<T> {
    while (!this.inTx && this.lock.held) await this.lock.tail;
    return fn();
  }

  all<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    return this.exclusive(() => this.raw.prepare(sql).all(...params).map((r) => toPlain<T>(r)));
  }

  get<T>(sql: string, params: SqlValue[] = []): Promise<T | undefined> {
    return this.exclusive(() => {
      const row = this.raw.prepare(sql).get(...params);
      return row === undefined ? undefined : toPlain<T>(row);
    });
  }

  run(sql: string, params: SqlValue[] = []): Promise<RunResult> {
    return this.exclusive(() => ({ changes: Number(this.raw.prepare(sql).run(...params).changes) }));
  }

  exec(sql: string): Promise<void> {
    return this.exclusive(() => {
      this.raw.exec(sql);
    });
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    if (this.inTx) return fn(this);
    const release = await this.lock.acquire();
    try {
      this.raw.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(new SqliteOps(this.raw, this.lock, true));
        this.raw.exec('COMMIT');
        return result;
      } catch (err) {
        this.raw.exec('ROLLBACK');
        throw err;
      }
    } finally {
      release();
    }
  }

  ping(): Promise<void> {
    return this.exclusive(() => {
      this.raw.prepare('SELECT 1').get();
    });
  }

  async close(): Promise<void> {
    this.raw.close();
  }
}

export function openSqlite(file: string): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  return new SqliteOps(raw, new Lock(), false);
}
