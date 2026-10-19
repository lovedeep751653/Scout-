import path from 'node:path';

export type ProviderName = 'ollama' | 'anthropic' | 'gemini' | 'groq' | 'openrouter' | 'openai-compatible' | 'mock';

export interface ProviderSettings {
  provider: ProviderName;
  model: string;
  apiKey: string;
  baseUrl: string;
  effort: string;
  // Sent as `reasoning_effort` to OpenAI-compatible runtimes. 'none' turns thinking off
  // on local Ollama models, which is much faster on a CPU.
  reasoningEffort: string;
}

export interface Limits {
  userMessagesPerMinute: number;
  userMessagesPerDay: number;
  userMonthlyTokens: number;
  appKeyRequestsPerMinute: number;
  ipRequestsPerMinute: number;
  maxConcurrentChats: number;
  maxQueuedChats: number;
}

export interface Config {
  env: string;
  version: string;
  port: number;
  host: string;
  publicUrl: string;
  trustProxy: boolean;
  logLevel: string;
  dataDir: string;
  databaseUrl: string;
  databaseSslNoVerify: boolean;
  sqlitePath: string;
  encryptionKey: string;
  appKeyFromEnv: string;
  newAppKeyOnStart: boolean;
  setupWindowMinutes: number;
  allowedOrigins: string[];
  defaultAgentName: string;
  primary: ProviderSettings;
  fallback: ProviderSettings | null;
  ollama: {
    autostart: boolean;
    bin: string;
    contextLength: number;
    keepAlive: string;
    modelsDir: string;
    autoPull: boolean;
  };
  maxOutputTokens: number;
  modelTimeoutMs: number;
  modelMaxRetries: number;
  toolTimeoutMs: number;
  agentTimeoutMs: number;
  agentMaxSteps: number;
  maxMessageChars: number;
  summaryTriggerMessages: number;
  summaryTriggerChars: number;
  summaryKeepMessages: number;
  staleDataDays: number;
  pendingActionTtlMs: number;
  userTokenMaxTtlSeconds: number;
  limits: Limits;
  webhookAllowHttp: boolean;
  webhookTimeoutMs: number;
  webhookMaxResponseBytes: number;
  priceInputPerM: number | null;
  priceOutputPerM: number | null;
}

const PROVIDER_ALIASES: Record<string, ProviderName> = {
  ollama: 'ollama',
  local: 'ollama',
  anthropic: 'anthropic',
  claude: 'anthropic',
  gemini: 'gemini',
  google: 'gemini',
  groq: 'groq',
  openrouter: 'openrouter',
  'openai-compatible': 'openai-compatible',
  openai: 'openai-compatible',
  mock: 'mock',
};

// Ollama: Qwen3.5 4B (Apache-2.0), chosen after testing tool calling, answer format and
// Hindi on a 4-core CPU; see docs/ARCHITECTURE.md. The cloud defaults are only used if
// the owner explicitly switches provider (they need a paid or free-tier API key).
export const DEFAULT_MODELS: Record<ProviderName, string> = {
  ollama: 'qwen3.5:4b',
  anthropic: 'claude-haiku-5-5',
  gemini: 'gemini-flash-latest',
  groq: 'llama-3.3-70b-versatile',
  openrouter: 'openrouter/free',
  'openai-compatible': '',
  mock: 'mock-1',
};

export const DEFAULT_BASE_URLS: Record<ProviderName, string> = {
  ollama: 'http://127.0.0.1:11434/v1',
  anthropic: '',
  gemini: 'https://generativelanguage.googleapis.com',
  groq: 'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  'openai-compatible': '',
  mock: '',
};

const KEY_REQUIRED: ProviderName[] = ['anthropic', 'gemini', 'groq', 'openrouter'];

export function providerNeedsKey(p: ProviderName): boolean {
  return KEY_REQUIRED.includes(p);
}

type Env = Record<string, string | undefined>;

function str(env: Env, name: string, fallback = ''): string {
  const v = env[name];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
}

function int(env: Env, name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const raw = str(env, name);
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new ConfigError(`${name} must be a number (got "${raw}")`);
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function num(env: Env, name: string): number | null {
  const raw = str(env, name);
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new ConfigError(`${name} must be a positive number (got "${raw}")`);
  return n;
}

function bool(env: Env, name: string, fallback: boolean): boolean {
  const raw = str(env, name).toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

export class ConfigError extends Error {}

export function parseProviderName(raw: string, varName: string): ProviderName {
  const p = PROVIDER_ALIASES[raw.toLowerCase()];
  if (!p) {
    throw new ConfigError(`${varName}="${raw}" is not supported. Use one of: ollama, anthropic, gemini, groq, openrouter, openai-compatible, mock.`);
  }
  return p;
}

function providerSettings(env: Env, prefix: '' | 'FALLBACK_'): ProviderSettings | null {
  const providerVar = prefix ? 'FALLBACK_PROVIDER' : 'MODEL_PROVIDER';
  const raw = str(env, providerVar, prefix ? '' : 'ollama');
  if (!raw) return null;
  const provider = parseProviderName(raw, providerVar);
  const model = str(env, `${prefix}MODEL_NAME`, DEFAULT_MODELS[provider]);
  const apiKey = str(env, prefix ? 'SCOUT_FALLBACK_API_KEY' : 'SCOUT_MODEL_API_KEY');
  const baseUrl = str(env, prefix ? 'FALLBACK_BASE_URL' : 'MODEL_BASE_URL', DEFAULT_BASE_URLS[provider]).replace(/\/+$/, '');
  const effort = str(env, `${prefix}MODEL_EFFORT`).toLowerCase();
  if (effort && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
    throw new ConfigError(`${prefix}MODEL_EFFORT must be low, medium, high, xhigh or max.`);
  }
  const reasoningEffort = str(env, `${prefix}MODEL_REASONING_EFFORT`, provider === 'ollama' ? 'none' : '').toLowerCase();
  if ((provider === 'openai-compatible' || provider === 'ollama') && !baseUrl) {
    throw new ConfigError(`${prefix}MODEL_BASE_URL is required for ${provider}.`);
  }
  if (provider === 'openai-compatible' && !model) {
    throw new ConfigError(`${prefix}MODEL_NAME is required when the provider is openai-compatible.`);
  }
  return { provider, model, apiKey, baseUrl, effort, reasoningEffort };
}

function originList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(env: Env = process.env): Config {
  const dataDir = path.resolve(str(env, 'DATA_DIR', './data'));
  const port = int(env, 'PORT', 3000, 1, 65535);
  const primary = providerSettings(env, '');
  if (!primary) throw new ConfigError('MODEL_PROVIDER is missing.');
  const local = primary.provider === 'ollama';
  return {
    env: str(env, 'NODE_ENV', 'development'),
    version: '0.2.0',
    port,
    host: str(env, 'HOST', '0.0.0.0'),
    publicUrl: str(env, 'PUBLIC_URL', str(env, 'SPACE_HOST') ? `https://${str(env, 'SPACE_HOST')}` : `http://localhost:${port}`).replace(/\/+$/, ''),
    trustProxy: bool(env, 'TRUST_PROXY', true),
    logLevel: str(env, 'LOG_LEVEL', 'info'),
    dataDir,
    databaseUrl: str(env, 'DATABASE_URL'),
    databaseSslNoVerify: bool(env, 'DATABASE_SSL_NO_VERIFY', false),
    sqlitePath: str(env, 'SQLITE_PATH', path.join(dataDir, 'scout.db')),
    encryptionKey: str(env, 'SCOUT_ENCRYPTION_KEY'),
    appKeyFromEnv: str(env, 'SCOUT_APP_KEY'),
    newAppKeyOnStart: bool(env, 'SCOUT_NEW_APP_KEY', false),
    setupWindowMinutes: int(env, 'SETUP_WINDOW_MINUTES', 60, 5, 24 * 60),
    allowedOrigins: originList(str(env, 'SCOUT_ALLOWED_ORIGINS')),
    defaultAgentName: str(env, 'AGENT_NAME', 'Scout').slice(0, 40),
    primary,
    fallback: providerSettings(env, 'FALLBACK_'),
    ollama: {
      autostart: bool(env, 'OLLAMA_AUTOSTART', local),
      bin: str(env, 'OLLAMA_BIN', 'ollama'),
      contextLength: int(env, 'OLLAMA_CONTEXT_LENGTH', 8192, 2048, 262_144),
      keepAlive: str(env, 'OLLAMA_KEEP_ALIVE', '-1'),
      modelsDir: str(env, 'OLLAMA_MODELS', path.join(dataDir, 'ollama-models')),
      autoPull: bool(env, 'OLLAMA_AUTO_PULL', true),
    },
    maxOutputTokens: int(env, 'MODEL_MAX_OUTPUT_TOKENS', local ? 1024 : 8000, 128, 64000),
    modelTimeoutMs: int(env, 'MODEL_TIMEOUT_MS', local ? 180_000 : 60_000, 1000, 900_000),
    modelMaxRetries: int(env, 'MODEL_MAX_RETRIES', local ? 1 : 3, 0, 8),
    toolTimeoutMs: int(env, 'TOOL_TIMEOUT_MS', 15_000, 100, 120_000),
    agentTimeoutMs: int(env, 'AGENT_TIMEOUT_MS', local ? 300_000 : 120_000, 1000, 900_000),
    agentMaxSteps: int(env, 'AGENT_MAX_STEPS', 5, 1, 20),
    maxMessageChars: int(env, 'MAX_MESSAGE_CHARS', 2000, 100, 20_000),
    summaryTriggerMessages: int(env, 'SUMMARY_TRIGGER_MESSAGES', 20, 6, 500),
    summaryTriggerChars: int(env, 'SUMMARY_TRIGGER_CHARS', local ? 12_000 : 24_000, 2000, 500_000),
    summaryKeepMessages: int(env, 'SUMMARY_KEEP_MESSAGES', 6, 2, 100),
    staleDataDays: int(env, 'STALE_DATA_DAYS', 7, 1, 365),
    pendingActionTtlMs: int(env, 'PENDING_ACTION_TTL_SECONDS', 600, 30, 86_400) * 1000,
    userTokenMaxTtlSeconds: int(env, 'USER_TOKEN_MAX_TTL_SECONDS', 3600, 60, 86_400),
    limits: {
      userMessagesPerMinute: int(env, 'USER_MESSAGES_PER_MINUTE', 6, 1, 1000),
      userMessagesPerDay: int(env, 'USER_MESSAGES_PER_DAY', 200, 1, 100_000),
      userMonthlyTokens: int(env, 'USER_MONTHLY_TOKENS', 2_000_000, 0),
      appKeyRequestsPerMinute: int(env, 'APP_KEY_REQUESTS_PER_MINUTE', 120, 1, 100_000),
      ipRequestsPerMinute: int(env, 'IP_REQUESTS_PER_MINUTE', 30, 1, 100_000),
      maxConcurrentChats: int(env, 'MAX_CONCURRENT_CHATS', local ? 1 : 4, 1, 64),
      maxQueuedChats: int(env, 'MAX_QUEUED_CHATS', 8, 0, 1000),
    },
    webhookAllowHttp: bool(env, 'WEBHOOK_ALLOW_HTTP', false),
    webhookTimeoutMs: int(env, 'WEBHOOK_TIMEOUT_MS', 8000, 500, 15_000),
    webhookMaxResponseBytes: int(env, 'WEBHOOK_MAX_RESPONSE_BYTES', 65_536, 1024, 1_048_576),
    priceInputPerM: num(env, 'MODEL_PRICE_INPUT_PER_M'),
    priceOutputPerM: num(env, 'MODEL_PRICE_OUTPUT_PER_M'),
  };
}
