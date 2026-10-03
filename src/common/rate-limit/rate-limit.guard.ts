import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

export const RATE_LIMIT_KEY = 'ciel:rate-limit';

export interface RateLimitRule {
  /** Short label so different routes keep separate counters. */
  name: string;
  /** Max requests per window. */
  limit: number;
  windowMs: number;
  /**
   * What the counter is keyed on:
   *  - 'ip'            every caller IP separately (default)
   *  - 'ip+email'      IP + the `email` body field (brute-force on one account from one IP)
   *  - 'email'         the `email` body field alone (stops a botnet mailing one victim)
   *  - 'user'          the authenticated user id (falls back to IP when anonymous)
   */
  by?: 'ip' | 'ip+email' | 'email' | 'user';
  message?: string;
}

/** Repeatable: several rules on one route are all enforced. */
export const RateLimit = (...rules: RateLimitRule[]) =>
  SetMetadata(RATE_LIMIT_KEY, rules);

type Bucket = number[];

/**
 * Dependency-free sliding-window limiter, held in process memory. It is a speed bump against
 * credential stuffing, OTP / reset-mail abuse and LLM-cost abuse. It is per Node instance — on a
 * multi-instance deploy put a shared limiter (gateway / Redis) in front for hard guarantees.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = Date.now();

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const rules =
      this.reflector.getAllAndOverride<RateLimitRule[] | undefined>(
        RATE_LIMIT_KEY,
        [context.getHandler(), context.getClass()],
      ) ?? [];
    if (rules.length === 0) return true;

    const req = context.switchToHttp().getRequest();
    const now = Date.now();
    this.sweep(now);

    // Check every rule first, record only if all pass (a blocked call must not extend the window).
    const keyed = rules.map((rule) => ({ rule, key: this.keyFor(rule, req) }));
    for (const { rule, key } of keyed) {
      const hits = this.recent(key, now, rule.windowMs);
      if (hits.length >= rule.limit) {
        const retryAfterSec = Math.max(
          1,
          Math.ceil((hits[0] + rule.windowMs - now) / 1000),
        );
        const res = context.switchToHttp().getResponse();
        res?.setHeader?.('Retry-After', String(retryAfterSec));
        throw new HttpException(
          {
            success: false,
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message:
              rule.message ??
              `Too many attempts. Please wait ${retryAfterSec} second${retryAfterSec === 1 ? '' : 's'} and try again.`,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
    for (const { key } of keyed) {
      const bucket = this.buckets.get(key) ?? [];
      bucket.push(now);
      this.buckets.set(key, bucket);
    }
    return true;
  }

  private recent(key: string, now: number, windowMs: number): Bucket {
    const bucket = this.buckets.get(key);
    if (!bucket) return [];
    const fresh = bucket.filter((t) => now - t < windowMs);
    if (fresh.length !== bucket.length) this.buckets.set(key, fresh);
    return fresh;
  }

  private keyFor(rule: RateLimitRule, req: any): string {
    const ip = this.clientIp(req);
    const email = String(req?.body?.email ?? '')
      .trim()
      .toLowerCase();
    switch (rule.by ?? 'ip') {
      case 'email':
        return `${rule.name}|e|${email || ip}`;
      case 'ip+email':
        return `${rule.name}|ie|${ip}|${email}`;
      case 'user':
        return `${rule.name}|u|${req?.user?.id ?? ip}`;
      default:
        return `${rule.name}|i|${ip}`;
    }
  }

  private clientIp(req: any): string {
    const fwd = req?.headers?.['x-forwarded-for'];
    const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
    return first || req?.ip || req?.socket?.remoteAddress || 'unknown';
  }

  /** Drop idle buckets so the map can't grow without bound. */
  private sweep(now: number) {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    const MAX_WINDOW = 24 * 60 * 60 * 1000;
    for (const [key, bucket] of this.buckets) {
      if (bucket.length === 0 || now - bucket[bucket.length - 1] > MAX_WINDOW) {
        this.buckets.delete(key);
      }
    }
  }
}
