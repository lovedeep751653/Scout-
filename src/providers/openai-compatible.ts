import type { ProviderSettings } from '../config.ts';
import { newId } from '../security/crypto.ts';
import { postJson, wrapStreamError } from './http.ts';
import { parseSse } from './sse.ts';
import {
  ProviderError,
  type GenerateRequest,
  type GenerateResult,
  type Message,
  type ModelProvider,
  type Part,
  type StopReason,
  type StreamEvent,
} from './types.ts';

// Request/response shapes follow the OpenAI Chat Completions spec (openai/openai-openapi),
// which Groq and OpenRouter implement.
type OAMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: OAToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

interface OAToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OAChoice {
  message?: { content?: string | null; tool_calls?: OAToolCall[] };
  delta?: { content?: string | null; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> };
  finish_reason?: string | null;
}

interface OAResponse {
  model?: string;
  choices?: OAChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | null;
  error?: { message?: string; code?: number | string };
}

export function toOpenAiMessages(system: string, messages: Message[]): OAMessage[] {
  const out: OAMessage[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') {
      const text = m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
      for (const p of m.parts) {
        if (p.type === 'tool_result') out.push({ role: 'tool', tool_call_id: p.callId, content: p.isError ? `ERROR: ${p.content}` : p.content });
      }
      if (text) out.push({ role: 'user', content: text });
    } else {
      const text = m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
      const calls: OAToolCall[] = m.parts.flatMap((p) =>
        p.type === 'tool_call' ? [{ id: p.call.id, type: 'function' as const, function: { name: p.call.name, arguments: JSON.stringify(p.call.args) } }] : [],
      );
      if (!text && calls.length === 0) continue;
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    }
  }
  return out;
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : { __invalid_arguments: raw };
  } catch {
    return { __invalid_arguments: raw.slice(0, 500) };
  }
}

function mapFinish(reason: string | null | undefined, hasCalls: boolean): StopReason {
  if (hasCalls) return 'tool_use';
  if (!reason || reason === 'stop') return 'end';
  if (reason === 'length') return 'max_tokens';
  if (reason === 'content_filter') return 'refusal';
  if (reason === 'tool_calls' || reason === 'function_call') return 'tool_use';
  return 'other';
}

export class OpenAiCompatibleProvider implements ModelProvider {
  readonly name: string;
  readonly model: string;
  private readonly settings: ProviderSettings;
  private readonly timeoutMs: number;
  private readonly maxOutputTokens: number;
  private readonly publicUrl: string;

  constructor(settings: ProviderSettings, opts: { timeoutMs: number; maxOutputTokens: number; publicUrl: string }) {
    this.settings = settings;
    this.name = settings.provider;
    this.model = settings.model;
    this.timeoutMs = opts.timeoutMs;
    this.maxOutputTokens = opts.maxOutputTokens;
    this.publicUrl = opts.publicUrl;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.settings.apiKey) h.authorization = `Bearer ${this.settings.apiKey}`;
    if (this.settings.provider === 'openrouter') {
      h['HTTP-Referer'] = this.publicUrl;
      h['X-Title'] = 'Scout';
    }
    return h;
  }

  private body(req: GenerateRequest, stream: boolean): Record<string, unknown> {
    // Some local runtimes ignore tool_choice "none", so the tools are simply not sent.
    const tools = req.toolChoice === 'none' ? [] : (req.tools ?? []);
    const maxField = /(^|\.)api\.openai\.com$/i.test(new URL(this.settings.baseUrl).hostname) ? 'max_completion_tokens' : 'max_tokens';
    return {
      model: this.model,
      messages: toOpenAiMessages(req.system, req.messages),
      [maxField]: req.maxTokens ?? this.maxOutputTokens,
      ...(tools.length
        ? {
            tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
            tool_choice: 'auto',
          }
        : {}),
      ...(this.settings.reasoningEffort ? { reasoning_effort: this.settings.reasoningEffort } : {}),
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    };
  }

  private call(req: GenerateRequest, stream: boolean): Promise<Response> {
    return postJson({
      provider: this.name,
      url: `${this.settings.baseUrl}/chat/completions`,
      headers: this.headers(),
      body: this.body(req, stream),
      timeoutMs: this.timeoutMs,
      signal: req.signal,
    });
  }

  private build(text: string, calls: Array<{ id: string; name: string; arguments: string }>, finish: string | null | undefined, data: OAResponse): GenerateResult {
    const parts: Part[] = [];
    if (text) parts.push({ type: 'text', text });
    for (const c of calls) parts.push({ type: 'tool_call', call: { id: c.id || newId('call'), name: c.name, args: parseArgs(c.arguments) } });
    const toolCalls = parts.flatMap((p) => (p.type === 'tool_call' ? [p.call] : []));
    const cached = data.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    return {
      text,
      toolCalls,
      message: { role: 'assistant', parts },
      stopReason: mapFinish(finish, toolCalls.length > 0),
      usage: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0, cachedInputTokens: cached },
      provider: this.name,
      model: data.model ?? this.model,
    };
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const res = await this.call(req, false);
    let data: OAResponse;
    try {
      data = (await res.json()) as OAResponse;
    } catch (err) {
      throw wrapStreamError(this.name, err, req.signal);
    }
    if (data.error) throw new ProviderError('server', this.name, `${this.name} error: ${data.error.message ?? 'unknown'}`);
    const choice = data.choices?.[0];
    const calls = (choice?.message?.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments ?? '' }));
    return this.build(choice?.message?.content ?? '', calls, choice?.finish_reason, data);
  }

  async *stream(req: GenerateRequest): AsyncIterable<StreamEvent> {
    const res = await this.call(req, true);
    let text = '';
    let finish: string | null | undefined;
    const calls: Array<{ id: string; name: string; arguments: string }> = [];
    let last: OAResponse = {};
    try {
      for await (const ev of parseSse(res.body as unknown as AsyncIterable<Uint8Array>)) {
        const raw = ev.data.trim();
        if (!raw) continue;
        if (raw === '[DONE]') break;
        const chunk = JSON.parse(raw) as OAResponse;
        if (chunk.error) throw new ProviderError('server', this.name, `${this.name} error: ${chunk.error.message ?? 'unknown'}`);
        if (chunk.usage) last = { ...last, usage: chunk.usage };
        if (chunk.model) last = { ...last, model: chunk.model };
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finish = choice.finish_reason;
        const delta = choice.delta;
        if (delta?.content) {
          text += delta.content;
          yield { type: 'text', text: delta.content };
        }
        for (const tc of delta?.tool_calls ?? []) {
          const slot = (calls[tc.index] ??= { id: '', name: '', arguments: '' });
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name += tc.function.name;
          if (tc.function?.arguments) slot.arguments += tc.function.arguments;
        }
      }
    } catch (err) {
      throw wrapStreamError(this.name, err, req.signal);
    }
    yield { type: 'done', result: this.build(text, calls.filter(Boolean), finish, last) };
  }
}
