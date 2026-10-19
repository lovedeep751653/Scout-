import { kindFromStatus, parseRetryAfter, ProviderError } from './types.ts';

export interface HttpCall {
  provider: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
  retryAfterFromBody?: (body: unknown) => number | undefined;
}

function combinedSignal(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; timeout: AbortSignal } {
  const timeout = AbortSignal.timeout(timeoutMs);
  return { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, timeout };
}

function errorMessageFrom(body: unknown): string {
  if (body && typeof body === 'object') {
    const err = (body as { error?: unknown }).error;
    if (typeof err === 'string') return err;
    if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
      return (err as { message: string }).message;
    }
    if (typeof (body as { message?: unknown }).message === 'string') return (body as { message: string }).message;
  }
  return '';
}

export async function postJson(call: HttpCall): Promise<Response> {
  const { signal, timeout } = combinedSignal(call.signal, call.timeoutMs);
  let res: Response;
  try {
    res = await fetch(call.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...call.headers },
      body: JSON.stringify(call.body),
      // Never follow a redirect: fetch would forward key headers such as x-goog-api-key.
      redirect: 'manual',
      signal,
    });
  } catch (err) {
    if (timeout.aborted) throw new ProviderError('timeout', call.provider, `${call.provider} did not answer in time.`, { cause: err });
    if (call.signal?.aborted) throw new ProviderError('aborted', call.provider, 'Request was cancelled.', { cause: err });
    throw new ProviderError('network', call.provider, `Could not reach ${call.provider}.`, { cause: err });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let parsed: unknown = undefined;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const detail = errorMessageFrom(parsed) || text.slice(0, 300);
    throw new ProviderError(kindFromStatus(res.status), call.provider, `${call.provider} API error ${res.status}: ${detail}`, {
      status: res.status,
      retryAfterMs: parseRetryAfter(res.headers.get('retry-after')) ?? call.retryAfterFromBody?.(parsed),
    });
  }
  return res;
}

export function wrapStreamError(provider: string, err: unknown, signal?: AbortSignal): ProviderError {
  if (err instanceof ProviderError) return err;
  if (signal?.aborted) return new ProviderError('aborted', provider, 'Request was cancelled.', { cause: err });
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return new ProviderError('timeout', provider, `${provider} stopped answering.`, { cause: err });
  }
  return new ProviderError('network', provider, `Connection to ${provider} broke.`, { cause: err });
}
