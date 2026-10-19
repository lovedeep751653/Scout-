import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentDeps } from '../src/agent/loop.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { migrate } from '../src/db/migrations.ts';
import { openDatabase, type Db } from '../src/db/index.ts';
import { clearKeyCache, createKey } from '../src/keys/keys.ts';
import { ChatQueue, RateLimiter } from '../src/keys/limits.ts';
import { createProject, type Project } from '../src/keys/projects.ts';
import { MockProvider, type MockScript } from '../src/providers/mock.ts';
import type { ModelProvider } from '../src/providers/types.ts';
import { Secrets } from '../src/security/crypto.ts';
import { buildApp, type ServerDeps } from '../src/server/app.ts';
import { registerBuiltinTools } from '../src/tools/builtin.ts';
import { ToolRegistry } from '../src/tools/registry.ts';

// Tests run on SQLite by default. Set TEST_DATABASE_URL=postgres://... to run the same
// tests on Postgres (each test then uses its own fresh schema).
export const TEST_SECRET = 'test-master-secret-that-is-long-enough-123456';

export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({
    MODEL_PROVIDER: 'mock',
    LOG_LEVEL: 'silent',
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'scout-test-')),
    PUBLIC_URL: 'https://scout.test',
    USER_MESSAGES_PER_MINUTE: '1000',
    APP_KEY_REQUESTS_PER_MINUTE: '1000',
    IP_REQUESTS_PER_MINUTE: '1000',
    ...env,
  });
}

let schemaCounter = 0;

export async function testDb(): Promise<Db> {
  const url = process.env.TEST_DATABASE_URL;
  if (url) {
    const schema = `t_${process.pid}_${Date.now()}_${schemaCounter++}`;
    const admin = openDatabase({ databaseUrl: url, sqlitePath: '' });
    await admin.exec(`CREATE SCHEMA ${schema}`);
    await admin.close();
    const sep = url.includes('?') ? '&' : '?';
    const db = openDatabase({ databaseUrl: `${url}${sep}options=-c%20search_path%3D${schema}`, sqlitePath: '' });
    await migrate(db);
    return db;
  }
  const db = openDatabase({ databaseUrl: '', sqlitePath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scout-db-')), 'test.db') });
  await migrate(db);
  return db;
}

export interface TestEnv {
  db: Db;
  config: Config;
  secrets: Secrets;
  project: Project;
  appKey: string;
  appKeyId: string;
  provider: ModelProvider;
  registry: ToolRegistry;
  deps: ServerDeps;
}

export async function testEnv(opts: { env?: Record<string, string>; script?: MockScript; provider?: ModelProvider } = {}): Promise<TestEnv> {
  clearKeyCache();
  const config = testConfig(opts.env);
  const db = await testDb();
  const secrets = new Secrets(TEST_SECRET);
  const project = await createProject(db, 'LoginLens');
  const { key, plaintext } = await createKey(db, { projectId: project.id, name: 'test key', rateLimitPerMin: config.limits.appKeyRequestsPerMinute });
  const registry = new ToolRegistry();
  registerBuiltinTools(registry);
  const provider = opts.provider ?? new MockProvider({ script: opts.script });
  const deps: ServerDeps = {
    db,
    config,
    secrets,
    registry,
    provider,
    runtime: null,
    queue: new ChatQueue(config.limits.maxConcurrentChats, config.limits.maxQueuedChats),
    log: { warn: () => {}, error: () => {} },
    defaultProjectId: project.id,
    masterSecretSource: 'env',
    limiter: new RateLimiter(),
  };
  return { db, config, secrets, project, appKey: plaintext, appKeyId: key.id, provider, registry, deps };
}

export async function testApp(env: TestEnv) {
  return buildApp(env.deps);
}

export function agentDeps(env: TestEnv): AgentDeps {
  return env.deps;
}

// Parses a text/event-stream body into [{event, data}] items.
export function parseSseBody(body: string): Array<{ event: string; data: unknown }> {
  return body
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block && !block.startsWith(':'))
    .map((block) => {
      let event = 'message';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      return { event, data: data ? JSON.parse(data) : null };
    });
}
