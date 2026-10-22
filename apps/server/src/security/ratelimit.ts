/**
 * In-memory sliding-window rate limiter.
 *
 * The web tier is a single process, so a Map is the
 * whole implementation. The window is approximated with two fixed buckets,
 * weighted by how far we are into the current one, which avoids the burst at
 * bucket boundaries without storing every request timestamp.
 */
export interface RateDecision {
  ok: boolean;
  remaining: number;
  /** Seconds until a request would be allowed again (0 when ok). */
  retryAfter: number;
}

interface Bucket {
  start: number;
  current: number;
  previous: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = 0;

  constructor(
    public readonly limit: number,
    public readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Count one hit against `key` and report whether it is allowed. */
  take(key: string, cost = 1): RateDecision {
    const now = this.now();
    this.sweep(now);
    const b = this.roll(key, now);
    const elapsed = (now - b.start) / this.windowMs;
    const used = b.previous * (1 - elapsed) + b.current;
    if (used + cost > this.limit) {
      const retryAfter = Math.max(1, Math.ceil((this.windowMs * (1 - elapsed)) / 1000));
      return { ok: false, remaining: 0, retryAfter };
    }
    b.current += cost;
    return { ok: true, remaining: Math.max(0, Math.floor(this.limit - used - cost)), retryAfter: 0 };
  }

  /** Forget a key, e.g. after a successful login. */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  private roll(key: string, now: number): Bucket {
    let b = this.buckets.get(key);
    if (!b) {
      b = { start: now, current: 0, previous: 0 };
      this.buckets.set(key, b);
      return b;
    }
    const windows = Math.floor((now - b.start) / this.windowMs);
    if (windows === 1) {
      b.previous = b.current;
      b.current = 0;
      b.start += this.windowMs;
    } else if (windows > 1) {
      b.previous = 0;
      b.current = 0;
      b.start = now;
    }
    return b;
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    for (const [key, b] of this.buckets) {
      if (now - b.start > this.windowMs * 2) this.buckets.delete(key);
    }
  }
}
