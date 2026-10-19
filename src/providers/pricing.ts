import type { Usage } from './types.ts';

export interface Price {
  inputPerM: number;
  outputPerM: number;
  // Claude Haiku 5.5 bills prompts over 100K tokens at a higher rate.
  longPromptThreshold?: number;
  longInputPerM?: number;
  longOutputPerM?: number;
  cacheReadMultiplier?: number;
  cacheWriteMultiplier?: number;
}

// USD per million tokens from Anthropic's official model table (cached 2026-10-06).
// Other providers vary by plan (Gemini and OpenRouter have free tiers), so they are
// unknown unless MODEL_PRICE_INPUT_PER_M / MODEL_PRICE_OUTPUT_PER_M are set.
const KNOWN: Record<string, Price> = {
  'claude-haiku-5-5': { inputPerM: 0.1, outputPerM: 0.5, longPromptThreshold: 100_000, longInputPerM: 0.5, longOutputPerM: 2.5, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 },
  'claude-haiku-4-5': { inputPerM: 1, outputPerM: 5, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 },
  'claude-sonnet-5-5': { inputPerM: 2, outputPerM: 10, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 },
  'claude-sonnet-5': { inputPerM: 2, outputPerM: 10, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 },
  'claude-sonnet-4-6': { inputPerM: 3, outputPerM: 15, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 },
  'claude-opus-5-5': { inputPerM: 4, outputPerM: 20, cacheReadMultiplier: 0.05, cacheWriteMultiplier: 1.25 },
  'claude-opus-5': { inputPerM: 5, outputPerM: 25, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 },
  'claude-opus-4-8': { inputPerM: 5, outputPerM: 25, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 },
  'claude-opus-4-7': { inputPerM: 5, outputPerM: 25, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 },
  'claude-fable-5-1': { inputPerM: 10, outputPerM: 50, cacheReadMultiplier: 0.025, cacheWriteMultiplier: 1.25 },
  'mock-1': { inputPerM: 0, outputPerM: 0 },
};

export interface PriceOverride {
  inputPerM: number | null;
  outputPerM: number | null;
}

export function priceFor(model: string, override?: PriceOverride): Price | null {
  if (override && override.inputPerM !== null && override.outputPerM !== null) {
    return { inputPerM: override.inputPerM, outputPerM: override.outputPerM };
  }
  const exact = KNOWN[model];
  if (exact) return exact;
  const prefix = Object.keys(KNOWN).find((k) => model.startsWith(`${k}-`));
  return prefix ? KNOWN[prefix]! : null;
}

// Returns micro-dollars (1 USD = 1,000,000) so costs can be summed as integers.
export function costMicroUsd(usage: Usage, price: Price | null): number {
  if (!price) return 0;
  const long = price.longPromptThreshold !== undefined && usage.inputTokens > price.longPromptThreshold;
  const inRate = long ? (price.longInputPerM ?? price.inputPerM) : price.inputPerM;
  const outRate = long ? (price.longOutputPerM ?? price.outputPerM) : price.outputPerM;
  const cached = usage.cachedInputTokens ?? 0;
  const written = usage.cacheWriteTokens ?? 0;
  const plain = Math.max(0, usage.inputTokens - cached - written);
  const inputCost = plain * inRate + cached * inRate * (price.cacheReadMultiplier ?? 1) + written * inRate * (price.cacheWriteMultiplier ?? 1);
  return Math.round(inputCost + usage.outputTokens * outRate);
}
