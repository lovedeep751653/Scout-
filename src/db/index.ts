import { openPostgres } from './postgres.ts';
import { openSqlite } from './sqlite.ts';
import type { Db } from './types.ts';

export type { Db, SqlValue } from './types.ts';

export function isPostgresUrl(url: string): boolean {
  return /^postgres(ql)?:\/\//i.test(url);
}

export function openDatabase(opts: { databaseUrl: string; sqlitePath: string; sslNoVerify?: boolean }): Db {
  if (opts.databaseUrl) {
    if (!isPostgresUrl(opts.databaseUrl)) {
      throw new Error('DATABASE_URL must start with postgres:// or postgresql://. Leave it empty to use SQLite.');
    }
    return openPostgres(opts.databaseUrl, { sslNoVerify: opts.sslNoVerify });
  }
  return openSqlite(opts.sqlitePath);
}
