import { normalizePersonName, ventureMatchesFaculty } from './venture-faculty-scope.util';

describe('ventureMatchesFaculty', () => {
  const faculty = { email: 'sara@bnu.edu.pk', name: 'Dr. Sara Ahmed' };

  it('matches on supervisor email when present', () => {
    expect(
      ventureMatchesFaculty(
        { supervisorEmail: 'sara@bnu.edu.pk', supervisorName: 'Someone Else' },
        faculty,
      ),
    ).toBe(true);
  });

  it('does not match a different supervisor email', () => {
    expect(
      ventureMatchesFaculty(
        { supervisorEmail: 'other@bnu.edu.pk', supervisorName: 'Dr. Sara Ahmed' },
        faculty,
      ),
    ).toBe(false);
  });

  it('falls back to stripped name when email is blank', () => {
    expect(normalizePersonName('Dr. Sara Ahmed')).toBe('sara ahmed');
    expect(
      ventureMatchesFaculty({ supervisorName: 'Prof. Sara Ahmed' }, faculty),
    ).toBe(true);
  });

  it('does not match an empty name or email', () => {
    expect(ventureMatchesFaculty({ supervisorName: 'Sara Ahmed' }, { email: '' })).toBe(false);
    expect(ventureMatchesFaculty({}, faculty)).toBe(false);
  });
});
