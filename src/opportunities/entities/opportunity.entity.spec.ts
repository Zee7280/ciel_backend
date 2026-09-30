import { verificationTokenTtlMs } from './opportunity.entity';
import { stampVerificationTokenExpiry } from '../opportunity-token-expiry.subscriber';

const blank = () => ({
  partnerToken: null as any,
  partnerTokenExpiresAt: null as Date | null,
  faculty_verification_token: null as any,
  facultyTokenExpiresAt: null as Date | null,
});

describe('verification token expiry stamping', () => {
  it('stamps a fresh expiry on insert for newly issued tokens', () => {
    const o = { ...blank(), partnerToken: 'p-1', faculty_verification_token: 'f-1' };
    stampVerificationTokenExpiry(o, null, 1000);
    expect(o.partnerTokenExpiresAt!.getTime()).toBe(1000 + verificationTokenTtlMs());
    expect(o.facultyTokenExpiresAt!.getTime()).toBe(1000 + verificationTokenTtlMs());
  });

  it('re-stamps only when the token was rotated; unchanged token keeps its expiry', () => {
    const keep = new Date('2030-01-01');
    const same = { ...blank(), partnerToken: 'p-1', partnerTokenExpiresAt: keep };
    stampVerificationTokenExpiry(same, { partnerToken: 'p-1' }, 1000);
    expect(same.partnerTokenExpiresAt).toBe(keep);
    const rotated = { ...same };
    stampVerificationTokenExpiry(rotated, { partnerToken: 'old' }, 1000);
    expect(rotated.partnerTokenExpiresAt!.getTime()).toBe(1000 + verificationTokenTtlMs());
  });

  it('does not retroactively expire legacy rows with an unchanged token', () => {
    const o = { ...blank(), partnerToken: 'legacy' };
    stampVerificationTokenExpiry(o, { partnerToken: 'legacy' });
    expect(o.partnerTokenExpiresAt).toBeNull();
  });

  it('clears expiry when the token is revoked', () => {
    const o = { ...blank(), partnerTokenExpiresAt: new Date() };
    stampVerificationTokenExpiry(o, { partnerToken: 'p' });
    expect(o.partnerTokenExpiresAt).toBeNull();
  });

  it('honours VERIFICATION_TOKEN_TTL_DAYS', () => {
    process.env.VERIFICATION_TOKEN_TTL_DAYS = '2';
    expect(verificationTokenTtlMs()).toBe(2 * 86400000);
    delete process.env.VERIFICATION_TOKEN_TTL_DAYS;
    expect(verificationTokenTtlMs()).toBe(30 * 86400000);
  });
});
