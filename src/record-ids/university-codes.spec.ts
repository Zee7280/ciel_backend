import { PAKISTANI_UNIVERSITIES } from '../auth/constants/pakistani-universities';
import { UNIVERSITY_CODES } from './university-codes';

describe('UNIVERSITY_CODES', () => {
  it('has a code for every listed university and no stray entries', () => {
    const missing = PAKISTANI_UNIVERSITIES.filter((n) => !UNIVERSITY_CODES[n]);
    expect(missing).toEqual([]);
    const stray = Object.keys(UNIVERSITY_CODES).filter(
      (n) => !PAKISTANI_UNIVERSITIES.includes(n),
    );
    expect(stray).toEqual([]);
  });

  it('uses unique, upper-case alphanumeric codes of 2-10 characters', () => {
    const codes = Object.values(UNIVERSITY_CODES);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of codes) expect(c).toMatch(/^[A-Z0-9]{2,10}$/);
  });

  it('keeps the codes the product already promised', () => {
    expect(UNIVERSITY_CODES['Beaconhouse National University (BNU)']).toBe(
      'BNU',
    );
    expect(
      UNIVERSITY_CODES['Lahore University of Management Sciences (LUMS)'],
    ).toBe('LUMS');
  });
});
