import { clockToMinutes, sessionsOverlap } from './attendance-time.util';

describe('attendance time helpers', () => {
  it('parses clock times', () => {
    expect(clockToMinutes('09:30')).toBe(570);
    expect(clockToMinutes('9:05')).toBe(545);
    expect(clockToMinutes('24:00')).toBeNull();
    expect(clockToMinutes('nope')).toBeNull();
    expect(clockToMinutes(undefined)).toBeNull();
  });
  it('detects overlapping sessions', () => {
    expect(sessionsOverlap('09:00', '12:00', '10:00', '13:00')).toBe(true);
    expect(sessionsOverlap('09:00', '12:00', '09:00', '12:00')).toBe(true); // exact duplicate
    expect(sessionsOverlap('09:00', '12:00', '10:00', '11:00')).toBe(true); // contained
  });
  it('allows back-to-back and separate sessions', () => {
    expect(sessionsOverlap('09:00', '12:00', '12:00', '14:00')).toBe(false);
    expect(sessionsOverlap('09:00', '11:00', '13:00', '15:00')).toBe(false);
  });
  it('is permissive on unparseable times (the format check lives elsewhere)', () => {
    expect(sessionsOverlap('x', 'y', '09:00', '10:00')).toBe(false);
  });
});
