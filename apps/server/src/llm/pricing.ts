import { config } from '../config.js';

/** USD per million tokens. */
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  /** A write to the five-minute cache. */
  cacheWrite: number;
  /** A write to the one-hour cache (LLM_CACHE_TTL=1h). Twice the input price when not given. */
  cacheWrite1h?: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

// List prices checked 2026-11-10. Matched by substring so provider prefixes
// ("anthropic.claude-opus-5-5", "anthropic/claude-opus-5.5") still resolve.
// Override or extend with LLM_PRICES_JSON.
const DEFAULT_PRICES: Record<string, Price> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, cacheWrite1h: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, cacheWrite1h: 4 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 },
  'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10, cacheWrite1h: 16 },
};

let table: Record<string, Price> | undefined;
function prices(): Record<string, Price> {
  if (table) return table;
  table = { ...DEFAULT_PRICES };
  const raw = config().LLM_PRICES_JSON;
  if (raw) {
    try {
      Object.assign(table, JSON.parse(raw) as Record<string, Price>);
    } catch {
      // A malformed override must not take the app down; costs just fall back.
    }
  }
  return table;
}
export function resetPricesForTests(): void {
  table = undefined;
}

export function priceFor(model: string): Price | undefined {
  const t = prices();
  if (t[model]) return t[model];
  const norm = model.toLowerCase().replace(/\./g, '-');
  const key = Object.keys(t)
    .sort((a, b) => b.length - a.length)
    .find((k) => norm.includes(k.toLowerCase()));
  return key ? t[key] : undefined;
}

/**
 * Estimated cost in millionths of a dollar. Unknown models cost 0 (tokens are
 * still counted). `longCache` when the call wrote to the one-hour cache.
 */
export function costMicroUsd(model: string, u: Usage, opts: { longCache?: boolean } = {}): number {
  const p = priceFor(model);
  if (!p) return 0;
  const write = opts.longCache ? (p.cacheWrite1h ?? p.input * 2) : p.cacheWrite;
  return Math.round(
    u.inputTokens * p.input +
      u.outputTokens * p.output +
      u.cacheReadTokens * p.cacheRead +
      u.cacheWriteTokens * write,
  );
}

export function totalTokens(u: Usage): number {
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}
