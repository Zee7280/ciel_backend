import { ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RATE_LIMIT_KEY, RateLimitGuard, RateLimitRule } from './rate-limit.guard';

function ctx(req: any, rules: RateLimitRule[]) {
  const reflector = new Reflector();
  jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((k) => (k === RATE_LIMIT_KEY ? rules : undefined));
  const res = { setHeader: jest.fn() };
  const context = {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
  return { guard: new RateLimitGuard(reflector), context, res };
}

describe('RateLimitGuard', () => {
  const rule: RateLimitRule = { name: 't', limit: 3, windowMs: 60_000, by: 'ip+email' };
  const req = (ip: string, email?: string) => ({ ip, headers: {}, body: email ? { email } : {} });

  it('allows up to the limit then answers 429 with Retry-After', () => {
    const { guard, context, res } = ctx(req('1.1.1.1', 'a@x.com'), [rule]);
    for (let i = 0; i < 3; i++) expect(guard.canActivate(context)).toBe(true);
    try {
      guard.canActivate(context);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpException);
      expect((e as HttpException).getStatus()).toBe(429);
    }
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(String));
  });

  it('counts per IP+email — another account or IP is unaffected', () => {
    const a = ctx(req('1.1.1.1', 'a@x.com'), [rule]);
    for (let i = 0; i < 3; i++) a.guard.canActivate(a.context);
    expect(() => a.guard.canActivate(a.context)).toThrow(HttpException);
    // same guard instance, different email / ip
    const sameGuardOtherEmail = { ...a.context, switchToHttp: () => ({ getRequest: () => req('1.1.1.1', 'b@x.com'), getResponse: () => ({}) }) } as unknown as ExecutionContext;
    expect(a.guard.canActivate(sameGuardOtherEmail)).toBe(true);
    const otherIp = { ...a.context, switchToHttp: () => ({ getRequest: () => req('2.2.2.2', 'a@x.com'), getResponse: () => ({}) }) } as unknown as ExecutionContext;
    expect(a.guard.canActivate(otherIp)).toBe(true);
  });

  it('email-only rules stop many IPs hammering one victim; email is case/space-insensitive', () => {
    const r: RateLimitRule = { name: 'v', limit: 2, windowMs: 60_000, by: 'email' };
    const { guard, context } = ctx(req('9.9.9.1', 'Victim@X.com '), [r]);
    guard.canActivate(context);
    const other = (ip: string) => ({ ...context, switchToHttp: () => ({ getRequest: () => req(ip, ' victim@x.com'), getResponse: () => ({}) }) }) as unknown as ExecutionContext;
    guard.canActivate(other('9.9.9.2'));
    expect(() => guard.canActivate(other('9.9.9.3'))).toThrow(HttpException);
  });

  it('a blocked request does not extend the window; the window expires', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const r: RateLimitRule = { name: 'w', limit: 1, windowMs: 1000, by: 'ip' };
    const { guard, context } = ctx(req('3.3.3.3'), [r]);
    guard.canActivate(context);
    expect(() => guard.canActivate(context)).toThrow(HttpException);
    jest.setSystemTime(new Date('2026-01-01T00:00:01.500Z'));
    expect(guard.canActivate(context)).toBe(true);
    jest.useRealTimers();
  });

  it('uses X-Forwarded-For first hop; no rules means pass-through', () => {
    const r: RateLimitRule = { name: 'x', limit: 1, windowMs: 60_000, by: 'ip' };
    const mk = (xff: string) => ctx({ ip: '10.0.0.1', headers: { 'x-forwarded-for': xff }, body: {} }, [r]);
    const a = mk('5.5.5.5, 10.0.0.1');
    a.guard.canActivate(a.context);
    expect(() => a.guard.canActivate(a.context)).toThrow(HttpException);
    const none = ctx(req('1.1.1.1'), []);
    expect(none.guard.canActivate(none.context)).toBe(true);
  });
});
