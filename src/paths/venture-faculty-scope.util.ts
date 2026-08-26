/** Faculty deck matching for Startup / Business — email first, then stripped name. */

export function normalizePersonName(value?: string | null): string {
  return (value || '')
    .toLowerCase()
    .replace(/\b(dr|prof|professor|mr|ms|mrs)\.?\b/g, '')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function ventureMatchesFaculty(
  setup: { supervisorEmail?: string; supervisorName?: string } | null | undefined,
  faculty: { email: string; name?: string | null },
): boolean {
  const email = (faculty.email || '').trim().toLowerCase();
  if (!email) return false;
  const listedEmail = (setup?.supervisorEmail || '').trim().toLowerCase();
  if (listedEmail) return listedEmail === email;
  const listedName = normalizePersonName(setup?.supervisorName);
  const facultyName = normalizePersonName(faculty.name);
  return !!listedName && !!facultyName && listedName === facultyName;
}
