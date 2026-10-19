import pg from 'pg';
import type { Db, RunResult, SqlValue } from './types.ts';

// BIGINT columns hold epoch milliseconds and token counts, which fit safely in a JS number.
pg.types.setTypeParser(20, (v) => Number(v));

function convertPlaceholders(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

type Queryable = pg.Pool | pg.PoolClient;

class PgOps implements Db {
  readonly dialect = 'postgres' as const;
  private readonly q: Queryable;
  private readonly pool: pg.Pool;
  private readonly inTx: boolean;

  constructor(q: Queryable, pool: pg.Pool, inTx: boolean) {
    this.q = q;
    this.pool = pool;
    this.inTx = inTx;
  }

  async all<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    const r = await this.q.query(convertPlaceholders(sql), params);
    return r.rows as T[];
  }

  async get<T>(sql: string, params: SqlValue[] = []): Promise<T | undefined> {
    const rows = await this.all<T>(sql, params);
    return rows[0];
  }

  async run(sql: string, params: SqlValue[] = []): Promise<RunResult> {
    const r = await this.q.query(convertPlaceholders(sql), params);
    return { changes: r.rowCount ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    await this.q.query(sql);
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    if (this.inTx) return fn(this);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(new PgOps(client, this.pool, true));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async ping(): Promise<void> {
    await this.q.query('SELECT 1');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function openPostgres(connectionString: string, opts: { sslNoVerify?: boolean } = {}): Db {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ...(opts.sslNoVerify ? { ssl: { rejectUnauthorized: false } } : {}),
  });
  pool.on('error', () => {});
  return new PgOps(pool, pool, false);
}
