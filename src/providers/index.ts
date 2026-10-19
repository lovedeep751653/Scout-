import type { Config, ProviderSettings } from '../config.ts';
import { AnthropicProvider } from './anthropic.ts';
import { GeminiProvider } from './gemini.ts';
import { MockProvider } from './mock.ts';
import { OpenAiCompatibleProvider } from './openai-compatible.ts';
import { FallbackProvider, RetryingProvider, type RetryOptions } from './resilience.ts';
import type { ModelProvider, ProviderError } from './types.ts';

export function createBaseProvider(settings: ProviderSettings, config: Config): ModelProvider {
  const opts = { timeoutMs: config.modelTimeoutMs, maxOutputTokens: config.maxOutputTokens };
  switch (settings.provider) {
    case 'anthropic':
      return new AnthropicProvider(settings, opts);
    case 'gemini':
      return new GeminiProvider(settings, opts);
    case 'groq':
    case 'openrouter':
    case 'openai-compatible':
      return new OpenAiCompatibleProvider(settings, { ...opts, publicUrl: config.publicUrl });
    case 'mock':
      return new MockProvider({ model: settings.model });
  }
}

export function createModelStack(
  config: Config,
  hooks: { onRetry?: RetryOptions['onRetry']; onFallback?: (err: ProviderError) => void } = {},
): ModelProvider {
  const retry = { maxRetries: config.modelMaxRetries, onRetry: hooks.onRetry };
  const primary = new RetryingProvider(createBaseProvider(config.primary, config), retry);
  if (!config.fallback) return primary;
  const fallback = new RetryingProvider(createBaseProvider(config.fallback, config), { ...retry, maxRetries: Math.min(1, config.modelMaxRetries) });
  return new FallbackProvider(primary, fallback, hooks.onFallback);
}
