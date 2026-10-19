import Anthropic from '@anthropic-ai/sdk';
import type { ProviderSettings } from '../config.ts';
import {
  kindFromStatus,
  parseRetryAfter,
  ProviderError,
  type GenerateRequest,
  type GenerateResult,
  type Message,
  type ModelProvider,
  type Part,
  type StopReason,
  type StreamEvent,
} from './types.ts';

type Effort = NonNullable<NonNullable<Anthropic.MessageCreateParams['output_config']>['effort']>;

export interface AnthropicOptions {
  timeoutMs: number;
  maxOutputTokens: number;
}

function toBlocks(parts: Part[]): Anthropic.ContentBlockParam[] {
  const blocks: Anthropic.ContentBlockParam[] = [];
  for (const p of parts) {
    if (p.type === 'text') {
      if (p.text) blocks.push({ type: 'text', text: p.text });
    } else if (p.type === 'tool_call') {
      blocks.push({ type: 'tool_use', id: p.call.id, name: p.call.name, input: p.call.args });
    } else if (p.type === 'tool_result') {
      blocks.push({ type: 'tool_result', tool_use_id: p.callId, content: p.content, is_error: p.isError ?? false });
    } else if (p.type === 'provider_raw' && p.provider === 'anthropic') {
      blocks.push(p.data as Anthropic.ContentBlockParam);
    }
  }
  return blocks;
}

export function toAnthropicMessages(messages: Message[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    const blocks = toBlocks(m.parts);
    if (blocks.length === 0) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role && Array.isArray(prev.content)) {
      prev.content.push(...blocks);
    } else {
      out.push({ role: m.role, content: blocks });
    }
  }
  return out;
}

function mapStop(reason: Anthropic.StopReason | null): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'other';
  }
}

export function fromAnthropicMessage(msg: Anthropic.Message, provider: string): GenerateResult {
  const parts: Part[] = [];
  let text = '';
  for (const block of msg.content) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text });
      text += block.text;
    } else if (block.type === 'tool_use') {
      const args = block.input && typeof block.input === 'object' ? (block.input as Record<string, unknown>) : {};
      parts.push({ type: 'tool_call', call: { id: block.id, name: block.name, args } });
    } else if (block.type === 'thinking') {
      parts.push({ type: 'provider_raw', provider: 'anthropic', data: { type: 'thinking', thinking: block.thinking, signature: block.signature } });
    } else if (block.type === 'redacted_thinking') {
      parts.push({ type: 'provider_raw', provider: 'anthropic', data: { type: 'redacted_thinking', data: block.data } });
    }
  }
  const cached = msg.usage.cache_read_input_tokens ?? 0;
  const written = msg.usage.cache_creation_input_tokens ?? 0;
  return {
    text,
    toolCalls: parts.flatMap((p) => (p.type === 'tool_call' ? [p.call] : [])),
    message: { role: 'assistant', parts },
    stopReason: mapStop(msg.stop_reason),
    usage: {
      inputTokens: msg.usage.input_tokens + cached + written,
      outputTokens: msg.usage.output_tokens,
      cachedInputTokens: cached,
      cacheWriteTokens: written,
    },
    provider,
    model: msg.model,
  };
}

export function mapAnthropicError(err: unknown): ProviderError {
  const name = 'anthropic';
  if (err instanceof ProviderError) return err;
  if (err instanceof Anthropic.APIUserAbortError) return new ProviderError('aborted', name, 'Request was cancelled.', { cause: err });
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new ProviderError('timeout', name, 'Claude did not answer in time.', { cause: err });
  if (err instanceof Anthropic.APIConnectionError) return new ProviderError('network', name, 'Could not reach Claude.', { cause: err });
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === 'number' ? err.status : 0;
    const kind = err.type === 'overloaded_error' ? 'overloaded' : kindFromStatus(status);
    return new ProviderError(kind, name, `Claude API error ${status}: ${err.message}`, {
      status,
      retryAfterMs: parseRetryAfter(err.headers?.get('retry-after')),
      cause: err,
    });
  }
  if (err instanceof Error && err.name === 'AbortError') return new ProviderError('aborted', name, 'Request was cancelled.', { cause: err });
  return new ProviderError('server', name, err instanceof Error ? err.message : String(err), { cause: err });
}

export class AnthropicProvider implements ModelProvider {
  readonly name = 'anthropic';
  readonly model: string;
  private readonly client: Anthropic;
  private readonly effort: Effort | undefined;
  private readonly maxOutputTokens: number;

  constructor(settings: ProviderSettings, opts: AnthropicOptions) {
    this.model = settings.model;
    this.effort = (settings.effort || undefined) as Effort | undefined;
    this.maxOutputTokens = opts.maxOutputTokens;
    this.client = new Anthropic({
      apiKey: settings.apiKey || 'missing-key',
      authToken: null,
      baseURL: settings.baseUrl || undefined,
      maxRetries: 0,
      timeout: opts.timeoutMs,
    });
  }

  private params(req: GenerateRequest): Anthropic.MessageCreateParamsNonStreaming {
    return {
      model: this.model,
      max_tokens: req.maxTokens ?? this.maxOutputTokens,
      system: req.system,
      messages: toAnthropicMessages(req.messages),
      cache_control: { type: 'ephemeral' },
      ...(req.tools && req.tools.length > 0
        ? {
            tools: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
            })),
            ...(req.toolChoice === 'none' ? { tool_choice: { type: 'none' as const } } : {}),
          }
        : {}),
      ...(this.effort ? { output_config: { effort: this.effort } } : {}),
    };
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    try {
      const msg = await this.client.messages.create(this.params(req), { signal: req.signal });
      return fromAnthropicMessage(msg, this.name);
    } catch (err) {
      throw mapAnthropicError(err);
    }
  }

  async *stream(req: GenerateRequest): AsyncIterable<StreamEvent> {
    let stream: ReturnType<Anthropic['messages']['stream']> | undefined;
    let finished = false;
    try {
      stream = this.client.messages.stream(this.params(req), { signal: req.signal });
      for await (const ev of stream) {
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta' && ev.delta.text) {
          yield { type: 'text', text: ev.delta.text };
        }
      }
      const final = await stream.finalMessage();
      finished = true;
      yield { type: 'done', result: fromAnthropicMessage(final, this.name) };
    } catch (err) {
      finished = true;
      throw mapAnthropicError(err);
    } finally {
      if (!finished) stream?.abort();
    }
  }
}
