/**
 * Replay protection for signed vendor requests: a nonce may be used once per key within the
 * timestamp window. In-memory per instance (adequate for the pilot together with the ±5 minute
 * timestamp window and per-event idempotency). Phase B: move to a shared store if multi-instance
 * replay becomes a concern.
 */
export class HubNonceCache {
  private readonly seen = new Map<string, number>();
  private lastSweep = Date.now();

  constructor(private readonly ttlMs = 10 * 60 * 1000) {}

  /** Returns true when the nonce is fresh (and records it); false when it was already used. */
  consume(keyId: string, nonce: string, nowMs = Date.now()): boolean {
    this.sweep(nowMs);
    const k = `${keyId}:${nonce}`;
    const exp = this.seen.get(k);
    if (exp !== undefined && exp > nowMs) return false;
    this.seen.set(k, nowMs + this.ttlMs);
    return true;
  }

  private sweep(nowMs: number) {
    if (nowMs - this.lastSweep < 60_000 && this.seen.size < 50_000) return;
    this.lastSweep = nowMs;
    for (const [k, exp] of this.seen) {
      if (exp <= nowMs) this.seen.delete(k);
    }
  }

  get size(): number {
    return this.seen.size;
  }
}
