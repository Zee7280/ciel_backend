import {
  academicYearOf,
  aliasesFor,
  deriveUniversityCode,
  formatPublicId,
  isPublicId,
  parsePublicId,
} from './record-id.util';

describe('academicYearOf', () => {
  it('starts the academic year in August', () => {
    expect(academicYearOf(new Date('2026-07-31T12:00:00Z'))).toBe(2025);
    expect(academicYearOf(new Date('2026-08-01T00:00:00Z'))).toBe(2026);
    expect(academicYearOf(new Date('2027-01-15T00:00:00Z'))).toBe(2026);
    expect(academicYearOf(new Date('2027-07-31T23:59:59Z'))).toBe(2026);
  });
});

describe('formatPublicId / parsePublicId', () => {
  it('formats the id the way the product shows it', () => {
    expect(formatPublicId('BNU', 2026, 421)).toBe('CIEL-BNU-2026-0421');
    expect(formatPublicId('LUMS', 2026, 1)).toBe('CIEL-LUMS-2026-0001');
  });

  it('keeps counting past four digits', () => {
    expect(formatPublicId('BNU', 2026, 12345)).toBe('CIEL-BNU-2026-12345');
    expect(parsePublicId('CIEL-BNU-2026-12345')?.seq).toBe(12345);
  });

  it('round-trips and tolerates case / spaces', () => {
    expect(parsePublicId(' ciel-bnu-2026-0421 ')).toEqual({
      code: 'BNU',
      academicYear: 2026,
      seq: 421,
    });
    expect(isPublicId('CIEL-BNU-2026-0421')).toBe(true);
  });

  it('rejects things that are not ids', () => {
    for (const v of [
      '',
      'CIEL-BNU-26-0421',
      'BNU-2026-0421',
      'CIEL-B-2026-0421',
      'CIEL-BNU-2026-42',
      null,
      42,
    ]) {
      expect(isPublicId(v)).toBe(false);
    }
  });
});

describe('deriveUniversityCode', () => {
  it('prefers the parenthesised abbreviation', () => {
    expect(deriveUniversityCode('Some Place (SPU)', new Set())).toBe('SPU');
  });

  it('falls back to initials and skips filler words', () => {
    expect(
      deriveUniversityCode('University of the Arts Lahore', new Set()),
    ).toBe('UAL');
  });

  it('makes the code unique against taken ones', () => {
    expect(deriveUniversityCode('Some Place (SPU)', new Set(['SPU']))).toBe(
      'SPU2',
    );
    expect(
      deriveUniversityCode('Some Place (SPU)', new Set(['SPU', 'SPU2'])),
    ).toBe('SPU3');
  });

  it('always yields a valid code', () => {
    expect(deriveUniversityCode('X', new Set())).toMatch(/^[A-Z0-9]{2,10}$/);
    expect(deriveUniversityCode('', new Set())).toMatch(/^[A-Z0-9]{2,10}$/);
  });
});

describe('aliasesFor', () => {
  it('offers the name without its trailing abbreviation', () => {
    expect(aliasesFor('Beaconhouse National University (BNU)')).toEqual([
      'Beaconhouse National University',
    ]);
    expect(aliasesFor('Aga Khan University')).toEqual([]);
  });
});
