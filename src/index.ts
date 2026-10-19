import { ConfigError, loadConfig } from './config.ts';
import { migrate } from './db/migrations.ts';
import { openDatabase } from './db/index.ts';
import { ChatQueue } from './keys/limits.ts';
import { ensureDefaultProject } from './keys/projects.ts';
import { ensureAppKey, SetupError } from './keys/setup.ts';
import { createModelStack } from './providers/index.ts';
import { OllamaRuntime } from './runtime/ollama.ts';
import { resolveMasterSecret, Secrets } from './security/crypto.ts';
import { buildApp } from './server/app.ts';
import { registerBuiltinTools } from './tools/builtin.ts';
import { ToolRegistry } from './tools/registry.ts';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`\nScout could not start: ${err.message}\nFix this setting in your hosting dashboard (Environment / Secrets) and restart.\n`);
      process.exit(1);
    }
    throw err;
  }

  const master = resolveMasterSecret(config.encryptionKey, config.dataDir);
  const secrets = new Secrets(master.secret);
  const db = openDatabase({ databaseUrl: config.databaseUrl, sqlitePath: config.sqlitePath, sslNoVerify: config.databaseSslNoVerify });
  await migrate(db);
  const project = await ensureDefaultProject(db);

  let setup;
  try {
    setup = await ensureAppKey(db, secrets, config, project.id);
  } catch (err) {
    if (err instanceof SetupError) {
      console.error(`\nScout could not start: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const registry = new ToolRegistry();
  registerBuiltinTools(registry);
  const queue = new ChatQueue(config.limits.maxConcurrentChats, config.limits.maxQueuedChats);

  let runtime: OllamaRuntime | null = null;
  const deps = {
    db,
    config,
    secrets,
    registry,
    provider: null as unknown as ReturnType<typeof createModelStack>,
    runtime: null as OllamaRuntime | null,
    queue,
    log: { warn: (_o: unknown, _m?: string) => {}, error: (_o: unknown, _m?: string) => {} },
    defaultProjectId: project.id,
    masterSecretSource: master.source,
  };
  const app = await buildApp(deps);
  deps.log = { warn: (o, m) => app.log.warn(o, m), error: (o, m) => app.log.error(o, m) };
  deps.provider = createModelStack(config, {
    onRetry: (i) => app.log.warn({ provider: i.provider, attempt: i.attempt, delayMs: Math.round(i.delayMs), kind: i.error.kind }, 'retrying AI call'),
    onFallback: (e) => app.log.warn({ provider: e.provider, kind: e.kind }, 'switching to fallback AI provider'),
  });
  if (config.primary.provider === 'ollama') {
    runtime = new OllamaRuntime(config, { info: (m) => app.log.info(m), warn: (m) => app.log.warn(m), error: (m) => app.log.error(m) });
    deps.runtime = runtime;
  }

  await app.listen({ port: config.port, host: config.host });
  app.log.info(`Scout ${config.version} is running at ${config.publicUrl} (AI: ${config.primary.provider} / ${config.primary.model}).`);
  if (master.source === 'generated') app.log.warn('Created a new encryption secret in the data folder. To keep it safe across disk resets, set SCOUT_ENCRYPTION_KEY.');
  if (config.appKeyFromEnv && config.newAppKeyOnStart) app.log.warn('SCOUT_NEW_APP_KEY is ignored because SCOUT_APP_KEY is set. The SCOUT_APP_KEY key is the only valid app key.');
  if (setup.status === 'pending') {
    app.log.info(`First-time setup: open ${config.publicUrl}/setup within ${config.setupWindowMinutes} minutes to get your Scout app key.`);
  }
  void runtime?.start();

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received, shutting down.`);
    runtime?.stop();
    await app.close().catch(() => {});
    await db.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Scout crashed while starting:', err instanceof Error ? err.message : err);
  process.exit(1);
});
