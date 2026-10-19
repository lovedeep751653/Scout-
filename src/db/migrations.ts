import type { Db } from './types.ts';

export interface Migration {
  version: number;
  name: string;
  statements: string[];
}

// Written in SQL that both SQLite and Postgres accept: TEXT ids, BIGINT epoch-ms
// timestamps, INTEGER 0/1 booleans and JSON stored as TEXT.
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'core',
    statements: [
      `CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        settings TEXT NOT NULL DEFAULT '{}',
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      )`,
      `CREATE TABLE api_keys (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        key_hint TEXT NOT NULL,
        scopes TEXT NOT NULL,
        source TEXT NOT NULL,
        rate_limit_per_min INTEGER NOT NULL,
        monthly_token_budget BIGINT NOT NULL,
        expires_at BIGINT,
        revoked_at BIGINT,
        replaced_by TEXT,
        last_used_at BIGINT,
        created_at BIGINT NOT NULL
      )`,
      `CREATE INDEX api_keys_project ON api_keys(project_id)`,
      `CREATE TABLE usage_counters (
        subject TEXT NOT NULL,
        period TEXT NOT NULL,
        project_id TEXT NOT NULL,
        requests INTEGER NOT NULL DEFAULT 0,
        input_tokens BIGINT NOT NULL DEFAULT 0,
        output_tokens BIGINT NOT NULL DEFAULT 0,
        cost_micro_usd BIGINT NOT NULL DEFAULT 0,
        alert_sent INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (subject, period)
      )`,
      `CREATE TABLE connectors (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        secret_enc TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (project_id, name)
      )`,
      `CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        key_id TEXT,
        title TEXT,
        summary TEXT,
        summary_upto INTEGER NOT NULL DEFAULT 0,
        language TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      )`,
      `CREATE INDEX sessions_project_user ON sessions(project_id, user_id)`,
      `CREATE INDEX sessions_updated ON sessions(project_id, updated_at)`,
      `CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        feedback INTEGER,
        created_at BIGINT NOT NULL,
        UNIQUE (session_id, seq)
      )`,
      `CREATE TABLE pending_actions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        key_id TEXT,
        tool_name TEXT NOT NULL,
        args TEXT NOT NULL,
        summary TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        resolved_at BIGINT
      )`,
      `CREATE INDEX pending_actions_session ON pending_actions(session_id)`,
      `CREATE TABLE webhook_tools (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        input_schema TEXT NOT NULL,
        permission TEXT NOT NULL,
        url TEXT NOT NULL,
        secret_enc TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        timeout_ms INTEGER,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        UNIQUE (project_id, name)
      )`,
      `CREATE TABLE audit_log (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        key_id TEXT,
        session_id TEXT,
        user_id TEXT,
        event TEXT NOT NULL,
        tool_name TEXT,
        status TEXT NOT NULL,
        detail TEXT,
        duration_ms INTEGER,
        created_at BIGINT NOT NULL
      )`,
      `CREATE INDEX audit_log_project ON audit_log(project_id, created_at)`,
      `CREATE TABLE user_notes (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at BIGINT NOT NULL
      )`,
      `CREATE INDEX user_notes_user ON user_notes(project_id, user_id)`,
      `CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at BIGINT NOT NULL
      )`,
    ],
  },
  {
    version: 2,
    name: 'connector_key',
    // Which app key registered the connector: a different key gets a new signing secret.
    statements: ['ALTER TABLE connectors ADD COLUMN key_id TEXT'],
  },
];

export async function migrate(db: Db, migrations: Migration[] = MIGRATIONS): Promise<number[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at BIGINT NOT NULL)`);
  const applied = new Set((await db.all<{ version: number }>('SELECT version FROM schema_migrations')).map((r) => Number(r.version)));
  const done: number[] = [];
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (applied.has(m.version)) continue;
    await db.transaction(async (tx) => {
      for (const stmt of m.statements) await tx.exec(stmt);
      await tx.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [m.version, m.name, Date.now()]);
    });
    done.push(m.version);
  }
  return done;
}
