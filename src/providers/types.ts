export interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: Array<string | number | boolean | null>;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  format?: string;
  default?: unknown;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  // Provider-specific data that must be sent back unchanged (e.g. Gemini thought signatures).
  meta?: Record<string, string>;
}

export type Part =
  | { type: 'text'; text: string; meta?: Record<string, string> }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'tool_result'; callId: string; name: string; content: string; isError?: boolean }
  // Opaque blocks only valid inside one agent run (e.g. Claude thinking blocks). Never stored.
  | { type: 'provider_raw'; provider: string; data: unknown };

export interface Message {
  role: 'user' | 'assistant';
  parts: Part[];
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface GenerateRequest {
  system: string;
  messages: Message[];
  tools?: ToolSpec[];
  // 'none' makes the model answer in text without calling tools (used on the last step).
  toolChoice?: 'auto' | 'none';
  maxTokens?: number;
  signal?: AbortSignal;
}

export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export interface Usage {
  // Total prompt tokens, including any served from or written to a prompt cache.
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
}

export interface GenerateResult {
  text: string;
  toolCalls: ToolCall[];
  // The assistant turn exactly as it must be replayed to this provider.
  message: Message;
  stopReason: StopReason;
  usage: Usage;
  provider: string;
  model: string;
}

export type StreamEvent = { type: 'text'; text: string } | { type: 'done'; result: GenerateResult };

export interface ModelProvider {
  readonly name: string;
  readonly model: string;
  generate(req: GenerateRequest): Promise<GenerateResult>;
  stream(req: GenerateRequest): AsyncIterable<StreamEvent>;
}

export type ProviderErrorKind =
  | 'rate_limit'
  | 'overloaded'
  | 'server'
  | 'network'
  | 'timeout'
  | 'auth'
  | 'bad_request'
  | 'not_found'
  | 'aborted';

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly provider: string;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(kind: ProviderErrorKind, provider: string, message: string, opts: { status?: number; retryAfterMs?: number; cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.name = 'ProviderError';
    this.kind = kind;
    this.provider = provider;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
  }

  get retryable(): boolean {
    return ['rate_limit', 'overloaded', 'server', 'network', 'timeout'].includes(this.kind);
  }
}

export function kindFromStatus(status: number): ProviderErrorKind {
  if (status === 429) return 'rate_limit';
  if (status === 529 || status === 503) return 'overloaded';
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 408) return 'timeout';
  if (status >= 500) return 'server';
  return 'bad_request';
}

export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return undefined;
}

export function textOf(parts: Part[]): string {
  return parts
    .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('');
}
