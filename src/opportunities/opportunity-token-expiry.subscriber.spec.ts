import { stampVerificationTokenExpiry } from './opportunity-token-expiry.subscriber';

type TokenRow = Parameters<typeof stampVerificationTokenExpiry>[0];
/** Partial write payloads (what a TypeORM `update(id, {…})` hands the subscriber). */
type PartialRow = Partial<TokenRow>;

const NOW = Date.parse('2026-10-17T00:00:00Z');
const past = new Date('2026-10-01T00:00:00Z');

describe('stampVerificationTokenExpiry', () => {
  it('stamps a fresh expiry on a newly issued or rotated token', () => {
    const row: PartialRow = {
      partnerToken: 'p2',
      faculty_verification_token: 'f2',
    };
    stampVerificationTokenExpiry(
      row as TokenRow,
      { partnerToken: 'p1', faculty_verification_token: 'f1' },
      NOW,
    );
    expect(row.partnerTokenExpiresAt!.getTime()).toBeGreaterThan(NOW);
    expect(row.facultyTokenExpiresAt!.getTime()).toBeGreaterThan(NOW);
  });

  it('keeps the expiry of a token that did not change', () => {
    const row: PartialRow = { partnerToken: 'p1', partnerTokenExpiresAt: past };
    stampVerificationTokenExpiry(row as TokenRow, { partnerToken: 'p1' }, NOW);
    expect(row.partnerTokenExpiresAt).toBe(past);
  });

  it('drops the expiry when the token is revoked', () => {
    const row: PartialRow = {
      partnerToken: null as unknown as string,
      partnerTokenExpiresAt: past,
      faculty_verification_token: '',
      facultyTokenExpiresAt: past,
    };
    stampVerificationTokenExpiry(
      row as TokenRow,
      { partnerToken: 'p1', faculty_verification_token: 'f1' },
      NOW,
    );
    expect(row.partnerTokenExpiresAt).toBeNull();
    expect(row.facultyTokenExpiresAt).toBeNull();
  });

  it('a PARTIAL update that does not touch the tokens leaves every expiry alone (it used to null them)', () => {
    const row: PartialRow & { admin_hidden?: boolean } = { admin_hidden: true };
    stampVerificationTokenExpiry(
      row as TokenRow,
      { partnerToken: 'p1', faculty_verification_token: 'f1' },
      NOW,
    );
    expect('partnerTokenExpiresAt' in row).toBe(false);
    expect('facultyTokenExpiresAt' in row).toBe(false);
  });
});
