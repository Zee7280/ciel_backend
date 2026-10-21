import { stripSecrets } from './strip-secrets.interceptor';

describe('stripSecrets', () => {
  it('removes password / reset token keys at any depth, in arrays too', () => {
    const body = {
      success: true,
      data: {
        id: 'c1',
        participants: [
          {
            userId: 'u1',
            user: {
              id: 'u1',
              name: 'A',
              password: '$2b$hash',
              passwordResetToken: 'tok',
              passwordResetExpiry: new Date(),
            },
          },
        ],
      },
    };
    const out = stripSecrets(body);
    const u = out.data.participants[0].user;
    expect(u).toEqual({ id: 'u1', name: 'A' });
    expect(JSON.stringify(out)).not.toMatch(/\$2b\$hash|passwordReset/);
  });

  it('keeps everything else intact (dates, null, numbers, nested)', () => {
    const d = new Date('2026-01-01T00:00:00Z');
    const out = stripSecrets({ a: 1, b: null, c: d, d: [{ e: 'x' }] });
    expect(out).toEqual({ a: 1, b: null, c: d, d: [{ e: 'x' }] });
    expect(out.c).toBe(d);
  });

  it('survives circular structures', () => {
    const a: { name: string; password?: string; self?: unknown } = {
      name: 'a',
      password: 'p',
    };
    a.self = a;
    const out = stripSecrets(a);
    expect(out.password).toBeUndefined();
    expect(out.name).toBe('a');
  });

  it('does not touch primitives', () => {
    expect(stripSecrets('x')).toBe('x');
    expect(stripSecrets(5)).toBe(5);
    expect(stripSecrets(undefined)).toBeUndefined();
  });
});

describe('stripSecrets — approval tokens', () => {
  it('masks magic-link tokens but keeps the key so "is pending" checks still work', () => {
    const out = stripSecrets({
      id: 'o1',
      partnerToken: 'aaaaaaaa-1111',
      faculty_verification_token: 'bbbbbbbb-2222',
      execution_verification_token: 'cccccccc-3333',
      liaisonToken: 'dddddddd-4444',
      title: 'T',
    });
    expect(JSON.stringify(out)).not.toMatch(
      /aaaaaaaa|bbbbbbbb|cccccccc|dddddddd/,
    );
    expect(out.partnerToken).toBe('hidden');
    expect(out.faculty_verification_token).toBe('hidden');
    expect(out.title).toBe('T');
  });

  it('leaves empty / null tokens alone (so "no token" stays falsy)', () => {
    const out = stripSecrets({
      partnerToken: null,
      liaisonToken: '',
      execution_verification_token: undefined,
    });
    expect(out.partnerToken).toBeNull();
    expect(out.liaisonToken).toBe('');
    expect(out.execution_verification_token).toBeUndefined();
  });
});
