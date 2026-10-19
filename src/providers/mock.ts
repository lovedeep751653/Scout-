import { newId } from '../security/crypto.ts';
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

export interface MockReply {
  text?: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  stopReason?: StopReason;
  error?: ProviderError;
  delayMs?: number;
}

export type MockScript = (req: GenerateRequest, callIndex: number) => MockReply | Promise<MockReply>;

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function lastUser(messages: Message[]): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === 'user') return messages[i];
  return undefined;
}

// Works without any AI key: picks a tool from simple keywords and words the answer
// from tool results, so the whole agent loop can be tried for free.
export const defaultMockScript: MockScript = (req) => {
  if (req.system.startsWith('You write short memory summaries')) {
    return { text: 'Summary: earlier the user chatted with the assistant about their accounts.' };
  }
  const user = lastUser(req.messages);
  const results = user?.parts.filter((p): p is Extract<Part, { type: 'tool_result' }> => p.type === 'tool_result') ?? [];
  if (results.length > 0) {
    const lines = results.map((r) => {
      try {
        const parsed = JSON.parse(r.content) as { untrusted_data?: Record<string, unknown>; status?: string; summary?: string };
        const data = parsed.untrusted_data ?? parsed;
        if ((data as { status?: string }).status === 'needs_confirmation') {
          return `Please confirm: ${(data as { summary?: string }).summary ?? r.name}. Press Confirm to continue.`;
        }
        return `${r.name}: ${JSON.stringify(data).slice(0, 300)}`;
      } catch {
        return `${r.name}: ${r.content.slice(0, 300)}`;
      }
    });
    return { text: `Here is what I found (mock AI):\n${lines.join('\n')}` };
  }
  const text = user?.parts.map((p) => (p.type === 'text' ? p.text : '')).join(' ') ?? '';
  const tools = new Set((req.tools ?? []).map((t) => t.name));
  const lower = text.toLowerCase();
  if (tools.has('current_datetime') && /(time|date|samay|kitne baje|aaj|समय|तारीख)/.test(lower)) {
    return { toolCalls: [{ name: 'current_datetime', args: {} }] };
  }
  const note = /(?:remember|note|yaad rakh(?:na|o)?)\s*(?:that|:)?\s*(.+)/i.exec(text);
  if (tools.has('remember_note') && note?.[1]) {
    return { toolCalls: [{ name: 'remember_note', args: { text: note[1].slice(0, 200) } }] };
  }
  if (tools.has('list_notes') && /(my notes|what did i tell you|notes dikhao)/.test(lower)) {
    return { toolCalls: [{ name: 'list_notes', args: {} }] };
  }
  return { text: `Mock reply (no AI key is set yet). You said: "${text.slice(0, 200)}"` };
};

export class MockProvider implements ModelProvider {
  readonly name = 'mock';
  readonly model: string;
  readonly requests: GenerateRequest[] = [];
  private readonly script: MockScript;

  constructor(opts: { model?: string; script?: MockScript } = {}) {
    this.model = opts.model ?? 'mock-1';
    this.script = opts.script ?? defaultMockScript;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const index = this.requests.length;
    this.requests.push(req);
    const reply = await this.script(req, index);
    if (reply.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, reply.delayMs);
        req.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new ProviderError('aborted', this.name, 'Request was cancelled.'));
        });
      });
    }
    if (reply.error) throw reply.error;
    const parts: Part[] = [];
    if (reply.text) parts.push({ type: 'text', text: reply.text });
    for (const c of reply.toolCalls ?? []) parts.push({ type: 'tool_call', call: { id: newId('call'), name: c.name, args: c.args } });
    const toolCalls = parts.flatMap((p) => (p.type === 'tool_call' ? [p.call] : []));
    const promptChars = req.system.length + JSON.stringify(req.messages).length + JSON.stringify(req.tools ?? []).length;
    return {
      text: reply.text ?? '',
      toolCalls,
      message: { role: 'assistant', parts },
      stopReason: reply.stopReason ?? (toolCalls.length ? 'tool_use' : 'end'),
      usage: { inputTokens: Math.max(1, Math.ceil(promptChars / 4)), outputTokens: estimateTokens(reply.text ?? 'x') },
      provider: this.name,
      model: this.model,
    };
  }

  async *stream(req: GenerateRequest): AsyncIterable<StreamEvent> {
    const result = await this.generate(req);
    for (let i = 0; i < result.text.length; i += 12) yield { type: 'text', text: result.text.slice(i, i + 12) };
    yield { type: 'done', result };
  }
}
