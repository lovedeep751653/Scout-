import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import type { Config } from '../config.ts';
import { redactText } from '../security/redact.ts';

export type RuntimeState = 'disabled' | 'starting' | 'downloading' | 'loading' | 'ready' | 'error';

export interface RuntimeStatus {
  state: RuntimeState;
  model: string;
  message: string;
  percent?: number;
  since: number;
}

export interface RuntimeLog {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

function nativeBase(openAiBase: string): string {
  return openAiBase.replace(/\/v1\/?$/, '');
}

function sameModel(a: string, b: string): boolean {
  const norm = (s: string) => (s.includes(':') ? s : `${s}:latest`).toLowerCase();
  return norm(a) === norm(b);
}

// Starts and watches the local Ollama runtime so the owner never has to. Scout talks to
// it over 127.0.0.1 only; Ollama has no login of its own, so it must never be public.
export class OllamaRuntime {
  private readonly config: Config;
  private readonly log: RuntimeLog;
  private readonly base: string;
  private child: ChildProcess | null = null;
  private current: RuntimeStatus;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private restarts = 0;

  constructor(config: Config, log: RuntimeLog) {
    this.config = config;
    this.log = log;
    this.base = nativeBase(config.primary.baseUrl);
    const enabled = config.primary.provider === 'ollama';
    this.current = {
      state: enabled ? 'starting' : 'disabled',
      model: config.primary.model,
      message: enabled ? 'Starting the local AI runtime.' : 'Scout is using a cloud AI provider.',
      since: Date.now(),
    };
  }

  status(): RuntimeStatus {
    return { ...this.current };
  }

  get ready(): boolean {
    return this.current.state === 'ready' || this.current.state === 'disabled';
  }

  private set(state: RuntimeState, message: string, percent?: number): void {
    const changed = state !== this.current.state;
    this.current = { state, model: this.config.primary.model, message, ...(percent !== undefined ? { percent } : {}), since: changed ? Date.now() : this.current.since };
    if (changed) (state === 'error' ? this.log.error : this.log.info)(`AI runtime: ${state} - ${message}`);
  }

  async start(): Promise<void> {
    if (this.current.state === 'disabled') return;
    try {
      if (this.config.ollama.autostart && !(await this.reachable())) this.spawnServer();
      await this.waitReachable(60_000);
      await this.ensureModel();
      this.set('loading', 'Loading the AI model into memory.');
      await this.warmUp();
      this.set('ready', 'The local AI model is ready.');
      this.restarts = 0;
    } catch (err) {
      this.set('error', (err as Error).message);
      this.scheduleRetry();
      return;
    }
    this.watch();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.child?.kill('SIGTERM');
    this.child = null;
  }

  private spawnServer(): void {
    const host = new URL(this.base).host;
    fs.mkdirSync(this.config.ollama.modelsDir, { recursive: true });
    const child = spawn(this.config.ollama.bin, ['serve'], {
      env: {
        ...process.env,
        OLLAMA_HOST: host,
        OLLAMA_MODELS: this.config.ollama.modelsDir,
        OLLAMA_KEEP_ALIVE: this.config.ollama.keepAlive,
        OLLAMA_CONTEXT_LENGTH: String(this.config.ollama.contextLength),
        OLLAMA_NUM_PARALLEL: process.env.OLLAMA_NUM_PARALLEL ?? '1',
        OLLAMA_MAX_LOADED_MODELS: process.env.OLLAMA_MAX_LOADED_MODELS ?? '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.on('error', (err) => {
      const msg = (err as NodeJS.ErrnoException).code === 'ENOENT'
        ? `The Ollama program was not found (looked for "${this.config.ollama.bin}"). Use the Scout Docker image, which includes it.`
        : `Could not start Ollama: ${err.message}`;
      this.set('error', msg);
    });
    child.on('exit', (code) => {
      if (this.child === child) this.child = null;
      if (!this.stopped && this.current.state !== 'error') this.set('error', `The AI runtime stopped (exit code ${code}). Restarting.`);
      if (!this.stopped) this.scheduleRetry();
    });
    const forward = (buf: Buffer) => {
      for (const line of buf.toString('utf8').split('\n')) {
        if (/level=(ERROR|WARN)/.test(line)) this.log.warn(`ollama: ${redactText(line).slice(0, 300)}`);
      }
    };
    child.stdout?.on('data', forward);
    child.stderr?.on('data', forward);
    this.child = child;
  }

  private async reachable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.base}/api/version`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async waitReachable(ms: number): Promise<void> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await this.reachable()) return;
      if (this.current.state === 'error') throw new Error(this.current.message);
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('The local AI runtime did not start within 60 seconds.');
  }

  private async hasModel(): Promise<boolean> {
    const res = await fetch(`${this.base}/api/tags`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Could not list local models (HTTP ${res.status}).`);
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    return (data.models ?? []).some((m) => sameModel(m.name, this.config.primary.model));
  }

  private async ensureModel(): Promise<void> {
    if (await this.hasModel()) return;
    if (!this.config.ollama.autoPull) throw new Error(`The model "${this.config.primary.model}" is not downloaded and OLLAMA_AUTO_PULL is off.`);
    this.set('downloading', `Downloading the AI model ${this.config.primary.model} (first start only).`, 0);
    const res = await fetch(`${this.base}/api/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.config.primary.model, stream: true }),
    });
    if (!res.ok || !res.body) throw new Error(`Model download failed to start (HTTP ${res.status}).`);
    const layers = new Map<string, { total: number; completed: number }>();
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const ev = JSON.parse(line) as { status?: string; digest?: string; total?: number; completed?: number; error?: string };
        if (ev.error) throw new Error(`Model download failed: ${ev.error}`);
        if (ev.digest && ev.total) layers.set(ev.digest, { total: ev.total, completed: ev.completed ?? 0 });
        const total = [...layers.values()].reduce((s, l) => s + l.total, 0);
        const done = [...layers.values()].reduce((s, l) => s + l.completed, 0);
        const percent = total ? Math.min(100, Math.floor((done / total) * 100)) : 0;
        this.set('downloading', `Downloading the AI model ${this.config.primary.model}: ${percent}%`, percent);
      }
    }
    if (!(await this.hasModel())) throw new Error('The model download finished but the model is still missing.');
  }

  private async warmUp(): Promise<void> {
    const res = await fetch(`${this.base}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.config.primary.model, prompt: '', keep_alive: /^-?\d+$/.test(this.config.ollama.keepAlive) ? Number(this.config.ollama.keepAlive) : this.config.ollama.keepAlive }),
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) throw new Error(`The AI model could not be loaded (HTTP ${res.status}). The server may not have enough memory.`);
    await res.text();
  }

  private scheduleRetry(): void {
    if (this.stopped || this.timer) return;
    const delay = Math.min(60_000, 5_000 * 2 ** Math.min(this.restarts++, 4));
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.stopped) {
        this.set('starting', 'Trying to start the local AI runtime again.');
        void this.start();
      }
    }, delay);
  }

  private watch(): void {
    const tick = async () => {
      this.timer = null;
      if (this.stopped) return;
      if (!(await this.reachable())) {
        this.set('error', 'The local AI runtime stopped answering. Restarting.');
        this.child?.kill('SIGKILL');
        this.child = null;
        this.scheduleRetry();
        return;
      }
      this.timer = setTimeout(tick, 30_000);
    };
    this.timer = setTimeout(tick, 30_000);
  }
}
