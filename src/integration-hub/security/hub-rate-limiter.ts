/**
 * Sliding-window counter per key (platform id or connection id), in process memory. Returns the
 * seconds to wait when the limit is exceeded. Same trade-off as the core RateLimitGuard: a speed
 * bump per instance; hard multi-instance guarantees need a shared limiter (Phase B).
 */
export class HubRateLimiter {
  private readonly buckets = new Map<string, number[]>();
  private hits = 0;

  check(
    key: string,
    limit: number,
    windowMs = 60_000,
    nowMs = Date.now(),
  ): { allowed: boolean; retryAfterSeconds: number; remaining: number } {
    const cutoff = nowMs - windowMs;
    const arr = (this.buckets.get(key) ?? []).filter((t) => t > cutoff);
    if (arr.length >= limit) {
      this.hits += 1;
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((arr[0] + windowMs - nowMs) / 1000),
      );
      this.buckets.set(key, arr);
      return { allowed: false, retryAfterSeconds, remaining: 0 };
    }
    arr.push(nowMs);
    this.buckets.set(key, arr);
    if (this.buckets.size > 10_000) this.buckets.clear();
    return {
      allowed: true,
      retryAfterSeconds: 0,
      remaining: limit - arr.length,
    };
  }

  /** Number of refusals since process start (health screen). */
  get rateLimitHits(): number {
    return this.hits;
  }
}
