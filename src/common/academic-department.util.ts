/**
 * Report Academic department sanitizer — keep in lockstep with
 * ciel_frontend/src/utils/universityData.ts
 * (`sanitizeReportAcademicDepartment` and BNU school/program lists).
 */

export const BNU_DEGREE_PROGRAMS: { school: string; programs: string[] }[] = [
  {
    school: 'Mariam Dawood School of Visual Arts & Design',
    programs: [
      'BFA Visual Arts',
      'BDes Visual Communication Design',
      'BDes Textile, Fashion & Accessories Design',
      'BA (Hons) Interdisciplinary Expanded Design & Art',
      'MA Art & Design Studies',
    ],
  },
  {
    school: 'Razia Hassan School of Architecture',
    programs: ['Bachelor of Architecture (B.Arch)', 'Bachelor in Interior Design'],
  },
  {
    school: 'Seeta Majeed School of Liberal Arts & Social Sciences',
    programs: [
      'BS Liberal Arts & Social Sciences',
      'BS Political Science',
      'BS Political Science with International Relations',
    ],
  },
  {
    school: 'School of Media & Mass Communication',
    programs: [
      'BS Journalism & Media Studies',
      'BS Immersive Media',
      'BS Theatre, Film & TV',
      'MS Public Relations & Advertising',
      'MS Film Direction',
    ],
  },
  {
    school: 'School of Computer & Information Technology',
    programs: [
      'BS Computer Science',
      'BS Software Engineering',
      'BS Artificial Intelligence',
      'BS Management & Business Computing',
      'MS Computer Science',
    ],
  },
  {
    school: 'School of Education',
    programs: [
      'Bachelor of Education (B.Ed)',
      'MPhil Linguistics & TESOL',
      'MPhil Educational Leadership and Management',
    ],
  },
  {
    school: 'School of Management Sciences',
    programs: [
      'BBA (Hons)',
      'BS Business Intelligence & Analytics',
      'BS Economics',
      'BS Economics & Finance',
      'BS Economics with Data Analytics',
      'BS Hospitality Management',
    ],
  },
  {
    school: 'Institute of Psychology',
    programs: ['BS Applied Psychology', 'MS Clinical & Counseling Psychology'],
  },
];

export const BNU_FACULTY_DEPARTMENTS: string[] = [
  ...BNU_DEGREE_PROGRAMS.map((s) => s.school),
  'School of Management Sciences (SMS)',
  'SMS',
];

function foldAcademicLabel(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Drop "School of …" / named-school / institute wrappers so Department is department-only. */
export function stripSchoolWrapperFromAcademicUnit(value: string): string {
  let s = value.trim();
  if (!s) return '';
  if (foldAcademicLabel(s) === 'sms') return 'Management Sciences';
  s = s.replace(/\s*\(\s*sms\s*\)\s*$/i, '').trim();
  s = s.replace(/^.+?\s+School of\s+/i, '');
  s = s.replace(/^School of\s+/i, '');
  s = s.replace(/^Institute of\s+/i, '');
  return s.trim();
}

export function isSchoolOrInstituteAcademicLabel(value: string): boolean {
  const t = value.trim();
  if (!t) return false;
  const folded = foldAcademicLabel(t);
  if (folded === 'sms') return true;
  if (BNU_DEGREE_PROGRAMS.some((group) => foldAcademicLabel(group.school) === folded)) {
    return true;
  }
  if (BNU_FACULTY_DEPARTMENTS.some((label) => foldAcademicLabel(label) === folded)) {
    return true;
  }
  return /\bschool of\b/i.test(t) || /^institute of\b/i.test(t);
}

/** "BS Computer Science" → "Computer Science"; empty leftovers fall back to the school unit without "School of". */
export function departmentFromDegreeProgram(program: string): string {
  const raw = program.trim();
  if (!raw) return '';
  let s = raw
    .replace(/^(associate degree in)\s+/i, '')
    .replace(/^(bachelor of|bachelor in|master of)\s+/i, '')
    .replace(/^(mphil|phd)\s+/i, '')
    .replace(/^(bdes|bfa|bba|bs|ms|ma|ba|be)\s+/i, '')
    .replace(/^\((hons)\)\s*/i, '')
    .replace(/\s*\((b\.arch|b\.ed|hons)\)\s*$/i, '')
    .trim();
  if (s && foldAcademicLabel(s) !== foldAcademicLabel(raw)) return s;
  const group = BNU_DEGREE_PROGRAMS.find((g) => g.programs.includes(raw));
  if (group) return stripSchoolWrapperFromAcademicUnit(group.school);
  return s;
}

/**
 * Report Academic "Department" must not include the school name.
 * Prefer a department derived from the degree program when the stored value is a school.
 */
export function sanitizeReportAcademicDepartment(
  department: string | null | undefined,
  academicProgram?: string | null,
): string {
  const fromProgram = departmentFromDegreeProgram(String(academicProgram || ''));
  const dept = String(department || '').trim();
  if (!dept) return fromProgram;

  let rest = dept;
  for (const group of BNU_DEGREE_PROGRAMS) {
    if (foldAcademicLabel(rest).startsWith(foldAcademicLabel(group.school))) {
      rest = rest
        .slice(group.school.length)
        .replace(/^[\s,;:–—\-/|]+/, '')
        .trim();
      if (!rest) return fromProgram || stripSchoolWrapperFromAcademicUnit(group.school);
      break;
    }
  }

  if (isSchoolOrInstituteAcademicLabel(rest)) {
    return fromProgram || stripSchoolWrapperFromAcademicUnit(rest);
  }

  const parts = rest
    .split(/\s*[,;:–—\-/|]\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length > 1 && isSchoolOrInstituteAcademicLabel(parts[0])) {
    const afterSchool = parts.slice(1).join(' ').trim();
    if (afterSchool && !isSchoolOrInstituteAcademicLabel(afterSchool)) {
      return foldAcademicLabel(afterSchool) ===
        foldAcademicLabel(String(academicProgram || ''))
        ? fromProgram || afterSchool
        : afterSchool;
    }
  }

  if (
    fromProgram &&
    foldAcademicLabel(rest) === foldAcademicLabel(String(academicProgram || ''))
  ) {
    return fromProgram;
  }
  return rest;
}
