import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import type { ProviderSettings } from '../src/config.ts';
import { AnthropicProvider } from '../src/providers/anthropic.ts';
import { GeminiProvider } from '../src/providers/gemini.ts';
import { createModelStack } from '../src/providers/index.ts';
import { OpenAiCompatibleProvider } from '../src/providers/openai-compatible.ts';
import { FallbackProvider, RetryingProvider } from '../src/providers/resilience.ts';
import { parseSse, type SseEvent } from '../src/providers/sse.ts';
import {
  kindFromStatus,
  parseRetryAfter,
  ProviderError,
  type GenerateRequest,
  type GenerateResult,
  type Message,
  type ModelProvider,
  type StreamEvent,
  type ToolCall,
  type ToolSpec,
} from '../src/providers/types.ts';
import { testConfig } from './helpers.ts';

// =====================================================================
// helpers: fake HTTP servers, requests, stream draining
// =====================================================================

// Bodies are parsed JSON from the wire, so they are loosely typed on purpose.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

interface Seen {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Json;
}

type Handler = (req: Seen, res: http.ServerResponse, index: number) => void | Promise<void>;

interface FakeServer {
  origin: string;
  port: number;
  seen: Seen[];
  close(): Promise<void>;
}

async function startServer(handler: Handler): Promise<FakeServer> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: Json = raw;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      const s: Seen = { method: req.method ?? '', path: req.url ?? '', headers: req.headers, body };
      seen.push(s);
      Promise.resolve(handler(s, res, seen.length - 1)).catch((err: unknown) => res.destroy(err as Error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// A port on 127.0.0.1 that nothing listens on.
async function deadPort(): Promise<number> {
  const srv = await startServer(() => {});
  await srv.close();
  return srv.port;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Writes each string as its own write (with a short pause so they tend to arrive as
// separate TCP chunks), then ends the response.
async function sendSse(res: http.ServerResponse, pieces: string[]): Promise<void> {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const p of pieces) {
    res.write(p);
    await pause(3);
  }
  res.end();
}

const TOOLS: ToolSpec[] = [
  {
    name: 'get_weather',
    description: 'Current weather for a city',
    inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
];

const USER_Q: Message = { role: 'user', parts: [{ type: 'text', text: 'Weather in Pune?' }] };

function request(over: Partial<GenerateRequest> = {}): GenerateRequest {
  return { system: 'You are Scout.', messages: [USER_Q], tools: TOOLS, ...over };
}

async function drain(it: AsyncIterable<StreamEvent>): Promise<{ texts: string[]; result: GenerateResult; events: StreamEvent[] }> {
  const texts: string[] = [];
  const events: StreamEvent[] = [];
  let result: GenerateResult | undefined;
  for await (const ev of it) {
    events.push(ev);
    if (ev.type === 'text') texts.push(ev.text);
    else result = ev.result;
  }
  assert.ok(result, 'the stream ended without a done event');
  return { texts, result, events };
}

async function providerError(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof ProviderError, `expected a ProviderError, got: ${String(err)}`);
    return err;
  }
  assert.fail('expected the call to fail with a ProviderError');
}

// =====================================================================
// OpenAI-compatible (Ollama, Groq, OpenRouter, ...)
// =====================================================================

const OA_OPTS = { timeoutMs: 5000, maxOutputTokens: 256, publicUrl: 'https://scout.test' };

function oaSettings(origin: string, over: Partial<ProviderSettings> = {}): ProviderSettings {
  return { provider: 'ollama', model: 'qwen-test', apiKey: '', baseUrl: `${origin}/v1`, effort: '', reasoningEffort: '', ...over };
}

function oaToolCallResponse(args: string, over: Record<string, unknown> = {}) {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    model: 'qwen-test-served',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_abc', type: 'function', function: { name: 'get_weather', arguments: args } }] },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 50, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 8 } },
    ...over,
  };
}

function oaText(text: string, finish = 'stop') {
  return { model: 'qwen-test', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: finish }], usage: { prompt_tokens: 5, completion_tokens: 2 } };
}

test('OpenAI-compatible: a non-streaming reply with tool_calls parses the JSON-string arguments into toolCalls', async (t) => {
  const srv = await startServer((_req, res) => sendJson(res, 200, oaToolCallResponse('{"city":"Pune","units":"metric"}')));
  t.after(() => srv.close());
  const provider = new OpenAiCompatibleProvider(oaSettings(srv.origin), OA_OPTS);

  const result = await provider.generate(request());

  const call = { id: 'call_abc', name: 'get_weather', args: { city: 'Pune', units: 'metric' } };
  assert.deepEqual(result.toolCalls, [call]);
  assert.deepEqual(result.message, { role: 'assistant', parts: [{ type: 'tool_call', call }] });
  assert.equal(result.text, '');
  assert.equal(result.stopReason, 'tool_use');
  assert.deepEqual(result.usage, { inputTokens: 50, outputTokens: 12, cachedInputTokens: 8 });
  assert.equal(result.provider, 'ollama');
  assert.equal(result.model, 'qwen-test-served');
  assert.equal(srv.seen.length, 1);
  assert.equal(srv.seen[0]!.method, 'POST');
  assert.equal(srv.seen[0]!.path, '/v1/chat/completions');
  assert.equal(srv.seen[0]!.body.model, 'qwen-test');
  assert.equal(srv.seen[0]!.body.max_tokens, 256);
  assert.equal(srv.seen[0]!.body.stream, undefined);
});

test('OpenAI-compatible: invalid or non-object tool arguments are kept under __invalid_arguments instead of throwing', async (t) => {
  const replies = ['{"city": "Pu', '[1,2]', '"just a string"', 'x'.repeat(800), '', '   '];
  const srv = await startServer((_req, res, i) => sendJson(res, 200, oaToolCallResponse(replies[i]!)));
  t.after(() => srv.close());
  const provider = new OpenAiCompatibleProvider(oaSettings(srv.origin), OA_OPTS);

  const broken = await provider.generate(request());
  assert.deepEqual(broken.toolCalls[0]!.args, { __invalid_arguments: '{"city": "Pu' });
  assert.equal(broken.toolCalls[0]!.name, 'get_weather');
  assert.equal(broken.stopReason, 'tool_use');

  assert.deepEqual((await provider.generate(request())).toolCalls[0]!.args, { __invalid_arguments: '[1,2]' });
  assert.deepEqual((await provider.generate(request())).toolCalls[0]!.args, { __invalid_arguments: '"just a string"' });

  const long = (await provider.generate(request())).toolCalls[0]!.args.__invalid_arguments;
  assert.equal(typeof long, 'string');
  assert.equal((long as string).length, 500, 'invalid arguments are capped at 500 characters');

  assert.deepEqual((await provider.generate(request())).toolCalls[0]!.args, {}, 'empty arguments mean no arguments');
  assert.deepEqual((await provider.generate(request())).toolCalls[0]!.args, {}, 'blank arguments mean no arguments');
});

test('OpenAI-compatible: a tool call without an id gets a generated call id', async (t) => {
  const reply = oaToolCallResponse('{}');
  reply.choices[0]!.message.tool_calls[0]!.id = '';
  const srv = await startServer((_req, res) => sendJson(res, 200, reply));
  t.after(() => srv.close());
  const result = await new OpenAiCompatibleProvider(oaSettings(srv.origin), OA_OPTS).generate(request());
  assert.match(result.toolCalls[0]!.id, /^call_[A-Za-z0-9]+$/);
});

test('OpenAI-compatible: streaming assembles text deltas, tool calls split across chunks and the final usage chunk', async (t) => {
  const chunk = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
  const toolDelta = (tc: unknown) => chunk({ choices: [{ index: 0, delta: { tool_calls: [tc] } }] });
  const usageChunk = chunk({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 16 } } });
  const srv = await startServer((_req, res) =>
    sendSse(res, [
      chunk({ id: 'c1', model: 'qwen-test', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }),
      chunk({ choices: [{ index: 0, delta: { content: 'Let me ' } }] }),
      chunk({ choices: [{ index: 0, delta: { content: 'check.' } }] }),
      toolDelta({ index: 0, id: 'call_w', type: 'function', function: { name: 'get_weather', arguments: '' } }),
      toolDelta({ index: 0, function: { arguments: '{"ci' } }),
      toolDelta({ index: 1, id: 'call_t', type: 'function', function: { name: 'get_time', arguments: '{}' } }),
      toolDelta({ index: 0, function: { arguments: 'ty":"Pune"}' } }),
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: null }),
      // The usage chunk arrives split over two writes.
      usageChunk.slice(0, 25),
      usageChunk.slice(25),
      'data: [DONE]\n\n',
      'data: this is not json and must never be parsed\n\n',
    ]),
  );
  t.after(() => srv.close());
  const provider = new OpenAiCompatibleProvider(oaSettings(srv.origin), OA_OPTS);

  const { texts, result, events } = await drain(provider.stream(request()));

  assert.deepEqual(texts, ['Let me ', 'check.']);
  assert.equal(events.at(-1)!.type, 'done');
  assert.equal(result.text, 'Let me check.');
  assert.deepEqual(result.toolCalls, [
    { id: 'call_w', name: 'get_weather', args: { city: 'Pune' } },
    { id: 'call_t', name: 'get_time', args: {} },
  ]);
  assert.deepEqual(result.message.parts.map((p) => p.type), ['text', 'tool_call', 'tool_call']);
  assert.equal(result.stopReason, 'tool_use');
  assert.deepEqual(result.usage, { inputTokens: 40, outputTokens: 9, cachedInputTokens: 16 });
  assert.equal(result.model, 'qwen-test');

  const body = srv.seen[0]!.body;
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
});

test('OpenAI-compatible: no Authorization header is sent when the API key is empty, and a Bearer header when it is set', async (t) => {
  const srv = await startServer((_req, res) => sendJson(res, 200, oaText('hi')));
  t.after(() => srv.close());

  await new OpenAiCompatibleProvider(oaSettings(srv.origin, { apiKey: '' }), OA_OPTS).generate(request());
  await new OpenAiCompatibleProvider(oaSettings(srv.origin, { provider: 'groq', apiKey: 'gsk_test_123' }), OA_OPTS).generate(request());
  await drain(new OpenAiCompatibleProvider(oaSettings(srv.origin, { apiKey: '' }), OA_OPTS).stream(request()));

  assert.equal(srv.seen[0]!.headers.authorization, undefined);
  assert.equal(srv.seen[0]!.headers['content-type'], 'application/json');
  assert.equal(srv.seen[1]!.headers.authorization, 'Bearer gsk_test_123');
  assert.equal(srv.seen[2]!.headers.authorization, undefined);
  for (const s of srv.seen) {
    assert.equal(s.headers['http-referer'], undefined, 'only OpenRouter gets the referer header');
    assert.equal(s.headers['x-title'], undefined);
  }
});

test('OpenAI-compatible: OpenRouter requests carry the public URL as HTTP-Referer and the X-Title header', async (t) => {
  const srv = await startServer((_req, res) => sendJson(res, 200, oaText('hi')));
  t.after(() => srv.close());
  await new OpenAiCompatibleProvider(oaSettings(srv.origin, { provider: 'openrouter', apiKey: 'or-key' }), OA_OPTS).generate(request());
  assert.equal(srv.seen[0]!.headers['http-referer'], 'https://scout.test');
  assert.equal(srv.seen[0]!.headers['x-title'], 'Scout');
  assert.equal(srv.seen[0]!.headers.authorization, 'Bearer or-key');
});

test('OpenAI-compatible: reasoning_effort is sent only when it is set', async (t) => {
  const srv = await startServer((_req, res) => sendJson(res, 200, oaText('hi')));
  t.after(() => srv.close());

  await new OpenAiCompatibleProvider(oaSettings(srv.origin, { reasoningEffort: '' }), OA_OPTS).generate(request());
  await new OpenAiCompatibleProvider(oaSettings(srv.origin, { reasoningEffort: 'none' }), OA_OPTS).generate(request());
  await drain(new OpenAiCompatibleProvider(oaSettings(srv.origin, { reasoningEffort: 'high' }), OA_OPTS).stream(request()));

  assert.equal('reasoning_effort' in srv.seen[0]!.body, false);
  assert.equal(srv.seen[1]!.body.reasoning_effort, 'none');
  assert.equal(srv.seen[2]!.body.reasoning_effort, 'high');
});

test('OpenAI-compatible: tools are sent with tool_choice auto, and toolChoice none sends no tools at all', async (t) => {
  const srv = await startServer((_req, res) => sendJson(res, 200, oaText('hi')));
  t.after(() => srv.close());
  const provider = new OpenAiCompatibleProvider(oaSettings(srv.origin), OA_OPTS);

  await provider.generate(request({ toolChoice: 'auto' }));
  await provider.generate(request({ toolChoice: 'none' }));
  await drain(provider.stream(request({ toolChoice: 'none' })));
  await provider.generate(request({ tools: [] }));

  assert.deepEqual(srv.seen[0]!.body.tools, [
    { type: 'function', function: { name: 'get_weather', description: 'Current weather for a city', parameters: TOOLS[0]!.inputSchema } },
  ]);
  assert.equal(srv.seen[0]!.body.tool_choice, 'auto');
  for (const s of srv.seen.slice(1)) {
    assert.equal('tools' in s.body, false);
    assert.equal('tool_choice' in s.body, false);
  }
});

test('OpenAI-compatible: the request has the system prompt first, tool calls as JSON strings and tool results as role tool', async (t) => {
  const srv = await startServer((_req, res) => sendJson(res, 200, oaText('Sunny.')));
  t.after(() => srv.close());
  const provider = new OpenAiCompatibleProvider(oaSettings(srv.origin), OA_OPTS);

  const messages: Message[] = [
    USER_Q,
    {
      role: 'assistant',
      parts: [
        { type: 'text', text: 'Checking.' },
        { type: 'tool_call', call: { id: 'call_1', name: 'get_weather', args: { city: 'Pune' } } },
        { type: 'tool_call', call: { id: 'call_2', name: 'get_time', args: {} } },
      ],
    },
    {
      role: 'user',
      parts: [
        { type: 'tool_result', callId: 'call_1', name: 'get_weather', content: '{"temp":31}' },
        { type: 'tool_result', callId: 'call_2', name: 'get_time', content: 'clock broken', isError: true },
      ],
    },
    // An assistant turn with only an opaque block from another provider is dropped.
    { role: 'assistant', parts: [{ type: 'provider_raw', provider: 'anthropic', data: { type: 'thinking', thinking: 'x', signature: 's' } }] },
    { role: 'assistant', parts: [{ type: 'tool_call', call: { id: 'call_3', name: 'get_weather', args: { city: 'Pune', day: 'tomorrow' } } }] },
    {
      role: 'user',
      parts: [
        { type: 'text', text: 'And ' },
        { type: 'tool_result', callId: 'call_3', name: 'get_weather', content: '{"temp":29}' },
        { type: 'text', text: 'the day after?' },
      ],
    },
  ];
  await provider.generate(request({ messages, maxTokens: 99 }));

  const body = srv.seen[0]!.body;
  assert.equal(body.max_tokens, 99);
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'You are Scout.' },
    { role: 'user', content: 'Weather in Pune?' },
    {
      role: 'assistant',
      content: 'Checking.',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Pune"}' } },
        { id: 'call_2', type: 'function', function: { name: 'get_time', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', content: '{"temp":31}' },
    { role: 'tool', tool_call_id: 'call_2', content: 'ERROR: clock broken' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_3', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Pune","day":"tomorrow"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_3', content: '{"temp":29}' },
    { role: 'user', content: 'And the day after?' },
  ]);
});

test('OpenAI-compatible: finish reasons map to stop reasons', async (t) => {
  const finishes = ['stop', 'length', 'content_filter', 'something_new'];
  const srv = await startServer((_req, res, i) => sendJson(res, 200, oaText('x', finishes[i]!)));
  t.after(() => srv.close());
  const provider = new OpenAiCompatibleProvider(oaSettings(srv.origin), OA_OPTS);
  const got: string[] = [];
  for (let i = 0; i < finishes.length; i++) got.push((await provider.generate(request())).stopReason);
  assert.deepEqual(got, ['end', 'max_tokens', 'refusal', 'other']);
});

test('OpenAI-compatible: a 429 with retry-after becomes a retryable rate_limit error with retryAfterMs', async (t) => {
  const srv = await startServer((_req, res) =>
    sendJson(res, 429, { error: { message: 'Rate limit reached for model', type: 'tokens', code: 'rate_limit_exceeded' } }, { 'retry-after': '3' }),
  );
  t.after(() => srv.close());
  const provider = new OpenAiCompatibleProvider(oaSettings(srv.origin, { provider: 'groq', apiKey: 'gsk_x' }), OA_OPTS);

  for (const err of [await providerError(provider.generate(request())), await providerError(drain(provider.stream(request())))]) {
    assert.equal(err.kind, 'rate_limit');
    assert.equal(err.status, 429);
    assert.equal(err.retryAfterMs, 3000);
    assert.equal(err.provider, 'groq');
    assert.equal(err.retryable, true);
    assert.match(err.message, /Rate limit reached for model/);
  }
});

test('OpenAI-compatible: a 401 becomes a non-retryable auth error that does not echo the API key', async (t) => {
  const srv = await startServer((_req, res) => sendJson(res, 401, { error: { message: 'Invalid API Key' } }));
  t.after(() => srv.close());
  const provider = new OpenAiCompatibleProvider(oaSettings(srv.origin, { provider: 'groq', apiKey: 'gsk_super_secret_123' }), OA_OPTS);

  const err = await providerError(provider.generate(request()));
  assert.equal(err.kind, 'auth');
  assert.equal(err.status, 401);
  assert.equal(err.retryable, false);
  assert.equal(err.retryAfterMs, undefined);
  assert.match(err.message, /Invalid API Key/);
  assert.equal(err.message.includes('gsk_super_secret_123'), false);
});

test('OpenAI-compatible: other HTTP errors map to bad_request, not_found and server, and huge error bodies are cut short', async (t) => {
  const statuses = [400, 404, 500];
  const srv = await startServer((_req, res, i) => {
    if (statuses[i] === 500) {
      res.writeHead(500, { 'content-type': 'text/html' });
      res.end('<html>' + 'x'.repeat(5000) + '</html>');
    } else {
      sendJson(res, statuses[i]!, { error: { message: `boom ${statuses[i]}` } });
    }
  });
  t.after(() => srv.close());
  const provider = new OpenAiCompatibleProvider(oaSettings(srv.origin), OA_OPTS);

  const bad = await providerError(provider.generate(request()));
  assert.equal(bad.kind, 'bad_request');
  assert.match(bad.message, /boom 400/);
  const missing = await providerError(provider.generate(request()));
  assert.equal(missing.kind, 'not_found');
  const server = await providerError(provider.generate(request()));
  assert.equal(server.kind, 'server');
  assert.equal(server.retryable, true);
  assert.ok(server.message.length < 400, `error message should be truncated, got ${server.message.length} chars`);
});

test('OpenAI-compatible: an error object inside a 200 reply is a server error', async (t) => {
  const srv = await startServer((_req, res) => sendJson(res, 200, { error: { message: 'model is still loading' } }));
  t.after(() => srv.close());
  const err = await providerError(new OpenAiCompatibleProvider(oaSettings(srv.origin), OA_OPTS).generate(request()));
  assert.equal(err.kind, 'server');
  assert.match(err.message, /model is still loading/);
});

test('OpenAI-compatible: a server that never answers times out, a cancelled request is aborted, and a closed port is a network error', async (t) => {
  const hang = await startServer(() => {});
  t.after(() => hang.close());

  const slow = new OpenAiCompatibleProvider(oaSettings(hang.origin), { ...OA_OPTS, timeoutMs: 150 });
  const timeout = await providerError(slow.generate(request()));
  assert.equal(timeout.kind, 'timeout');
  assert.equal(timeout.retryable, true);

  const ctrl = new AbortController();
  const patient = new OpenAiCompatibleProvider(oaSettings(hang.origin), OA_OPTS);
  const pending = patient.generate(request({ signal: ctrl.signal }));
  setTimeout(() => ctrl.abort(), 30);
  const aborted = await providerError(pending);
  assert.equal(aborted.kind, 'aborted');
  assert.equal(aborted.retryable, false);

  const port = await deadPort();
  const unreachable = new OpenAiCompatibleProvider(oaSettings(`http://127.0.0.1:${port}`), OA_OPTS);
  const network = await providerError(unreachable.generate(request()));
  assert.equal(network.kind, 'network');
});

test('OpenAI-compatible: a stream that breaks after some text fails with a network error after yielding that text', async (t) => {
  const srv = await startServer(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Half an ans' } }] })}\n\n`);
    await pause(30);
    res.socket?.destroy();
  });
  t.after(() => srv.close());
  const provider = new OpenAiCompatibleProvider(oaSettings(srv.origin), OA_OPTS);

  const texts: string[] = [];
  const err = await providerError(
    (async () => {
      for await (const ev of provider.stream(request())) if (ev.type === 'text') texts.push(ev.text);
    })(),
  );
  assert.deepEqual(texts, ['Half an ans']);
  assert.equal(err.kind, 'network');
});

// =====================================================================
// RetryingProvider / FallbackProvider
// =====================================================================

type Step = GenerateResult | Error;
type StreamStep = Array<StreamEvent | Error>;

function okResult(text: string, provider = 'fake'): GenerateResult {
  return {
    text,
    toolCalls: [],
    message: { role: 'assistant', parts: [{ type: 'text', text }] },
    stopReason: 'end',
    usage: { inputTokens: 1, outputTokens: 1 },
    provider,
    model: 'fake-model',
  };
}

class ScriptedProvider implements ModelProvider {
  readonly name: string;
  readonly model = 'fake-model';
  generateCalls = 0;
  streamCalls = 0;
  private readonly gen: Step[];
  private readonly streams: StreamStep[];

  constructor(name: string, script: { generate?: Step[]; stream?: StreamStep[] }) {
    this.name = name;
    this.gen = script.generate ?? [];
    this.streams = script.stream ?? [];
  }

  async generate(): Promise<GenerateResult> {
    const step = this.gen[this.generateCalls++];
    if (!step) throw new Error('ScriptedProvider ran out of generate replies');
    if (step instanceof Error) throw step;
    return step;
  }

  async *stream(): AsyncIterable<StreamEvent> {
    const steps = this.streams[this.streamCalls++];
    if (!steps) throw new Error('ScriptedProvider ran out of stream replies');
    for (const s of steps) {
      if (s instanceof Error) throw s;
      yield s;
    }
  }
}

function fakeSleep() {
  const delays: number[] = [];
  return { delays, sleep: async (ms: number) => void delays.push(ms) };
}

const rateLimit = (retryAfterMs?: number) =>
  new ProviderError('rate_limit', 'fake', 'slow down', { status: 429, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });

function streamOf(text: string, provider = 'fake'): StreamStep {
  return [{ type: 'text', text }, { type: 'done', result: okResult(text, provider) }];
}

test('RetryingProvider: retries a 429 and honours retryAfterMs, then returns the answer', async () => {
  const inner = new ScriptedProvider('fake', { generate: [rateLimit(1500), okResult('hello')] });
  const { delays, sleep } = fakeSleep();
  const retries: Array<{ attempt: number; delayMs: number; kind: string }> = [];
  const provider = new RetryingProvider(inner, { maxRetries: 3, sleep, onRetry: (i) => retries.push({ attempt: i.attempt, delayMs: i.delayMs, kind: i.error.kind }) });

  const result = await provider.generate(request());

  assert.equal(result.text, 'hello');
  assert.equal(inner.generateCalls, 2);
  assert.deepEqual(delays, [1500]);
  assert.deepEqual(retries, [{ attempt: 1, delayMs: 1500, kind: 'rate_limit' }]);
  assert.equal(provider.name, 'fake');
  assert.equal(provider.model, 'fake-model');
});

test('RetryingProvider: a tiny retryAfterMs is raised to a 200 ms floor', async () => {
  const inner = new ScriptedProvider('fake', { generate: [rateLimit(0), okResult('ok')] });
  const { delays, sleep } = fakeSleep();
  await new RetryingProvider(inner, { maxRetries: 1, sleep }).generate(request());
  assert.deepEqual(delays, [200]);
});

test('RetryingProvider: a retryAfterMs beyond maxRetryAfterMs is not waited for, so a fallback can answer', async () => {
  const inner = new ScriptedProvider('fake', { generate: [rateLimit(60_000), okResult('never')] });
  const { delays, sleep } = fakeSleep();
  const err = await providerError(new RetryingProvider(inner, { maxRetries: 3, sleep, maxRetryAfterMs: 30_000 }).generate(request()));
  assert.equal(err.kind, 'rate_limit');
  assert.equal(inner.generateCalls, 1);
  assert.deepEqual(delays, []);
});

test('RetryingProvider: without retryAfterMs it backs off exponentially with jitter, capped at maxDelayMs', async () => {
  const server = () => new ProviderError('server', 'fake', 'oops', { status: 500 });
  const inner = new ScriptedProvider('fake', { generate: [server(), server(), server(), okResult('finally')] });
  const { delays, sleep } = fakeSleep();
  const result = await new RetryingProvider(inner, { maxRetries: 3, sleep, baseDelayMs: 100, maxDelayMs: 150 }).generate(request());
  assert.equal(result.text, 'finally');
  assert.equal(delays.length, 3);
  assert.ok(delays[0]! >= 75 && delays[0]! <= 125, `first delay ${delays[0]} should be 100 ms +/- 25%`);
  assert.equal(delays[1], 150);
  assert.equal(delays[2], 150);
});

test('RetryingProvider: does not retry auth (401) or bad_request (400) errors', async () => {
  for (const err of [
    new ProviderError('auth', 'fake', 'bad key', { status: 401 }),
    new ProviderError('bad_request', 'fake', 'bad body', { status: 400 }),
  ]) {
    const inner = new ScriptedProvider('fake', { generate: [err, okResult('never')], stream: [[err], streamOf('never')] });
    const { delays, sleep } = fakeSleep();
    const provider = new RetryingProvider(inner, { maxRetries: 3, sleep });
    assert.equal(await providerError(provider.generate(request())), err);
    assert.equal(await providerError(drain(provider.stream(request()))), err);
    assert.equal(inner.generateCalls, 1);
    assert.equal(inner.streamCalls, 1);
    assert.deepEqual(delays, []);
  }
});

test('RetryingProvider: gives up after maxRetries and throws the last error', async () => {
  const errors = [1, 2, 3, 4].map((n) => new ProviderError('overloaded', 'fake', `overloaded #${n}`, { status: 529 }));
  const inner = new ScriptedProvider('fake', { generate: [...errors, okResult('too late')] });
  const { delays, sleep } = fakeSleep();
  const err = await providerError(new RetryingProvider(inner, { maxRetries: 2, sleep }).generate(request()));
  assert.equal(inner.generateCalls, 3, 'one try plus two retries');
  assert.equal(delays.length, 2);
  assert.equal(err, errors[2]);
});

test('RetryingProvider: maxRetries 0 never retries', async () => {
  const inner = new ScriptedProvider('fake', { generate: [rateLimit(10), okResult('never')] });
  const { delays, sleep } = fakeSleep();
  await providerError(new RetryingProvider(inner, { maxRetries: 0, sleep }).generate(request()));
  assert.equal(inner.generateCalls, 1);
  assert.deepEqual(delays, []);
});

test('RetryingProvider: does not retry once the request was cancelled', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const inner = new ScriptedProvider('fake', { generate: [rateLimit(10), okResult('never')] });
  const { delays, sleep } = fakeSleep();
  await providerError(new RetryingProvider(inner, { maxRetries: 3, sleep }).generate(request({ signal: ctrl.signal })));
  assert.equal(inner.generateCalls, 1);
  assert.deepEqual(delays, []);
});

test('RetryingProvider: a stream that fails before its first event is retried', async () => {
  const inner = new ScriptedProvider('fake', { stream: [[rateLimit(700)], streamOf('second try')] });
  const { delays, sleep } = fakeSleep();
  const { texts, result } = await drain(new RetryingProvider(inner, { maxRetries: 2, sleep }).stream(request()));
  assert.deepEqual(texts, ['second try']);
  assert.equal(result.text, 'second try');
  assert.equal(inner.streamCalls, 2);
  assert.deepEqual(delays, [700]);
});

test('RetryingProvider: a stream that already yielded text is not retried', async () => {
  const boom = new ProviderError('overloaded', 'fake', 'overloaded mid-stream', { status: 529 });
  const inner = new ScriptedProvider('fake', { stream: [[{ type: 'text', text: 'partial ' }, boom], streamOf('whole answer')] });
  const { delays, sleep } = fakeSleep();
  const seen: string[] = [];
  const err = await providerError(
    (async () => {
      for await (const ev of new RetryingProvider(inner, { maxRetries: 3, sleep }).stream(request())) if (ev.type === 'text') seen.push(ev.text);
    })(),
  );
  assert.equal(err, boom);
  assert.deepEqual(seen, ['partial '], 'the user never sees the text twice');
  assert.equal(inner.streamCalls, 1);
  assert.deepEqual(delays, []);
});

test('RetryingProvider: retries a real 429 from an OpenAI-compatible server using its retry-after header', async (t) => {
  const srv = await startServer((_req, res, i) => {
    if (i === 0) sendJson(res, 429, { error: { message: 'slow down' } }, { 'retry-after': '1' });
    else sendJson(res, 200, oaText('after the wait'));
  });
  t.after(() => srv.close());
  const { delays, sleep } = fakeSleep();
  const provider = new RetryingProvider(new OpenAiCompatibleProvider(oaSettings(srv.origin), OA_OPTS), { maxRetries: 2, sleep });

  const result = await provider.generate(request());
  assert.equal(result.text, 'after the wait');
  assert.equal(srv.seen.length, 2);
  assert.deepEqual(delays, [1000]);
});

test('RetryingProvider: does not retry a real stream that broke after yielding text', async (t) => {
  const srv = await startServer(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Hello' } }] })}\n\n`);
    await pause(30);
    res.socket?.destroy();
  });
  t.after(() => srv.close());
  const { delays, sleep } = fakeSleep();
  const provider = new RetryingProvider(new OpenAiCompatibleProvider(oaSettings(srv.origin), OA_OPTS), { maxRetries: 3, sleep });
  const texts: string[] = [];
  const err = await providerError(
    (async () => {
      for await (const ev of provider.stream(request())) if (ev.type === 'text') texts.push(ev.text);
    })(),
  );
  assert.equal(err.kind, 'network');
  assert.deepEqual(texts, ['Hello']);
  assert.equal(srv.seen.length, 1);
  assert.deepEqual(delays, []);
});

test('FallbackProvider: a primary rate limit makes the fallback answer', async () => {
  const limited = rateLimit(1000);
  const primary = new ScriptedProvider('primary', { generate: [limited] });
  const fallback = new ScriptedProvider('backup', { generate: [okResult('from backup', 'backup')] });
  const fellBack: ProviderError[] = [];
  const provider = new FallbackProvider(primary, fallback, (e) => fellBack.push(e));

  const result = await provider.generate(request());
  assert.equal(result.text, 'from backup');
  assert.equal(result.provider, 'backup');
  assert.deepEqual(fellBack, [limited]);
  assert.equal(provider.name, 'primary');
});

test('FallbackProvider: auth, overloaded, server, network, timeout and not_found errors fall back too', async () => {
  for (const kind of ['auth', 'overloaded', 'server', 'network', 'timeout', 'not_found'] as const) {
    const primary = new ScriptedProvider('primary', { generate: [new ProviderError(kind, 'primary', kind)] });
    const fallback = new ScriptedProvider('backup', { generate: [okResult('ok', 'backup')] });
    const result = await new FallbackProvider(primary, fallback).generate(request());
    assert.equal(result.provider, 'backup', `${kind} should fall back`);
  }
});

test('FallbackProvider: a primary bad_request is thrown without trying the fallback', async () => {
  const bad = new ProviderError('bad_request', 'primary', 'messages are malformed', { status: 400 });
  const primary = new ScriptedProvider('primary', { generate: [bad], stream: [[bad]] });
  const fallback = new ScriptedProvider('backup', { generate: [okResult('never')], stream: [streamOf('never')] });
  let called = false;
  const provider = new FallbackProvider(primary, fallback, () => (called = true));

  assert.equal(await providerError(provider.generate(request())), bad);
  assert.equal(await providerError(drain(provider.stream(request()))), bad);
  assert.equal(fallback.generateCalls, 0);
  assert.equal(fallback.streamCalls, 0);
  assert.equal(called, false);
});

test('FallbackProvider: a cancelled request does not fall back', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const primary = new ScriptedProvider('primary', { generate: [new ProviderError('network', 'primary', 'gone')] });
  const fallback = new ScriptedProvider('backup', { generate: [okResult('never')] });
  await providerError(new FallbackProvider(primary, fallback).generate(request({ signal: ctrl.signal })));
  assert.equal(fallback.generateCalls, 0);
});

test('FallbackProvider: a stream falls back only when the primary fails before its first event', async () => {
  // Fails before any event: the fallback streams the answer.
  {
    const primary = new ScriptedProvider('primary', { stream: [[rateLimit()]] });
    const fallback = new ScriptedProvider('backup', { stream: [streamOf('backup stream', 'backup')] });
    const fellBack: ProviderError[] = [];
    const { texts, result } = await drain(new FallbackProvider(primary, fallback, (e) => fellBack.push(e)).stream(request()));
    assert.deepEqual(texts, ['backup stream']);
    assert.equal(result.provider, 'backup');
    assert.equal(fellBack.length, 1);
  }
  // Fails after text was already sent: the error surfaces and the fallback is not used.
  {
    const boom = new ProviderError('server', 'primary', 'broke');
    const primary = new ScriptedProvider('primary', { stream: [[{ type: 'text', text: 'Hel' }, boom]] });
    const fallback = new ScriptedProvider('backup', { stream: [streamOf('never')] });
    const seen: string[] = [];
    const err = await providerError(
      (async () => {
        for await (const ev of new FallbackProvider(primary, fallback).stream(request())) if (ev.type === 'text') seen.push(ev.text);
      })(),
    );
    assert.equal(err, boom);
    assert.deepEqual(seen, ['Hel']);
    assert.equal(fallback.streamCalls, 0);
  }
});

test('createModelStack: a primary Groq rate limit is answered by the Gemini fallback', async (t) => {
  const groq = await startServer((_req, res) => sendJson(res, 429, { error: { message: 'rate limited' } }, { 'retry-after': '120' }));
  t.after(() => groq.close());
  const gemini = await startServer((_req, res) =>
    sendJson(res, 200, { candidates: [{ content: { role: 'model', parts: [{ text: 'Gemini here.' }] }, finishReason: 'STOP' }] }),
  );
  t.after(() => gemini.close());
  const config = testConfig({
    MODEL_PROVIDER: 'groq',
    MODEL_NAME: 'llama-test',
    MODEL_BASE_URL: `${groq.origin}/v1`,
    SCOUT_MODEL_API_KEY: 'gsk_test',
    MODEL_MAX_RETRIES: '2',
    FALLBACK_PROVIDER: 'gemini',
    FALLBACK_MODEL_NAME: 'gemini-test',
    FALLBACK_BASE_URL: gemini.origin,
    SCOUT_FALLBACK_API_KEY: 'g-test-key',
  });
  const fellBack: ProviderError[] = [];
  const stack = createModelStack(config, { onFallback: (e) => fellBack.push(e) });

  const result = await stack.generate(request());
  assert.equal(result.text, 'Gemini here.');
  assert.equal(result.provider, 'gemini');
  assert.equal(groq.seen.length, 1, 'a retry-after above the cap is not waited for');
  assert.equal(groq.seen[0]!.headers.authorization, 'Bearer gsk_test');
  assert.equal(gemini.seen[0]!.headers['x-goog-api-key'], 'g-test-key');
  assert.equal(fellBack.length, 1);
  assert.equal(fellBack[0]!.kind, 'rate_limit');
});

// =====================================================================
// Gemini
// =====================================================================

const GEM_OPTS = { timeoutMs: 5000, maxOutputTokens: 300 };

function gemSettings(origin: string, over: Partial<ProviderSettings> = {}): ProviderSettings {
  return { provider: 'gemini', model: 'gemini-test', apiKey: 'g-secret-key', baseUrl: origin, effort: '', reasoningEffort: '', ...over };
}

function gemReply(parts: unknown[], finishReason = 'STOP', extra: Record<string, unknown> = {}) {
  return {
    candidates: [{ content: { role: 'model', parts }, finishReason }],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5, thoughtsTokenCount: 3, cachedContentTokenCount: 4 },
    modelVersion: 'gemini-test-001',
    ...extra,
  };
}

test('Gemini: posts to /v1beta/models/<model>:generateContent with the key only in the x-goog-api-key header', async (t) => {
  const srv = await startServer((_req, res) => sendJson(res, 200, gemReply([{ text: 'Hello!' }])));
  t.after(() => srv.close());
  const provider = new GeminiProvider(gemSettings(srv.origin), GEM_OPTS);

  const result = await provider.generate(request());
  await new GeminiProvider(gemSettings(srv.origin, { model: 'models/gemini-prefixed' }), GEM_OPTS).generate(request());

  const s = srv.seen[0]!;
  assert.equal(s.method, 'POST');
  assert.equal(s.path, '/v1beta/models/gemini-test:generateContent');
  assert.equal(s.headers['x-goog-api-key'], 'g-secret-key');
  assert.equal(s.path.includes('key='), false, 'the API key must never be put in the URL');
  assert.equal(s.headers.authorization, undefined);
  assert.equal(srv.seen[1]!.path, '/v1beta/models/gemini-prefixed:generateContent');

  assert.deepEqual(s.body.systemInstruction, { parts: [{ text: 'You are Scout.' }] });
  assert.deepEqual(s.body.contents, [{ role: 'user', parts: [{ text: 'Weather in Pune?' }] }]);
  assert.deepEqual(s.body.tools, [
    { functionDeclarations: [{ name: 'get_weather', description: 'Current weather for a city', parametersJsonSchema: TOOLS[0]!.inputSchema }] },
  ]);
  assert.deepEqual(s.body.toolConfig, { functionCallingConfig: { mode: 'AUTO' } });
  assert.deepEqual(s.body.generationConfig, { maxOutputTokens: 300 });

  assert.equal(result.text, 'Hello!');
  assert.equal(result.stopReason, 'end');
  assert.equal(result.provider, 'gemini');
  assert.equal(result.model, 'gemini-test-001');
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 8, cachedInputTokens: 4 });
});

test('Gemini: toolChoice none sets function calling mode NONE and the effort maps to a thinking level', async (t) => {
  const srv = await startServer((_req, res) => sendJson(res, 200, gemReply([{ text: 'ok' }])));
  t.after(() => srv.close());
  await new GeminiProvider(gemSettings(srv.origin, { effort: 'xhigh' }), GEM_OPTS).generate(request({ toolChoice: 'none', maxTokens: 50 }));
  const body = srv.seen[0]!.body;
  assert.deepEqual(body.toolConfig, { functionCallingConfig: { mode: 'NONE' } });
  assert.deepEqual(body.generationConfig, { maxOutputTokens: 50, thinkingConfig: { thinkingLevel: 'HIGH' } });
});

test('Gemini: a functionCall with a thoughtSignature keeps the signature in toolCall.meta', async (t) => {
  const srv = await startServer((_req, res) =>
    sendJson(res, 200, gemReply([{ text: 'secret reasoning', thought: true }, { functionCall: { name: 'get_weather', args: { city: 'Pune' } }, thoughtSignature: 'sig-abc' }])),
  );
  t.after(() => srv.close());
  const result = await new GeminiProvider(gemSettings(srv.origin), GEM_OPTS).generate(request());

  assert.equal(result.toolCalls.length, 1);
  const call = result.toolCalls[0]!;
  assert.equal(call.name, 'get_weather');
  assert.deepEqual(call.args, { city: 'Pune' });
  assert.deepEqual(call.meta, { thoughtSignature: 'sig-abc' });
  assert.match(call.id, /^call_/);
  assert.equal(result.stopReason, 'tool_use');
  assert.equal(result.text, '', 'thought summaries are never shown as answer text');
  assert.deepEqual(result.message.parts, [{ type: 'tool_call', call }]);
});

test('Gemini: replaying a signed tool call sends the thoughtSignature back on the functionCall and the result as functionResponse', async (t) => {
  const srv = await startServer((_req, res, i) => {
    if (i === 0) sendJson(res, 200, gemReply([{ functionCall: { name: 'get_weather', args: { city: 'Pune' } }, thoughtSignature: 'sig-abc' }]));
    else sendJson(res, 200, gemReply([{ text: 'It is 31C.' }]));
  });
  t.after(() => srv.close());
  const provider = new GeminiProvider(gemSettings(srv.origin), GEM_OPTS);

  const first = await provider.generate(request());
  const call = first.toolCalls[0]!;
  const second = await provider.generate(
    request({ messages: [USER_Q, first.message, { role: 'user', parts: [{ type: 'tool_result', callId: call.id, name: 'get_weather', content: '{"temp":31}' }] }] }),
  );

  assert.equal(second.text, 'It is 31C.');
  assert.deepEqual(srv.seen[1]!.body.contents, [
    { role: 'user', parts: [{ text: 'Weather in Pune?' }] },
    { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: 'Pune' } }, thoughtSignature: 'sig-abc' }] },
    { role: 'user', parts: [{ functionResponse: { name: 'get_weather', response: { output: { temp: 31 } } } }] },
  ]);
});

test('Gemini: functionCall ids round-trip, and error results are wrapped as response.error', async (t) => {
  const srv = await startServer((_req, res, i) => {
    if (i === 0) sendJson(res, 200, gemReply([{ functionCall: { id: 'fc-1', name: 'get_weather', args: { city: 'Pune' } }, thoughtSignature: 'sig-1' }]));
    else sendJson(res, 200, gemReply([{ text: 'done' }]));
  });
  t.after(() => srv.close());
  const provider = new GeminiProvider(gemSettings(srv.origin), GEM_OPTS);

  const first = await provider.generate(request());
  assert.deepEqual(first.toolCalls, [{ id: 'fc-1', name: 'get_weather', args: { city: 'Pune' }, meta: { gid: 'fc-1', thoughtSignature: 'sig-1' } }]);
  await provider.generate(
    request({
      messages: [USER_Q, first.message, { role: 'user', parts: [{ type: 'tool_result', callId: 'fc-1', name: 'get_weather', content: 'service down', isError: true }] }],
    }),
  );
  assert.deepEqual(srv.seen[1]!.body.contents.slice(1), [
    { role: 'model', parts: [{ functionCall: { id: 'fc-1', name: 'get_weather', args: { city: 'Pune' } }, thoughtSignature: 'sig-1' }] },
    { role: 'user', parts: [{ functionResponse: { id: 'fc-1', name: 'get_weather', response: { error: 'service down' } } }] },
  ]);
});

test('Gemini: parallel tool calls where only the first carries a thoughtSignature are all replayed as functionCall/functionResponse', async (t) => {
  // Gemini signs only the first functionCall of a parallel batch and expects the turn back exactly as it was sent.
  const srv = await startServer((_req, res, i) => {
    if (i === 0) {
      sendJson(res, 200, gemReply([
        { functionCall: { name: 'get_weather', args: { city: 'Pune' } }, thoughtSignature: 'sig-par' },
        { functionCall: { name: 'get_time', args: { zone: 'IST' } } },
      ]));
    } else {
      sendJson(res, 200, gemReply([{ text: 'done' }]));
    }
  });
  t.after(() => srv.close());
  const provider = new GeminiProvider(gemSettings(srv.origin), GEM_OPTS);

  const first = await provider.generate(request());
  assert.equal(first.toolCalls.length, 2);
  const [weather, time] = first.toolCalls as [ToolCall, ToolCall];
  assert.deepEqual(weather.meta, { thoughtSignature: 'sig-par' });
  await provider.generate(
    request({
      messages: [
        USER_Q,
        first.message,
        {
          role: 'user',
          parts: [
            { type: 'tool_result', callId: weather.id, name: 'get_weather', content: '{"temp":31}' },
            { type: 'tool_result', callId: time.id, name: 'get_time', content: '{"time":"12:00"}' },
          ],
        },
      ],
    }),
  );
  assert.deepEqual(srv.seen[1]!.body.contents.slice(1), [
    {
      role: 'model',
      parts: [
        { functionCall: { name: 'get_weather', args: { city: 'Pune' } }, thoughtSignature: 'sig-par' },
        { functionCall: { name: 'get_time', args: { zone: 'IST' } } },
      ],
    },
    {
      role: 'user',
      parts: [
        { functionResponse: { name: 'get_weather', response: { output: { temp: 31 } } } },
        { functionResponse: { name: 'get_time', response: { output: { time: '12:00' } } } },
      ],
    },
  ]);
});

test('Gemini: a tool call from another provider (no signature) in the current turn is replayed as plain text', async (t) => {
  const srv = await startServer((_req, res) => sendJson(res, 200, gemReply([{ text: 'Sunny.' }])));
  t.after(() => srv.close());
  const provider = new GeminiProvider(gemSettings(srv.origin), GEM_OPTS);

  await provider.generate(
    request({
      messages: [
        USER_Q,
        {
          role: 'assistant',
          parts: [
            { type: 'provider_raw', provider: 'anthropic', data: { type: 'thinking', thinking: 'hidden', signature: 's' } },
            { type: 'text', text: 'Checking.' },
            { type: 'tool_call', call: { id: 'toolu_9', name: 'get_weather', args: { city: 'Pune' } } },
          ],
        },
        {
          role: 'user',
          parts: [{ type: 'tool_result', callId: 'toolu_9', name: 'get_weather', content: '{"temp":31}' }],
        },
      ],
    }),
  );

  const contents = srv.seen[0]!.body.contents;
  assert.deepEqual(contents, [
    { role: 'user', parts: [{ text: 'Weather in Pune?' }] },
    { role: 'model', parts: [{ text: 'Checking.' }, { text: '[I called the tool get_weather with {"city":"Pune"}]' }] },
    { role: 'user', parts: [{ text: '[Result of get_weather]: {"temp":31}' }] },
  ]);
  const wire = JSON.stringify(contents);
  assert.equal(wire.includes('functionCall'), false);
  assert.equal(wire.includes('functionResponse'), false);
  assert.equal(wire.includes('hidden'), false, 'another provider’s opaque blocks are never sent to Gemini');
});

test('Gemini: an unsigned tool call from an earlier turn is still sent as a functionCall', async (t) => {
  const srv = await startServer((_req, res) => sendJson(res, 200, gemReply([{ text: 'ok' }])));
  t.after(() => srv.close());
  await new GeminiProvider(gemSettings(srv.origin), GEM_OPTS).generate(
    request({
      messages: [
        USER_Q,
        { role: 'assistant', parts: [{ type: 'tool_call', call: { id: 'old_1', name: 'get_weather', args: { city: 'Pune' } } }] },
        { role: 'user', parts: [{ type: 'tool_result', callId: 'old_1', name: 'get_weather', content: '{"temp":31}' }] },
        { role: 'assistant', parts: [{ type: 'text', text: 'It is 31C.' }] },
        { role: 'user', parts: [{ type: 'text', text: 'Thanks!' }] },
      ],
    }),
  );
  assert.deepEqual(srv.seen[0]!.body.contents.slice(1, 3), [
    { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: 'Pune' } } }] },
    { role: 'user', parts: [{ functionResponse: { name: 'get_weather', response: { output: { temp: 31 } } } }] },
  ]);
});

test('Gemini: streamGenerateContent?alt=sse joins text split over chunks and reads usageMetadata', async (t) => {
  const ev = (o: unknown) => `data: ${JSON.stringify(o)}\r\n\r\n`;
  const middle = ev({ candidates: [{ content: { role: 'model', parts: [{ text: 'lo there' }] } }] });
  const srv = await startServer((_req, res) =>
    sendSse(res, [
      ev({ candidates: [{ content: { role: 'model', parts: [{ text: 'pondering', thought: true }, { text: 'Hel' }] } }], usageMetadata: { promptTokenCount: 9 } }),
      middle.slice(0, 30),
      middle.slice(30),
      ev({
        candidates: [{ content: { role: 'model', parts: [{ text: '', thoughtSignature: 'sig-t' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4, thoughtsTokenCount: 2, cachedContentTokenCount: 3 },
        modelVersion: 'gemini-test-002',
      }),
    ]),
  );
  t.after(() => srv.close());

  const { texts, result } = await drain(new GeminiProvider(gemSettings(srv.origin), GEM_OPTS).stream(request()));

  assert.equal(srv.seen[0]!.path, '/v1beta/models/gemini-test:streamGenerateContent?alt=sse');
  assert.equal(srv.seen[0]!.headers['x-goog-api-key'], 'g-secret-key');
  assert.deepEqual(texts, ['Hel', 'lo there']);
  assert.equal(result.text, 'Hello there');
  assert.deepEqual(result.message.parts, [{ type: 'text', text: 'Hello there', meta: { thoughtSignature: 'sig-t' } }]);
  assert.equal(result.stopReason, 'end');
  assert.deepEqual(result.usage, { inputTokens: 9, outputTokens: 6, cachedInputTokens: 3 });
  assert.equal(result.model, 'gemini-test-002');
});

test('Gemini: finishReason SAFETY and a blocked prompt both become a refusal', async (t) => {
  const srv = await startServer((_req, res, i) => {
    if (i === 0) sendJson(res, 200, { candidates: [{ finishReason: 'SAFETY' }] });
    else sendJson(res, 200, { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } });
  });
  t.after(() => srv.close());
  const provider = new GeminiProvider(gemSettings(srv.origin), GEM_OPTS);

  const safety = await provider.generate(request());
  assert.equal(safety.stopReason, 'refusal');
  assert.equal(safety.text, '');
  assert.deepEqual(safety.toolCalls, []);
  const blocked = await provider.generate(request());
  assert.equal(blocked.stopReason, 'refusal');
});

test('Gemini: MAX_TOKENS and unknown finish reasons map to max_tokens and other', async (t) => {
  const reasons = ['MAX_TOKENS', 'MALFORMED_FUNCTION_CALL'];
  const srv = await startServer((_req, res, i) => sendJson(res, 200, gemReply([{ text: 'x' }], reasons[i])));
  t.after(() => srv.close());
  const provider = new GeminiProvider(gemSettings(srv.origin), GEM_OPTS);
  assert.equal((await provider.generate(request())).stopReason, 'max_tokens');
  assert.equal((await provider.generate(request())).stopReason, 'other');
});

test('Gemini: a 429 with a RetryInfo retryDelay of "7s" becomes rate_limit with retryAfterMs 7000', async (t) => {
  const body = {
    error: {
      code: 429,
      message: 'You exceeded your current quota.',
      status: 'RESOURCE_EXHAUSTED',
      details: [
        { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [] },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '7s' },
      ],
    },
  };
  const srv = await startServer((_req, res) => sendJson(res, 429, body));
  t.after(() => srv.close());
  const provider = new GeminiProvider(gemSettings(srv.origin), GEM_OPTS);

  for (const err of [await providerError(provider.generate(request())), await providerError(drain(provider.stream(request())))]) {
    assert.equal(err.kind, 'rate_limit');
    assert.equal(err.status, 429);
    assert.equal(err.retryAfterMs, 7000);
    assert.equal(err.provider, 'gemini');
    assert.match(err.message, /exceeded your current quota/);
    assert.equal(err.message.includes('g-secret-key'), false);
  }
});

test('Gemini: a 403 is an auth error and a 400 is a bad_request', async (t) => {
  const srv = await startServer((_req, res, i) =>
    sendJson(res, i === 0 ? 403 : 400, { error: { code: i === 0 ? 403 : 400, message: i === 0 ? 'API key not valid' : 'Invalid JSON payload' } }),
  );
  t.after(() => srv.close());
  const provider = new GeminiProvider(gemSettings(srv.origin), GEM_OPTS);
  const auth = await providerError(provider.generate(request()));
  assert.equal(auth.kind, 'auth');
  assert.match(auth.message, /API key not valid/);
  const bad = await providerError(provider.generate(request()));
  assert.equal(bad.kind, 'bad_request');
});

// =====================================================================
// Anthropic (Claude) via the official SDK
// =====================================================================

const CLAUDE_OPTS = { timeoutMs: 5000, maxOutputTokens: 512 };

function claudeSettings(origin: string, over: Partial<ProviderSettings> = {}): ProviderSettings {
  return { provider: 'anthropic', model: 'claude-haiku-5-5', apiKey: 'sk-ant-test-key', baseUrl: origin, effort: '', reasoningEffort: '', ...over };
}

function claudeMessage(content: unknown[], over: Record<string, unknown> = {}) {
  return {
    id: 'msg_01',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-5-5',
    content,
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 },
    ...over,
  };
}

const THINKING = { type: 'thinking', thinking: 'The user wants the weather, so I should call get_weather.', signature: 'EqQBCkYIARgCKkBsig==' };

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

test('Anthropic: thinking, text and tool_use blocks become a provider_raw part, a text part and parsed toolCalls', async (t) => {
  const srv = await startServer((_req, res) =>
    sendJson(res, 200, claudeMessage([THINKING, { type: 'text', text: 'Let me check.' }, { type: 'tool_use', id: 'toolu_01', name: 'get_weather', input: { city: 'Pune' } }])),
  );
  t.after(() => srv.close());
  const result = await new AnthropicProvider(claudeSettings(srv.origin), CLAUDE_OPTS).generate(request());

  const call = { id: 'toolu_01', name: 'get_weather', args: { city: 'Pune' } };
  assert.deepEqual(result.message, {
    role: 'assistant',
    parts: [
      { type: 'provider_raw', provider: 'anthropic', data: THINKING },
      { type: 'text', text: 'Let me check.' },
      { type: 'tool_call', call },
    ],
  });
  assert.deepEqual(result.toolCalls, [call]);
  assert.equal(result.text, 'Let me check.');
  assert.equal(result.stopReason, 'tool_use');
  assert.equal(result.provider, 'anthropic');
  assert.equal(result.model, 'claude-haiku-5-5');

  const s = srv.seen[0]!;
  assert.equal(s.method, 'POST');
  assert.equal(s.path, '/v1/messages');
  assert.equal(s.headers['x-api-key'], 'sk-ant-test-key');
  assert.ok(s.headers['anthropic-version']);
  assert.equal(s.body.model, 'claude-haiku-5-5');
  assert.equal(s.body.max_tokens, 512);
  assert.equal(s.body.system, 'You are Scout.');
  assert.deepEqual(s.body.cache_control, { type: 'ephemeral' });
  assert.deepEqual(s.body.messages, [{ role: 'user', content: [{ type: 'text', text: 'Weather in Pune?' }] }]);
  assert.deepEqual(s.body.tools, [{ name: 'get_weather', description: 'Current weather for a city', input_schema: TOOLS[0]!.inputSchema }]);
  assert.equal('tool_choice' in s.body, false);
  assert.equal('output_config' in s.body, false);
  assert.equal(s.body.stream, undefined);
});

test('Anthropic: replaying the turn sends the thinking block back unchanged before the tool_use block', async (t) => {
  const srv = await startServer((_req, res, i) => {
    if (i === 0) {
      sendJson(res, 200, claudeMessage([THINKING, { type: 'text', text: 'Let me check.' }, { type: 'tool_use', id: 'toolu_01', name: 'get_weather', input: { city: 'Pune' } }]));
    } else {
      sendJson(res, 200, claudeMessage([{ type: 'text', text: 'It is 31C in Pune.' }], { stop_reason: 'end_turn' }));
    }
  });
  t.after(() => srv.close());
  const provider = new AnthropicProvider(claudeSettings(srv.origin), CLAUDE_OPTS);

  const first = await provider.generate(request());
  const second = await provider.generate(
    request({
      messages: [
        USER_Q,
        first.message,
        { role: 'user', parts: [{ type: 'tool_result', callId: 'toolu_01', name: 'get_weather', content: '{"temp":31}' }] },
      ],
    }),
  );

  assert.equal(second.text, 'It is 31C in Pune.');
  assert.equal(second.stopReason, 'end');
  const messages = srv.seen[1]!.body.messages;
  assert.deepEqual(messages, [
    { role: 'user', content: [{ type: 'text', text: 'Weather in Pune?' }] },
    {
      role: 'assistant',
      content: [THINKING, { type: 'text', text: 'Let me check.' }, { type: 'tool_use', id: 'toolu_01', name: 'get_weather', input: { city: 'Pune' } }],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: '{"temp":31}', is_error: false }] },
  ]);
  const types = messages[1].content.map((b: { type: string }) => b.type);
  assert.ok(types.indexOf('thinking') < types.indexOf('tool_use'));
});

test('Anthropic: redacted thinking is kept and replayed, and error tool results carry is_error', async (t) => {
  const redacted = { type: 'redacted_thinking', data: 'EmwKAhgBEgy3va3pzix/LafPsn4a' };
  const srv = await startServer((_req, res, i) => {
    if (i === 0) sendJson(res, 200, claudeMessage([redacted, { type: 'tool_use', id: 'toolu_02', name: 'get_weather', input: { city: 'Goa' } }]));
    else sendJson(res, 200, claudeMessage([{ type: 'text', text: 'Sorry.' }], { stop_reason: 'end_turn' }));
  });
  t.after(() => srv.close());
  const provider = new AnthropicProvider(claudeSettings(srv.origin), CLAUDE_OPTS);

  const first = await provider.generate(request());
  assert.deepEqual(first.message.parts[0], { type: 'provider_raw', provider: 'anthropic', data: redacted });
  await provider.generate(
    request({
      messages: [USER_Q, first.message, { role: 'user', parts: [{ type: 'tool_result', callId: 'toolu_02', name: 'get_weather', content: 'timeout', isError: true }] }],
    }),
  );
  assert.deepEqual(srv.seen[1]!.body.messages.slice(1), [
    { role: 'assistant', content: [redacted, { type: 'tool_use', id: 'toolu_02', name: 'get_weather', input: { city: 'Goa' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_02', content: 'timeout', is_error: true }] },
  ]);
});

test('Anthropic: usage counts cache reads and cache writes in the input total', async (t) => {
  const srv = await startServer((_req, res, i) => {
    if (i === 0) sendJson(res, 200, claudeMessage([{ type: 'text', text: 'hi' }], { stop_reason: 'end_turn' }));
    else sendJson(res, 200, claudeMessage([{ type: 'text', text: 'hi' }], { stop_reason: 'end_turn', usage: { input_tokens: 7, output_tokens: 3 } }));
  });
  t.after(() => srv.close());
  const provider = new AnthropicProvider(claudeSettings(srv.origin), CLAUDE_OPTS);

  assert.deepEqual((await provider.generate(request())).usage, { inputTokens: 160, outputTokens: 20, cachedInputTokens: 100, cacheWriteTokens: 50 });
  assert.deepEqual((await provider.generate(request())).usage, { inputTokens: 7, outputTokens: 3, cachedInputTokens: 0, cacheWriteTokens: 0 });
});

test('Anthropic: streaming SSE events produce text deltas and a final result with thinking, text and tool call', async (t) => {
  const srv = await startServer((_req, res) =>
    sendSse(res, [
      sse('message_start', {
        type: 'message_start',
        message: {
          id: 'msg_s',
          type: 'message',
          role: 'assistant',
          model: 'claude-haiku-5-5',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 15, output_tokens: 1, cache_read_input_tokens: 200, cache_creation_input_tokens: 0 },
        },
      }),
      sse('ping', { type: 'ping' }),
      sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }),
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Plan: call the tool.' } }),
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-stream' } }),
      sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
      sse('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
      sse('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Checking ' } }),
      sse('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'the weather.' } }),
      sse('content_block_stop', { type: 'content_block_stop', index: 1 }),
      sse('content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_s', name: 'get_weather', input: {} } }),
      sse('content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"city":' } }),
      sse('content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: ' "Pune"}' } }),
      sse('content_block_stop', { type: 'content_block_stop', index: 2 }),
      sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 42 } }),
      sse('message_stop', { type: 'message_stop' }),
    ]),
  );
  t.after(() => srv.close());

  const { texts, result, events } = await drain(new AnthropicProvider(claudeSettings(srv.origin), CLAUDE_OPTS).stream(request()));

  assert.deepEqual(texts, ['Checking ', 'the weather.']);
  assert.equal(events.length, 3);
  assert.equal(events[2]!.type, 'done');
  assert.equal(result.text, 'Checking the weather.');
  assert.deepEqual(result.toolCalls, [{ id: 'toolu_s', name: 'get_weather', args: { city: 'Pune' } }]);
  assert.deepEqual(result.message.parts[0], {
    type: 'provider_raw',
    provider: 'anthropic',
    data: { type: 'thinking', thinking: 'Plan: call the tool.', signature: 'sig-stream' },
  });
  assert.deepEqual(result.message.parts.map((p) => p.type), ['provider_raw', 'text', 'tool_call']);
  assert.equal(result.stopReason, 'tool_use');
  assert.deepEqual(result.usage, { inputTokens: 215, outputTokens: 42, cachedInputTokens: 200, cacheWriteTokens: 0 });

  const body = srv.seen[0]!.body;
  assert.equal(srv.seen[0]!.path, '/v1/messages');
  assert.equal(body.stream, true);
  assert.equal('temperature' in body, false);
});

test('Anthropic: a 429 with retry-after becomes rate_limit with retryAfterMs, for both generate and stream', async (t) => {
  const srv = await startServer((_req, res) =>
    sendJson(res, 429, { type: 'error', error: { type: 'rate_limit_error', message: 'Number of request tokens has exceeded your rate limit' } }, { 'retry-after': '12' }),
  );
  t.after(() => srv.close());
  const provider = new AnthropicProvider(claudeSettings(srv.origin), CLAUDE_OPTS);

  for (const err of [await providerError(provider.generate(request())), await providerError(drain(provider.stream(request())))]) {
    assert.equal(err.kind, 'rate_limit');
    assert.equal(err.status, 429);
    assert.equal(err.retryAfterMs, 12_000);
    assert.equal(err.provider, 'anthropic');
    assert.equal(err.retryable, true);
    assert.equal(err.message.includes('sk-ant-test-key'), false);
  }
  assert.equal(srv.seen.length, 2, 'the SDK itself never retries; RetryingProvider decides');
});

test('Anthropic: a 529 overloaded_error becomes overloaded', async (t) => {
  const srv = await startServer((_req, res) => sendJson(res, 529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
  t.after(() => srv.close());
  const provider = new AnthropicProvider(claudeSettings(srv.origin), CLAUDE_OPTS);

  for (const err of [await providerError(provider.generate(request())), await providerError(drain(provider.stream(request())))]) {
    assert.equal(err.kind, 'overloaded');
    assert.equal(err.status, 529);
    assert.equal(err.retryable, true);
  }
});

test('Anthropic: an overloaded_error type is recognised even when the HTTP status is a plain 500', async (t) => {
  const srv = await startServer((_req, res) => sendJson(res, 500, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
  t.after(() => srv.close());
  const err = await providerError(new AnthropicProvider(claudeSettings(srv.origin), CLAUDE_OPTS).generate(request()));
  assert.equal(err.kind, 'overloaded');
  assert.equal(err.status, 500);
});

test('Anthropic: 401 is auth and 400 is bad_request, neither retryable', async (t) => {
  const srv = await startServer((_req, res, i) =>
    i === 0
      ? sendJson(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })
      : sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'messages: field required' } }),
  );
  t.after(() => srv.close());
  const provider = new AnthropicProvider(claudeSettings(srv.origin), CLAUDE_OPTS);
  const auth = await providerError(provider.generate(request()));
  assert.equal(auth.kind, 'auth');
  assert.equal(auth.retryable, false);
  const bad = await providerError(provider.generate(request()));
  assert.equal(bad.kind, 'bad_request');
  assert.equal(bad.retryable, false);
});

test('Anthropic: an overloaded error event in the middle of a stream maps to overloaded', async (t) => {
  const srv = await startServer((_req, res) =>
    sendSse(res, [
      sse('message_start', {
        type: 'message_start',
        message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
      }),
      sse('error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }),
    ]),
  );
  t.after(() => srv.close());
  const err = await providerError(drain(new AnthropicProvider(claudeSettings(srv.origin), CLAUDE_OPTS).stream(request())));
  assert.equal(err.kind, 'overloaded');
  assert.equal(err.retryable, true);
});

test('Anthropic: an api_error event in the middle of a stream is a retryable server error', async (t) => {
  const srv = await startServer((_req, res) =>
    sendSse(res, [
      sse('message_start', {
        type: 'message_start',
        message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
      }),
      sse('error', { type: 'error', error: { type: 'api_error', message: 'Internal server error' } }),
    ]),
  );
  t.after(() => srv.close());
  const err = await providerError(drain(new AnthropicProvider(claudeSettings(srv.origin), CLAUDE_OPTS).stream(request())));
  assert.equal(err.kind, 'server', `an Anthropic api_error is an internal server error, got kind "${err.kind}"`);
  assert.equal(err.retryable, true);
});

test('Anthropic: no temperature field is ever sent, whatever the effort, tool choice or streaming mode', async (t) => {
  const srv = await startServer((req, res) => {
    if (req.body.stream) {
      return sendSse(res, [
        sse('message_start', {
          type: 'message_start',
          message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
        }),
        sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }),
        sse('message_stop', { type: 'message_stop' }),
      ]);
    }
    sendJson(res, 200, claudeMessage([{ type: 'text', text: 'ok' }], { stop_reason: 'end_turn' }));
  });
  t.after(() => srv.close());
  const plain = new AnthropicProvider(claudeSettings(srv.origin), CLAUDE_OPTS);
  const effortful = new AnthropicProvider(claudeSettings(srv.origin, { effort: 'high' }), CLAUDE_OPTS);

  await plain.generate(request());
  await plain.generate(request({ toolChoice: 'none' }));
  await effortful.generate(request({ tools: [] }));
  await drain(plain.stream(request()));
  await drain(effortful.stream(request({ toolChoice: 'none' })));

  assert.equal(srv.seen.length, 5);
  for (const s of srv.seen) assert.equal('temperature' in s.body, false, `temperature was sent in ${JSON.stringify(s.body)}`);
  assert.deepEqual(srv.seen[1]!.body.tool_choice, { type: 'none' });
  assert.deepEqual(srv.seen[2]!.body.output_config, { effort: 'high' });
  assert.equal('tools' in srv.seen[2]!.body, false);
  assert.deepEqual(srv.seen[4]!.body.output_config, { effort: 'high' });
  assert.deepEqual(srv.seen[4]!.body.tool_choice, { type: 'none' });
});

test('Anthropic: the client ignores an ANTHROPIC_AUTH_TOKEN in the environment and sends only x-api-key', async (t) => {
  const before = process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.ANTHROPIC_AUTH_TOKEN = 'ambient-token-should-not-leak';
  t.after(() => {
    if (before === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = before;
  });
  const srv = await startServer((_req, res) => sendJson(res, 200, claudeMessage([{ type: 'text', text: 'ok' }], { stop_reason: 'end_turn' })));
  t.after(() => srv.close());

  await new AnthropicProvider(claudeSettings(srv.origin), CLAUDE_OPTS).generate(request());
  assert.equal(srv.seen[0]!.headers.authorization, undefined);
  assert.equal(srv.seen[0]!.headers['x-api-key'], 'sk-ant-test-key');
});

test('Anthropic: a server that never answers times out and a closed port is a network error', async (t) => {
  const hang = await startServer(() => {});
  t.after(() => hang.close());
  const timeout = await providerError(new AnthropicProvider(claudeSettings(hang.origin), { ...CLAUDE_OPTS, timeoutMs: 200 }).generate(request()));
  assert.equal(timeout.kind, 'timeout');

  const port = await deadPort();
  const network = await providerError(new AnthropicProvider(claudeSettings(`http://127.0.0.1:${port}`), CLAUDE_OPTS).generate(request()));
  assert.equal(network.kind, 'network');
});

// =====================================================================
// parseSse
// =====================================================================

const enc = new TextEncoder();

async function* chunksOf(parts: Array<string | Uint8Array>): AsyncGenerator<Uint8Array> {
  for (const p of parts) yield typeof p === 'string' ? enc.encode(p) : p;
}

async function sseEvents(parts: Array<string | Uint8Array>): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const ev of parseSse(chunksOf(parts))) out.push(ev);
  return out;
}

test('parseSse: CRLF line endings are handled like LF', async () => {
  assert.deepEqual(await sseEvents(['event: a\r\ndata: 1\r\n\r\nevent: b\r\ndata: 2\r\n\r\n']), [
    { event: 'a', data: '1' },
    { event: 'b', data: '2' },
  ]);
  assert.deepEqual(await sseEvents(['data: lf\n\ndata: crlf\r\n\r\ndata: cr\r\r']), [
    { event: 'message', data: 'lf' },
    { event: 'message', data: 'crlf' },
    { event: 'message', data: 'cr' },
  ]);
});

test('parseSse: events split across chunks at every possible point give the same events', async () => {
  const stream = 'event: delta\r\ndata: {"t":"héllo"}\r\n\r\n: keep-alive\n\ndata: line one\ndata: line two\n\nevent: end\rdata: [DONE]\r\r';
  const expected: SseEvent[] = [
    { event: 'delta', data: '{"t":"héllo"}' },
    { event: 'message', data: 'line one\nline two' },
    { event: 'end', data: '[DONE]' },
  ];
  assert.deepEqual(await sseEvents([stream]), expected);
  const bytes = enc.encode(stream);
  for (let i = 1; i < bytes.length; i++) {
    assert.deepEqual(await sseEvents([bytes.slice(0, i), bytes.slice(i)]), expected, `split at byte ${i}`);
  }
  assert.deepEqual(await sseEvents([...bytes].map((b) => Uint8Array.of(b))), expected, 'one byte per chunk');
});

test('parseSse: comment lines are ignored, including inside an event', async () => {
  assert.deepEqual(await sseEvents([': ping\n\n', ':\n\n', 'data: a\n: note in the middle\ndata: b\n\n']), [{ event: 'message', data: 'a\nb' }]);
});

test('parseSse: multi-line data is joined with newlines and keeps empty lines of data', async () => {
  assert.deepEqual(await sseEvents(['data: first\ndata:\ndata: third\n\n']), [{ event: 'message', data: 'first\n\nthird' }]);
});

test('parseSse: a lone CR at a chunk boundary followed by LF is one line break, not two', async () => {
  // If the CR and LF were treated as two line endings, the blank line between them would end the event early.
  assert.deepEqual(await sseEvents(['data: a\r', '\ndata: b\r', '\n\r', '\n']), [{ event: 'message', data: 'a\nb' }]);
});

test('parseSse: a lone CR at a chunk boundary followed by more text is a CR line ending', async () => {
  assert.deepEqual(await sseEvents(['data: a\r', 'data: b\r', '\r', 'data: c\r\r']), [
    { event: 'message', data: 'a\nb' },
    { event: 'message', data: 'c' },
  ]);
});

test('parseSse: a CR that ends the very last chunk is a line ending, not part of the data', async () => {
  assert.deepEqual(await sseEvents(['data: tail\r']), [{ event: 'message', data: 'tail' }]);
});

test('parseSse: field parsing follows the spec (default event name, one optional space, unknown fields ignored)', async () => {
  assert.deepEqual(
    await sseEvents(['data:no-space\n\n', 'data:  two spaces\n\n', 'id: 7\nretry: 1000\nfoo: bar\ndata: x\n\n', 'data\n\n']),
    [
      { event: 'message', data: 'no-space' },
      { event: 'message', data: ' two spaces' },
      { event: 'message', data: 'x' },
      { event: 'message', data: '' },
    ],
  );
});

test('parseSse: an event name without data is not dispatched and does not leak into the next event', async () => {
  assert.deepEqual(await sseEvents(['event: lonely\n\ndata: next\n\n']), [{ event: 'message', data: 'next' }]);
});

test('parseSse: a final event without a trailing blank line is still delivered', async () => {
  assert.deepEqual(await sseEvents(['data: one\n\n', 'event: last\ndata: two']), [
    { event: 'message', data: 'one' },
    { event: 'last', data: 'two' },
  ]);
  assert.deepEqual(await sseEvents([]), []);
});

test('parseSse: a multi-byte character split across chunks is decoded intact', async () => {
  const bytes = enc.encode('data: नमस्ते 👋\n\n');
  const mid = 8; // inside the first Devanagari character
  assert.deepEqual(await sseEvents([bytes.slice(0, mid), bytes.slice(mid, mid + 1), bytes.slice(mid + 1)]), [{ event: 'message', data: 'नमस्ते 👋' }]);
});

// =====================================================================
// shared error helpers
// =====================================================================

test('kindFromStatus maps HTTP statuses to error kinds', () => {
  const table: Array<[number, string]> = [
    [429, 'rate_limit'],
    [529, 'overloaded'],
    [503, 'overloaded'],
    [401, 'auth'],
    [403, 'auth'],
    [404, 'not_found'],
    [408, 'timeout'],
    [500, 'server'],
    [502, 'server'],
    [400, 'bad_request'],
    [422, 'bad_request'],
  ];
  for (const [status, kind] of table) assert.equal(kindFromStatus(status), kind, `status ${status}`);
});

test('parseRetryAfter reads seconds and HTTP dates and ignores garbage', () => {
  const now = Date.UTC(2026, 9, 19, 12, 0, 0);
  assert.equal(parseRetryAfter('3', now), 3000);
  assert.equal(parseRetryAfter('0.5', now), 500);
  assert.equal(parseRetryAfter('0', now), 0);
  assert.equal(parseRetryAfter('-5', now), 0);
  assert.equal(parseRetryAfter(new Date(now + 9000).toUTCString(), now), 9000);
  assert.equal(parseRetryAfter(new Date(now - 9000).toUTCString(), now), 0);
  assert.equal(parseRetryAfter('soon', now), undefined);
  assert.equal(parseRetryAfter('', now), undefined);
  assert.equal(parseRetryAfter(null, now), undefined);
  assert.equal(parseRetryAfter(undefined, now), undefined);
});

test('ProviderError.retryable is true only for transient kinds', () => {
  const retryable = ['rate_limit', 'overloaded', 'server', 'network', 'timeout'] as const;
  const permanent = ['auth', 'bad_request', 'not_found', 'aborted'] as const;
  for (const k of retryable) assert.equal(new ProviderError(k, 'p', 'm').retryable, true, k);
  for (const k of permanent) assert.equal(new ProviderError(k, 'p', 'm').retryable, false, k);
});

test('Gemini: a redirect is not followed, so the API key header is never sent to another host', async (t) => {
  const other = await startServer((_req, res) => sendJson(res, 200, gemReply([{ text: 'stolen' }])));
  t.after(() => other.close());
  const srv = await startServer((_req, res) => {
    res.writeHead(307, { location: `${other.origin}/v1beta/models/gemini-test:generateContent` });
    res.end();
  });
  t.after(() => srv.close());
  const err = await providerError(new GeminiProvider(gemSettings(srv.origin), GEM_OPTS).generate(request()));
  assert.equal(err.retryable, false);
  assert.equal(other.seen.length, 0, 'the redirect target was never called');
});
