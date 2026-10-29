/**
 * Community-service reporting for HEC, government and university partners: completed projects
 * (CIEL PK-verified community-service reports and approved Quick Community Impact logs) and the
 * students credited on them. The service gathers drafts from the database; everything here is pure
 * so the totals can be tested and are computed the same way for the Excel file and the PDF.
 */
import { HEC_HOUR_TIERS, hecHourTier } from '../common/hec-hour-tier';

export const CS_REPORT_SOURCE_FILTERS = ['all', 'structured', 'quick'] as const;
export type CsReportSourceFilter = (typeof CS_REPORT_SOURCE_FILTERS)[number];

export const CS_PROJECT_TYPE = {
  structured: 'Community service project',
  quick: 'Quick Community Impact',
} as const;

export const CS_HOURS_SOURCE = {
  attendance: 'Approved attendance',
  report: 'CIEL PK-verified report',
  quick: 'Approved Quick Impact log',
} as const;

export type CsReportFilters = {
  /** Inclusive YYYY-MM-DD (Pakistan time) on the date CIEL PK verified the project. */
  from: string | null;
  to: string | null;
  /** Case-insensitive part of the student's university name. */
  university: string | null;
  source: CsReportSourceFilter;
};

/** One student credited with verified hours on one project. */
export type CsStudentCredit = {
  userId: string;
  name: string;
  university: string;
  programme: string;
  batch: string;
  rollNo: string;
  hours: number;
  hoursSource: (typeof CS_HOURS_SOURCE)[keyof typeof CS_HOURS_SOURCE];
  certificateId: string;
  verifyUrl: string;
};

/** A completed project as gathered, before filters and totals. */
export type CsProjectDraft = {
  ref: string;
  source: 'structured' | 'quick';
  title: string;
  host: string;
  partners: string[];
  city: string;
  province: string;
  sdgs: number[];
  startDate: string;
  endDate: string;
  verifiedOn: string;
  beneficiaries: number;
  faculty: string[];
  credits: CsStudentCredit[];
};

export type CsProjectRow = {
  ref: string;
  type: string;
  title: string;
  host: string;
  partners: string;
  city: string;
  province: string;
  sdgs: string;
  startDate: string;
  endDate: string;
  verifiedOn: string;
  students: number;
  personHours: number;
  beneficiaries: number;
  universities: string;
  faculty: string;
};

export type CsStudentRow = Omit<CsStudentCredit, 'userId'> & {
  projectRef: string;
  projectTitle: string;
  projectType: string;
  verifiedOn: string;
  /** This student's verified hours across every project in the report. */
  totalHours: number;
  tier: string;
};

export type CsReportSummary = {
  projects: number;
  structuredProjects: number;
  quickProjects: number;
  students: number;
  universities: number;
  personHours: number;
  beneficiaries: number;
  byUniversity: {
    university: string;
    students: number;
    projects: number;
    hours: number;
  }[];
  byProvince: { province: string; projects: number; hours: number }[];
  bySdg: { sdg: number; projects: number; hours: number }[];
  byTier: { code: string; label: string; students: number }[];
};

export type CsReport = {
  summary: CsReportSummary;
  projects: CsProjectRow[];
  students: CsStudentRow[];
};

const UNSPECIFIED = 'Unspecified';

export const round1 = (n: number): number =>
  Math.round((Number.isFinite(n) ? n : 0) * 10) / 10;

/** Calendar date in Pakistan (UTC+5, no DST) of an instant. */
export function pktDate(at: Date | string | null | undefined): string {
  if (!at) return '';
  const t = (at instanceof Date ? at : new Date(at)).getTime();
  if (!Number.isFinite(t)) return '';
  return new Date(t + 5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function inPeriod(date: string, filters: CsReportFilters): boolean {
  if (filters.from && (!date || date < filters.from)) return false;
  if (filters.to && (!date || date > filters.to)) return false;
  return true;
}

const keyOf = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

function universityMatches(
  university: string,
  filters: CsReportFilters,
): boolean {
  const want = keyOf(filters.university ?? '');
  return !want || keyOf(university).includes(want);
}

/** Groups by a case-insensitive key; the first spelling seen is the one shown. */
function tally<T>(
  map: Map<string, { label: string } & T>,
  label: string,
  init: () => T,
): { label: string } & T {
  const key = keyOf(label) || keyOf(UNSPECIFIED);
  let row = map.get(key);
  if (!row) {
    row = { label: label.trim() || UNSPECIFIED, ...init() };
    map.set(key, row);
  }
  return row;
}

/**
 * Applies the filters and builds the three report tables. A project with no student credited
 * within the filters (no verified hours, or none from the chosen university) is left out, and a
 * project's students, hours and universities count only the credited students that remain.
 */
export function buildCsReport(
  drafts: CsProjectDraft[],
  filters: CsReportFilters,
): CsReport {
  const kept = drafts
    .filter(
      (d) =>
        (filters.source === 'all' || d.source === filters.source) &&
        inPeriod(d.verifiedOn, filters),
    )
    .map((d) => ({
      ...d,
      credits: d.credits.filter(
        (c) => c.hours > 0 && universityMatches(c.university, filters),
      ),
    }))
    .filter((d) => d.credits.length > 0)
    .sort(
      (a, b) =>
        a.verifiedOn.localeCompare(b.verifiedOn) || a.ref.localeCompare(b.ref),
    );

  const totalByStudent = new Map<string, number>();
  const universityByStudent = new Map<string, string>();
  for (const d of kept) {
    for (const c of d.credits) {
      totalByStudent.set(
        c.userId,
        (totalByStudent.get(c.userId) ?? 0) + c.hours,
      );
      if (!universityByStudent.has(c.userId)) {
        universityByStudent.set(c.userId, c.university);
      }
    }
  }

  const projects: CsProjectRow[] = [];
  const students: CsStudentRow[] = [];
  const byUniversity = new Map<
    string,
    {
      label: string;
      students: Set<string>;
      projects: Set<string>;
      hours: number;
    }
  >();
  const byProvince = new Map<
    string,
    { label: string; projects: number; hours: number }
  >();
  const bySdg = new Map<number, { projects: number; hours: number }>();
  let personHours = 0;
  let beneficiaries = 0;

  for (const d of kept) {
    const type = CS_PROJECT_TYPE[d.source];
    const hours = d.credits.reduce((a, c) => a + c.hours, 0);
    const studentIds = new Set(d.credits.map((c) => c.userId));
    const universities = new Map<string, string>();
    for (const c of d.credits) {
      const u = c.university.trim() || UNSPECIFIED;
      if (!universities.has(keyOf(u))) universities.set(keyOf(u), u);
    }

    projects.push({
      ref: d.ref,
      type,
      title: d.title,
      host: d.host,
      partners: d.partners.join(', '),
      city: d.city,
      province: d.province,
      sdgs: d.sdgs.join(', '),
      startDate: d.startDate,
      endDate: d.endDate,
      verifiedOn: d.verifiedOn,
      students: studentIds.size,
      personHours: round1(hours),
      beneficiaries: d.beneficiaries,
      universities: [...universities.values()].sort().join('; '),
      faculty: d.faculty.join(', '),
    });
    personHours += hours;
    beneficiaries += d.beneficiaries;

    for (const c of d.credits) {
      const u = tally(byUniversity, c.university, () => ({
        students: new Set<string>(),
        projects: new Set<string>(),
        hours: 0,
      }));
      u.students.add(c.userId);
      u.projects.add(d.ref);
      u.hours += c.hours;

      const total = totalByStudent.get(c.userId) ?? 0;
      students.push({
        name: c.name,
        university: c.university,
        programme: c.programme,
        batch: c.batch,
        rollNo: c.rollNo,
        hours: round1(c.hours),
        hoursSource: c.hoursSource,
        certificateId: c.certificateId,
        verifyUrl: c.verifyUrl,
        projectRef: d.ref,
        projectTitle: d.title,
        projectType: type,
        verifiedOn: d.verifiedOn,
        totalHours: round1(total),
        tier: tierLabel(total),
      });
    }

    const p = tally(byProvince, d.province, () => ({ projects: 0, hours: 0 }));
    p.projects += 1;
    p.hours += hours;

    for (const sdg of new Set(d.sdgs)) {
      const s = bySdg.get(sdg) ?? { projects: 0, hours: 0 };
      s.projects += 1;
      s.hours += hours;
      bySdg.set(sdg, s);
    }
  }

  const tierCounts = new Map<string, number>();
  for (const total of totalByStudent.values()) {
    const code = hecHourTier(total);
    tierCounts.set(code, (tierCounts.get(code) ?? 0) + 1);
  }

  students.sort(
    (a, b) =>
      a.university.localeCompare(b.university) ||
      a.name.localeCompare(b.name) ||
      a.verifiedOn.localeCompare(b.verifiedOn),
  );

  return {
    summary: {
      projects: projects.length,
      structuredProjects: kept.filter((d) => d.source === 'structured').length,
      quickProjects: kept.filter((d) => d.source === 'quick').length,
      students: totalByStudent.size,
      universities: new Set(
        [...universityByStudent.values()].map(
          (u) => keyOf(u) || keyOf(UNSPECIFIED),
        ),
      ).size,
      personHours: round1(personHours),
      beneficiaries,
      byUniversity: [...byUniversity.values()]
        .map((u) => ({
          university: u.label,
          students: u.students.size,
          projects: u.projects.size,
          hours: round1(u.hours),
        }))
        .sort(
          (a, b) =>
            b.hours - a.hours || a.university.localeCompare(b.university),
        ),
      byProvince: [...byProvince.values()]
        .map((p) => ({
          province: p.label,
          projects: p.projects,
          hours: round1(p.hours),
        }))
        .sort(
          (a, b) => b.hours - a.hours || a.province.localeCompare(b.province),
        ),
      bySdg: [...bySdg.entries()]
        .map(([sdg, s]) => ({
          sdg,
          projects: s.projects,
          hours: round1(s.hours),
        }))
        .sort((a, b) => a.sdg - b.sdg),
      byTier: HEC_HOUR_TIERS.map((t) => ({
        code: t.code,
        label: t.label,
        students: tierCounts.get(t.code) ?? 0,
      })),
    },
    projects,
    students,
  };
}

function tierLabel(hours: number): string {
  const code = hecHourTier(hours);
  return HEC_HOUR_TIERS.find((t) => t.code === code)?.label ?? '';
}

/** Human-readable reporting period for file headers. */
export function periodLabel(
  filters: Pick<CsReportFilters, 'from' | 'to'>,
): string {
  if (filters.from && filters.to) return `${filters.from} to ${filters.to}`;
  if (filters.from) return `From ${filters.from}`;
  if (filters.to) return `Up to ${filters.to}`;
  return 'All time';
}
