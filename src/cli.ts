import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigError, loadConfig, providerNeedsKey, type Config } from './config.ts';
import { openDatabase } from './db/index.ts';
import { MIGRATIONS } from './db/migrations.ts';

// `npm run doctor`: checks the setup in plain words and changes nothing.
// It never prints keys or secrets, only whether they are set.

type Level = 'ok' | 'warn' | 'fail';
const results: Array<{ level: Level; text: string }> = [];
const report = (level: Level, text: string) => {
  results.push({ level, text });
  console.log(`${level === 'ok' ? '  OK  ' : level === 'warn' ? ' NOTE ' : ' FIX  '} ${text}`);
};

const GB = 1024 ** 3;

function checkNode(): void {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  if (major > 22 || (major === 22 && minor >= 18)) report('ok', `Node.js ${process.versions.node}`);
  else report('fail', `Node.js ${process.versions.node} is too old. Scout needs 22.18 or newer.`);
}

function checkMachine(config: Config): void {
  const mem = os.totalmem() / GB;
  if (config.primary.provider !== 'ollama') report('ok', `Memory: ${mem.toFixed(1)} GB`);
  else if (mem >= 7.5) report('ok', `Memory: ${mem.toFixed(1)} GB (the local AI needs about 5-6 GB)`);
  else report('warn', `Memory: ${mem.toFixed(1)} GB. The 4B model needs about 5-6 GB; try MODEL_NAME=qwen3.5:2b on a small server.`);
  report('ok', `CPU cores: ${os.cpus().length}. More cores give faster answers.`);
}

function checkDataFolder(config: Config): void {
  if (config.databaseUrl) return;
  try {
    // Look at the folder, or the nearest one above it that exists, without creating anything.
    let dir = path.resolve(config.dataDir);
    while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
    fs.accessSync(dir, fs.constants.W_OK);
    const st = fs.statfsSync(dir);
    const free = (st.bavail * st.bsize) / GB;
    if (free < 1) report('warn', `Data folder ${config.dataDir}: only ${free.toFixed(1)} GB free.`);
    else report('ok', `Data folder ${config.dataDir} is writable (${free.toFixed(1)} GB free).`);
  } catch (err) {
    report('fail', `Data folder ${config.dataDir} cannot be written: ${(err as Error).message}. Set DATA_DIR to a writable folder.`);
  }
}

function checkSecrets(config: Config): void {
  if (config.encryptionKey && config.encryptionKey.length < 32) report('fail', 'SCOUT_ENCRYPTION_KEY is too short. Use at least 32 letters and numbers, or remove it.');
  else if (config.encryptionKey) report('ok', 'SCOUT_ENCRYPTION_KEY is set.');
  else if (fs.existsSync(path.join(config.dataDir, '.scout-secret'))) report('ok', 'Encryption secret is stored in the data folder.');
  else report('warn', 'No encryption secret yet. Scout creates one on first start. On hosts whose disk resets, set SCOUT_ENCRYPTION_KEY.');
  if (config.appKeyFromEnv) report('ok', 'SCOUT_APP_KEY is set as a hosting secret (the key is not shown).');
}

async function checkDatabase(config: Config): Promise<void> {
  const where = config.databaseUrl ? 'Postgres (DATABASE_URL)' : `SQLite file ${config.sqlitePath}`;
  if (!config.databaseUrl && !fs.existsSync(config.sqlitePath)) {
    report('warn', `No database yet at ${config.sqlitePath}. Scout creates it on first start.`);
    return;
  }
  const db = openDatabase({ databaseUrl: config.databaseUrl, sqlitePath: config.sqlitePath, sslNoVerify: config.databaseSslNoVerify });
  try {
    await db.ping();
    report('ok', `Database works: ${where}.`);
    const applied = await db.all<{ version: number }>('SELECT version FROM schema_migrations').catch(() => []);
    const missing = MIGRATIONS.length - applied.length;
    if (missing > 0) report('warn', `Database needs ${missing} update(s). Scout applies them on the next start.`);
    else report('ok', 'Database tables are up to date.');
    const setup = await db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'setup.app_key'").catch(() => undefined);
    const status = setup ? (JSON.parse(setup.value) as { status: string; windowEndsAt?: number }) : null;
    if (!status) report('warn', 'No Scout app key yet. Start Scout, then open /setup within the first hour.');
    else if (status.status === 'pending' && (status.windowEndsAt ?? 0) > Date.now()) report('warn', 'The Scout app key is waiting at /setup. Open it, copy the key and press "I saved the key".');
    else if (status.status === 'pending' || status.status === 'expired') report('warn', 'The /setup window closed before the key was saved. Restart Scout to get a fresh key at /setup.');
    else report('ok', `Scout app key is set up (${status.status === 'env' ? 'from SCOUT_APP_KEY' : 'saved by the owner'}).`);
    const connector = await db.get<{ enabled: number }>("SELECT enabled FROM connectors WHERE name = 'loginlens'").catch(() => undefined);
    if (connector && Number(connector.enabled) === 1) report('ok', 'LoginLens is connected (its tools endpoint is registered).');
    else report('warn', config.demoMode ? 'LoginLens is not connected yet; only the demo with sample data works.' : 'LoginLens is not connected yet. See docs/INTEGRATION.md, step 2.');
  } catch (err) {
    report('fail', `Cannot open the database (${where}): ${(err as Error).message}`);
  } finally {
    await db.close().catch(() => {});
  }
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: 'manual' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function checkAi(config: Config): Promise<void> {
  const p = config.primary;
  if (p.provider !== 'ollama') {
    if (providerNeedsKey(p.provider) && !p.apiKey) report('fail', `AI provider "${p.provider}" needs SCOUT_MODEL_API_KEY, which is not set.`);
    else report('ok', `AI provider: ${p.provider}, model ${p.model}. Note: cloud providers can charge per use.`);
    return;
  }
  report('ok', `AI: local Ollama, model ${p.model}. No AI API key and no per-use fees.`);
  const bin = spawnSync(config.ollama.bin, ['--version'], { encoding: 'utf8', timeout: 5000 });
  if (bin.error) {
    report(config.ollama.autostart ? 'fail' : 'warn', `The "${config.ollama.bin}" program was not found. The Docker image includes it; elsewhere install it from ollama.com.`);
  } else {
    const version = /\d+\.\d+\.\d+/.exec(`${bin.stdout}${bin.stderr}`)?.[0];
    report('ok', `Ollama program found${version ? ` (version ${version})` : ''}.`);
  }
  const base = p.baseUrl.replace(/\/v1\/?$/, '');
  try {
    const tags = (await getJson(`${base}/api/tags`)) as { models?: Array<{ name: string }> };
    const names = (tags.models ?? []).map((m) => m.name);
    const has = names.some((n) => n === p.model || n === `${p.model}:latest`);
    if (has) report('ok', 'The AI model is downloaded.');
    else report('warn', `The AI model is not downloaded yet. Scout downloads it on start (about 3 GB).`);
  } catch {
    report('warn', 'The local AI is not running right now. That is normal when Scout is stopped; Scout starts it automatically.');
  }
}

async function checkRunningScout(config: Config): Promise<void> {
  try {
    const h = (await getJson(`http://127.0.0.1:${config.port}/health`)) as { status?: string; ai?: { state?: string } };
    report('ok', `Scout is running on port ${config.port} (status ${h.status ?? 'unknown'}${h.ai?.state ? `, AI ${h.ai.state}` : ''}).`);
  } catch {
    report('warn', `Scout is not running on port ${config.port}. Start it with: npm start`);
  }
  if (/localhost|127\.0\.0\.1/.test(config.publicUrl)) report('warn', `Public address is ${config.publicUrl}. On a server, set PUBLIC_URL to the real https address.`);
  else report('ok', `Public address: ${config.publicUrl}`);
}

async function doctor(): Promise<number> {
  console.log('\nScout doctor: checking your setup (nothing is changed)\n');
  checkNode();
  let config: Config;
  try {
    config = loadConfig();
    report('ok', 'Settings are valid.');
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    report('fail', `Settings problem: ${err.message}`);
    return 1;
  }
  checkMachine(config);
  checkDataFolder(config);
  checkSecrets(config);
  await checkDatabase(config);
  await checkAi(config);
  await checkRunningScout(config);
  const fails = results.filter((r) => r.level === 'fail').length;
  const notes = results.filter((r) => r.level === 'warn').length;
  console.log(`\n${fails ? `${fails} thing(s) to fix` : 'Nothing to fix'}${notes ? `, ${notes} note(s)` : ''}.\n`);
  return fails ? 1 : 0;
}

const command = process.argv[2] ?? 'doctor';
if (command !== 'doctor') {
  console.error(`Unknown command "${command}". Try: npm run doctor`);
  process.exit(2);
}
process.exitCode = await doctor();
