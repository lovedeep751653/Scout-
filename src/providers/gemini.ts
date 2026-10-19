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
  type ToolCall,
} from './types.ts';

// REST shapes follow the official Gemini API discovery document (v1beta):
// Content{role,parts}, Part{text|functionCall|functionResponse, thoughtSignature},
// FunctionDeclaration{name,description,parametersJsonSchema}.
interface GPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
}
interface GContent {
  role: 'user' | 'model';
  parts: GPart[];
}
interface GResponse {
  candidates?: Array<{ content?: { parts?: GPart[] }; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  modelVersion?: string;
  error?: { message?: string; code?: number };
}

const THINKING_LEVELS: Record<string, string> = { low: 'LOW', medium: 'MEDIUM', high: 'HIGH', xhigh: 'HIGH', max: 'HIGH' };
const REFUSAL_REASONS = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT']);

function lastUserTextIndex(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user' && m.parts.some((p) => p.type === 'text')) return i;
  }
  return 0;
}

function parseToolContent(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

// Gemini checks thought signatures on function calls in the current turn. Calls made by
// another provider (after a fallback) have none, so they are replayed as plain text.
export function toGeminiContents(messages: Message[]): GContent[] {
  const turnStart = lastUserTextIndex(messages);
  const asText = new Set<string>();
  const callMeta = new Map<string, ToolCall>();
  const out: GContent[] = [];

  messages.forEach((m, index) => {
    const parts: GPart[] = [];
    for (const p of m.parts) {
      if (p.type === 'text') {
        if (p.text || p.meta?.thoughtSignature) {
          parts.push({ text: p.text, ...(p.meta?.thoughtSignature ? { thoughtSignature: p.meta.thoughtSignature } : {}) });
        }
      } else if (p.type === 'tool_call') {
        callMeta.set(p.call.id, p.call);
        if (index >= turnStart && !p.call.meta?.thoughtSignature) {
          asText.add(p.call.id);
          parts.push({ text: `[I called the tool ${p.call.name} with ${JSON.stringify(p.call.args)}]` });
        } else {
          parts.push({
            functionCall: { ...(p.call.meta?.gid ? { id: p.call.meta.gid } : {}), name: p.call.name, args: p.call.args },
            ...(p.call.meta?.thoughtSignature ? { thoughtSignature: p.call.meta.thoughtSignature } : {}),
          });
        }
      } else if (p.type === 'tool_result') {
        if (asText.has(p.callId)) {
          parts.push({ text: `[Result of ${p.name}${p.isError ? ' (error)' : ''}]: ${p.content}` });
        } else {
          const gid = callMeta.get(p.callId)?.meta?.gid;
          parts.push({
            functionResponse: {
              ...(gid ? { id: gid } : {}),
              name: p.name,
              response: p.isError ? { error: parseToolContent(p.content) } : { output: parseToolContent(p.content) },
            },
          });
        }
      }
    }
    if (parts.length === 0) return;
    const role = m.role === 'assistant' ? 'model' : 'user';
    const prev = out[out.length - 1];
    if (prev && prev.role === role) prev.parts.push(...parts);
    else out.push({ role, parts });
  });
  return out;
}

function mapFinish(reason: string | undefined, hasCalls: boolean, blocked: boolean): StopReason {
  if (blocked) return 'refusal';
  if (hasCalls) return 'tool_use';
  if (!reason || reason === 'STOP') return 'end';
  if (reason === 'MAX_TOKENS') return 'max_tokens';
  if (REFUSAL_REASONS.has(reason)) return 'refusal';
  return 'other';
}

function retryDelayFromBody(body: unknown): number | undefined {
  const details = (body as { error?: { details?: Array<Record<string, unknown>> } } | undefined)?.error?.details;
  if (!Array.isArray(details)) return undefined;
  for (const d of details) {
    const type = String(d['@type'] ?? '');
    const delay = d['retryDelay'];
    if (type.endsWith('RetryInfo') && typeof delay === 'string') {
      const secs = Number.parseFloat(delay);
      if (Number.isFinite(secs)) return secs * 1000;
    }
  }
  return undefined;
}

class Accumulator {
  parts: Part[] = [];
  finishReason: string | undefined;
  blocked = false;
  usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  model: string;

  constructor(model: string) {
    this.model = model;
  }

  // Returns any new visible text so streaming can forward it.
  add(chunk: GResponse): string {
    if (chunk.error) throw new ProviderError('server', 'gemini', `Gemini error: ${chunk.error.message ?? 'unknown'}`);
    if (chunk.promptFeedback?.blockReason) this.blocked = true;
    if (chunk.modelVersion) this.model = chunk.modelVersion;
    const u = chunk.usageMetadata;
    if (u) {
      this.usage = {
        inputTokens: u.promptTokenCount ?? this.usage.inputTokens,
        outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) || this.usage.outputTokens,
        cachedInputTokens: u.cachedContentTokenCount ?? this.usage.cachedInputTokens,
      };
    }
    const cand = chunk.candidates?.[0];
    if (cand?.finishReason) this.finishReason = cand.finishReason;
    let visible = '';
    for (const gp of cand?.content?.parts ?? []) {
      if (gp.thought) continue;
      if (gp.functionCall) {
        const meta: Record<string, string> = {};
        if (gp.functionCall.id) meta.gid = gp.functionCall.id;
        if (gp.thoughtSignature) meta.thoughtSignature = gp.thoughtSignature;
        this.parts.push({
          type: 'tool_call',
          call: {
            id: gp.functionCall.id || newId('call'),
            name: gp.functionCall.name,
            args: gp.functionCall.args ?? {},
            ...(Object.keys(meta).length ? { meta } : {}),
          },
        });
      } else if (typeof gp.text === 'string' || gp.thoughtSignature) {
        const text = gp.text ?? '';
        visible += text;
        const last = this.parts[this.parts.length - 1];
        if (last && last.type === 'text' && !last.meta?.thoughtSignature) {
          last.text += text;
          if (gp.thoughtSignature) last.meta = { thoughtSignature: gp.thoughtSignature };
        } else {
          this.parts.push({ type: 'text', text, ...(gp.thoughtSignature ? { meta: { thoughtSignature: gp.thoughtSignature } } : {}) });
        }
      }
    }
    return visible;
  }

  result(): GenerateResult {
    const toolCalls = this.parts.flatMap((p) => (p.type === 'tool_call' ? [p.call] : []));
    return {
      text: this.parts.map((p) => (p.type === 'text' ? p.text : '')).join(''),
      toolCalls,
      message: { role: 'assistant', parts: this.parts },
      stopReason: mapFinish(this.finishReason, toolCalls.length > 0, this.blocked),
      usage: this.usage,
      provider: 'gemini',
      model: this.model,
    };
  }
}

export class GeminiProvider implements ModelProvider {
  readonly name = 'gemini';
  readonly model: string;
  private readonly settings: ProviderSettings;
  private readonly timeoutMs: number;
  private readonly maxOutputTokens: number;

  constructor(settings: ProviderSettings, opts: { timeoutMs: number; maxOutputTokens: number }) {
    this.settings = settings;
    this.model = settings.model;
    this.timeoutMs = opts.timeoutMs;
    this.maxOutputTokens = opts.maxOutputTokens;
  }

  private body(req: GenerateRequest): Record<string, unknown> {
    const tools = req.tools ?? [];
    const level = THINKING_LEVELS[this.settings.effort];
    return {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: toGeminiContents(req.messages),
      ...(tools.length
        ? {
            tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.inputSchema })) }],
            toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
          }
        : {}),
      generationConfig: {
        maxOutputTokens: req.maxTokens ?? this.maxOutputTokens,
        ...(level ? { thinkingConfig: { thinkingLevel: level } } : {}),
      },
    };
  }

  private url(method: 'generateContent' | 'streamGenerateContent'): string {
    const model = this.model.startsWith('models/') ? this.model : `models/${this.model}`;
    const base = `${this.settings.baseUrl}/v1beta/${model}:${method}`;
    return method === 'streamGenerateContent' ? `${base}?alt=sse` : base;
  }

  private call(req: GenerateRequest, method: 'generateContent' | 'streamGenerateContent'): Promise<Response> {
    return postJson({
      provider: 'gemini',
      url: this.url(method),
      headers: { 'x-goog-api-key': this.settings.apiKey },
      body: this.body(req),
      timeoutMs: this.timeoutMs,
      signal: req.signal,
      retryAfterFromBody: retryDelayFromBody,
    });
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const res = await this.call(req, 'generateContent');
    const acc = new Accumulator(this.model);
    try {
      acc.add((await res.json()) as GResponse);
    } catch (err) {
      throw wrapStreamError('gemini', err, req.signal);
    }
    return acc.result();
  }

  async *stream(req: GenerateRequest): AsyncIterable<StreamEvent> {
    const res = await this.call(req, 'streamGenerateContent');
    const acc = new Accumulator(this.model);
    try {
      for await (const ev of parseSse(res.body as unknown as AsyncIterable<Uint8Array>)) {
        if (!ev.data) continue;
        const visible = acc.add(JSON.parse(ev.data) as GResponse);
        if (visible) yield { type: 'text', text: visible };
      }
    } catch (err) {
      throw wrapStreamError('gemini', err, req.signal);
    }
    yield { type: 'done', result: acc.result() };
  }
}
