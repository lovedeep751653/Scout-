import path from 'node:path';

export type ProviderName = 'anthropic' | 'gemini' | 'groq' | 'openrouter' | 'openai-compatible' | 'mock';

export interface ProviderSettings {
  provider: ProviderName;
  model: string;
  apiKey: string;
  baseUrl: string;
  effort: string;
}

export interface Config {
  env: string;
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
  adminPassword: string;
  defaultAgentName: string;
  primary: ProviderSettings;
  fallback: ProviderSettings | null;
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
  publicPerIpLimitPerMin: number;
  defaultRateLimitPerMin: number;
  defaultMonthlyTokenBudget: number;
  webhookAllowHttp: boolean;
  webhookTimeoutMs: number;
  webhookMaxResponseBytes: number;
  priceInputPerM: number | null;
  priceOutputPerM: number | null;
}

const PROVIDER_ALIASES: Record<string, ProviderName> = {
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

// Defaults checked against each provider's official docs/SDK in Oct 2026:
// Claude: claude-haiku-5-5 (Anthropic models table); Gemini: gemini-flash-latest
// (alias used throughout Google's official @google/genai README); Groq: listed on
// Groq's tool-use page; OpenRouter: the official free-models router.
export const DEFAULT_MODELS: Record<ProviderName, string> = {
  anthropic: 'claude-haiku-5-5',
  gemini: 'gemini-flash-latest',
  groq: 'llama-3.3-70b-versatile',
  openrouter: 'openrouter/free',
  'openai-compatible': '',
  mock: 'mock-1',
};

export const DEFAULT_BASE_URLS: Record<ProviderName, string> = {
  anthropic: '',
  gemini: 'https://generativelanguage.googleapis.com',
  groq: 'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  'openai-compatible': '',
  mock: '',
};

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
    throw new ConfigError(
      `${varName}="${raw}" is not supported. Use one of: anthropic, gemini, groq, openrouter, openai-compatible, mock.`,
    );
  }
  return p;
}

function providerSettings(env: Env, prefix: '' | 'FALLBACK_'): ProviderSettings | null {
  const providerVar = prefix ? 'FALLBACK_PROVIDER' : 'MODEL_PROVIDER';
  const raw = str(env, providerVar, prefix ? '' : 'anthropic');
  if (!raw) return null;
  const provider = parseProviderName(raw, providerVar);
  const model = str(env, prefix ? 'FALLBACK_MODEL_NAME' : 'MODEL_NAME', DEFAULT_MODELS[provider]);
  const apiKey = str(env, prefix ? 'SCOUT_FALLBACK_API_KEY' : 'SCOUT_MODEL_API_KEY');
  const baseUrl = str(env, prefix ? 'FALLBACK_BASE_URL' : 'MODEL_BASE_URL', DEFAULT_BASE_URLS[provider]).replace(/\/+$/, '');
  const effort = str(env, prefix ? 'FALLBACK_EFFORT' : 'MODEL_EFFORT').toLowerCase();
  if (effort && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
    throw new ConfigError(`${prefix}MODEL_EFFORT must be low, medium, high, xhigh or max.`);
  }
  if (provider === 'openai-compatible' && !baseUrl) {
    throw new ConfigError(`${prefix ? 'FALLBACK_BASE_URL' : 'MODEL_BASE_URL'} is required when the provider is openai-compatible.`);
  }
  if (provider === 'openai-compatible' && !model) {
    throw new ConfigError(`${prefix ? 'FALLBACK_MODEL_NAME' : 'MODEL_NAME'} is required when the provider is openai-compatible.`);
  }
  return { provider, model, apiKey, baseUrl, effort };
}

export function loadConfig(env: Env = process.env): Config {
  const dataDir = path.resolve(str(env, 'DATA_DIR', './data'));
  const port = int(env, 'PORT', 3000, 1, 65535);
  const databaseUrl = str(env, 'DATABASE_URL');
  const primary = providerSettings(env, '');
  if (!primary) throw new ConfigError('MODEL_PROVIDER is missing.');
  return {
    env: str(env, 'NODE_ENV', 'development'),
    port,
    host: str(env, 'HOST', '0.0.0.0'),
    publicUrl: str(env, 'PUBLIC_URL', `http://localhost:${port}`).replace(/\/+$/, ''),
    trustProxy: bool(env, 'TRUST_PROXY', true),
    logLevel: str(env, 'LOG_LEVEL', 'info'),
    dataDir,
    databaseUrl,
    databaseSslNoVerify: bool(env, 'DATABASE_SSL_NO_VERIFY', false),
    sqlitePath: str(env, 'SQLITE_PATH', path.join(dataDir, 'scout.db')),
    encryptionKey: str(env, 'SCOUT_ENCRYPTION_KEY'),
    adminPassword: str(env, 'ADMIN_PASSWORD'),
    defaultAgentName: str(env, 'AGENT_NAME', 'Scout').slice(0, 40),
    primary,
    fallback: providerSettings(env, 'FALLBACK_'),
    maxOutputTokens: int(env, 'MODEL_MAX_OUTPUT_TOKENS', 8000, 256, 64000),
    modelTimeoutMs: int(env, 'MODEL_TIMEOUT_MS', 60_000, 1000, 600_000),
    modelMaxRetries: int(env, 'MODEL_MAX_RETRIES', 3, 0, 8),
    toolTimeoutMs: int(env, 'TOOL_TIMEOUT_MS', 15_000, 100, 120_000),
    agentTimeoutMs: int(env, 'AGENT_TIMEOUT_MS', 120_000, 1000, 900_000),
    agentMaxSteps: int(env, 'AGENT_MAX_STEPS', 6, 1, 20),
    maxMessageChars: int(env, 'MAX_MESSAGE_CHARS', 4000, 100, 20_000),
    summaryTriggerMessages: int(env, 'SUMMARY_TRIGGER_MESSAGES', 24, 6, 500),
    summaryTriggerChars: int(env, 'SUMMARY_TRIGGER_CHARS', 24_000, 2000, 500_000),
    summaryKeepMessages: int(env, 'SUMMARY_KEEP_MESSAGES', 8, 2, 100),
    staleDataDays: int(env, 'STALE_DATA_DAYS', 7, 1, 365),
    pendingActionTtlMs: int(env, 'PENDING_ACTION_TTL_SECONDS', 600, 30, 86_400) * 1000,
    publicPerIpLimitPerMin: int(env, 'PUBLIC_PER_IP_LIMIT_PER_MIN', 20, 1, 10_000),
    defaultRateLimitPerMin: int(env, 'DEFAULT_RATE_LIMIT_PER_MIN', 60, 1, 100_000),
    defaultMonthlyTokenBudget: int(env, 'DEFAULT_MONTHLY_TOKEN_BUDGET', 2_000_000, 0),
    webhookAllowHttp: bool(env, 'WEBHOOK_ALLOW_HTTP', false),
    webhookTimeoutMs: int(env, 'WEBHOOK_TIMEOUT_MS', 8000, 500, 15_000),
    webhookMaxResponseBytes: int(env, 'WEBHOOK_MAX_RESPONSE_BYTES', 65_536, 1024, 1_048_576),
    priceInputPerM: num(env, 'MODEL_PRICE_INPUT_PER_M'),
    priceOutputPerM: num(env, 'MODEL_PRICE_OUTPUT_PER_M'),
  };
}
