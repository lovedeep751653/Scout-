export type SqlValue = string | number | null;

export interface RunResult {
  changes: number;
}

// SQL is written once with `?` placeholders; each driver adapts it.
export interface Db {
  readonly dialect: 'sqlite' | 'postgres';
  all<T>(sql: string, params?: SqlValue[]): Promise<T[]>;
  get<T>(sql: string, params?: SqlValue[]): Promise<T | undefined>;
  run(sql: string, params?: SqlValue[]): Promise<RunResult>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  ping(): Promise<void>;
  close(): Promise<void>;
}
