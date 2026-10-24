import { isCronSecretValid } from './cron-secret.guard';

describe('isCronSecretValid', () => {
  const secret = 'a-long-random-cron-secret-value';

  it('accepts the configured secret as a bearer token', () => {
    expect(isCronSecretValid(`Bearer ${secret}`, secret)).toBe(true);
    expect(isCronSecretValid(`bearer ${secret}`, secret)).toBe(true);
  });

  it('rejects a wrong, missing or malformed header', () => {
    expect(isCronSecretValid('Bearer nope', secret)).toBe(false);
    expect(isCronSecretValid(undefined, secret)).toBe(false);
    expect(isCronSecretValid(secret, secret)).toBe(false);
    expect(isCronSecretValid(`Basic ${secret}`, secret)).toBe(false);
  });

  it('fails closed when no usable secret is configured', () => {
    expect(isCronSecretValid('Bearer x', undefined)).toBe(false);
    expect(isCronSecretValid('Bearer x', '')).toBe(false);
    expect(isCronSecretValid('Bearer short', 'short')).toBe(false);
  });
});
