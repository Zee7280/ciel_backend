import { BadRequestException } from '@nestjs/common';
import { validateSettingValue } from './settings-registry';

describe('settings registry', () => {
  const ok = (k: string, v: unknown) => validateSettingValue(k, v).value;
  const bad = (k: string, v: unknown) =>
    expect(() => validateSettingValue(k, v)).toThrow(BadRequestException);

  it('rejects unknown keys', () => bad('DATABASE_URL', 'x'));

  it('validates booleans', () => {
    expect(ok('maintenance_mode', 'TRUE')).toBe('true');
    expect(ok('allow_registrations', 'off')).toBe('false');
    bad('maintenance_mode', 'maybe');
  });

  it('validates integers and ranges', () => {
    expect(ok('REPORTING_FEE_PKR', '1500')).toBe('1500');
    bad('REPORTING_FEE_PKR', '0');
    bad('REPORTING_FEE_PKR', '1000001');
    bad('REPORTING_FEE_PKR', '12.5');
    bad('REVIEW_SLA_DAYS', '61');
    expect(ok('REVIEW_SLA_DAYS', '14')).toBe('14');
  });

  it('validates text length, email and email lists', () => {
    bad('site_name', 'x'.repeat(81));
    bad('STUDENT_APPLY_MAINTENANCE_MESSAGE', 'x'.repeat(501));
    expect(ok('contact_email', ' Hello@Ciel.PK ')).toBe('hello@ciel.pk');
    bad('contact_email', 'not-an-email');
    expect(ok('ADMIN_REVIEW_EMAILS', 'a@x.co, B@x.co,a@x.co')).toBe('a@x.co,b@x.co');
    bad('ADMIN_REVIEW_EMAILS', 'a@x.co,nope');
    bad(
      'ADMIN_REVIEW_EMAILS',
      Array.from({ length: 11 }, (_, i) => `u${i}@x.co`).join(','),
    );
  });

  it('accepts a past date or the disabled sentinel for STUDENT_APPLY_CLOSED_BEFORE, not a future one', () => {
    const now = new Date('2026-06-01T00:00:00Z');
    expect(
      validateSettingValue('STUDENT_APPLY_CLOSED_BEFORE', '2026-05-01', now).value,
    ).toBe('2026-05-01T00:00:00.000Z');
    expect(ok('STUDENT_APPLY_CLOSED_BEFORE', 'disabled')).toBe('disabled');
    expect(() =>
      validateSettingValue('STUDENT_APPLY_CLOSED_BEFORE', '2026-07-01', now),
    ).toThrow(BadRequestException);
    bad('STUDENT_APPLY_CLOSED_BEFORE', 'garbage');
  });
});
