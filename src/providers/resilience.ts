import { ProviderError, type GenerateRequest, type GenerateResult, type ModelProvider, type StreamEvent } from './types.ts';

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  // A provider asking us to wait longer than this is not retried, so a fallback can answer.
  maxRetryAfterMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onRetry?: (info: { provider: string; attempt: number; delayMs: number; error: ProviderError }) => void;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ProviderError('aborted', 'scout', 'Request was cancelled.'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new ProviderError('aborted', 'scout', 'Request was cancelled.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function toProviderError(err: unknown, provider: string): ProviderError {
  if (err instanceof ProviderError) return err;
  return new ProviderError('server', provider, err instanceof Error ? err.message : String(err), { cause: err });
}

export class RetryingProvider implements ModelProvider {
  readonly name: string;
  readonly model: string;
  private readonly inner: ModelProvider;
  private readonly opts: Required<Omit<RetryOptions, 'onRetry'>> & Pick<RetryOptions, 'onRetry'>;

  constructor(inner: ModelProvider, opts: RetryOptions) {
    this.inner = inner;
    this.name = inner.name;
    this.model = inner.model;
    this.opts = {
      baseDelayMs: 800,
      maxDelayMs: 15_000,
      maxRetryAfterMs: 30_000,
      sleep,
      ...opts,
    };
  }

  private delayFor(err: ProviderError, attempt: number): number | null {
    if (!err.retryable || attempt >= this.opts.maxRetries) return null;
    if (err.retryAfterMs !== undefined) {
      if (err.retryAfterMs > this.opts.maxRetryAfterMs) return null;
      return Math.max(200, err.retryAfterMs);
    }
    const exp = this.opts.baseDelayMs * 2 ** attempt;
    return Math.min(this.opts.maxDelayMs, exp * (0.75 + Math.random() * 0.5));
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.inner.generate(req);
      } catch (raw) {
        const err = toProviderError(raw, this.name);
        const delay = this.delayFor(err, attempt);
        if (delay === null || req.signal?.aborted) throw err;
        this.opts.onRetry?.({ provider: this.name, attempt: attempt + 1, delayMs: delay, error: err });
        await this.opts.sleep(delay, req.signal);
      }
    }
  }

  async *stream(req: GenerateRequest): AsyncIterable<StreamEvent> {
    for (let attempt = 0; ; attempt++) {
      let yielded = false;
      try {
        for await (const ev of this.inner.stream(req)) {
          yielded = true;
          yield ev;
        }
        return;
      } catch (raw) {
        const err = toProviderError(raw, this.name);
        const delay = yielded ? null : this.delayFor(err, attempt);
        if (delay === null || req.signal?.aborted) throw err;
        this.opts.onRetry?.({ provider: this.name, attempt: attempt + 1, delayMs: delay, error: err });
        await this.opts.sleep(delay, req.signal);
      }
    }
  }
}

const FALLBACK_KINDS = new Set(['rate_limit', 'overloaded', 'server', 'network', 'timeout', 'auth', 'not_found']);

export class FallbackProvider implements ModelProvider {
  readonly name: string;
  readonly model: string;
  private readonly primary: ModelProvider;
  private readonly fallback: ModelProvider;
  private readonly onFallback?: (err: ProviderError) => void;

  constructor(primary: ModelProvider, fallback: ModelProvider, onFallback?: (err: ProviderError) => void) {
    this.primary = primary;
    this.fallback = fallback;
    this.name = primary.name;
    this.model = primary.model;
    this.onFallback = onFallback;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    try {
      return await this.primary.generate(req);
    } catch (raw) {
      const err = toProviderError(raw, this.primary.name);
      if (!FALLBACK_KINDS.has(err.kind) || req.signal?.aborted) throw err;
      this.onFallback?.(err);
      return this.fallback.generate(req);
    }
  }

  async *stream(req: GenerateRequest): AsyncIterable<StreamEvent> {
    let yielded = false;
    try {
      for await (const ev of this.primary.stream(req)) {
        yielded = true;
        yield ev;
      }
      return;
    } catch (raw) {
      const err = toProviderError(raw, this.primary.name);
      if (yielded || !FALLBACK_KINDS.has(err.kind) || req.signal?.aborted) throw err;
      this.onFallback?.(err);
    }
    yield* this.fallback.stream(req);
  }
}
