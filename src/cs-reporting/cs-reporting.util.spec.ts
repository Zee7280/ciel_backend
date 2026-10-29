import ExcelJS from 'exceljs';
import {
  buildCsReport,
  CS_HOURS_SOURCE,
  type CsProjectDraft,
  type CsReportFilters,
  type CsStudentCredit,
  periodLabel,
  pktDate,
} from './cs-reporting.util';
import { csReportPdf, csReportXlsx } from './cs-reporting.export';
import type { CsReportSnapshot } from './entities/cs-report-snapshot.entity';

const ALL: CsReportFilters = {
  from: null,
  to: null,
  university: null,
  source: 'all',
};

function credit(over: Partial<CsStudentCredit>): CsStudentCredit {
  return {
    userId: 'u1',
    name: 'Ayesha',
    university: 'NED University',
    programme: 'BS CS',
    batch: '2023',
    rollNo: 'CS-23-01',
    hours: 10,
    hoursSource: CS_HOURS_SOURCE.attendance,
    certificateId: '',
    verifyUrl: '',
    ...over,
  };
}

function draft(over: Partial<CsProjectDraft>): CsProjectDraft {
  return {
    ref: 'CS-AAAA0001',
    source: 'structured',
    title: 'Literacy drive',
    host: 'Hope NGO',
    partners: [],
    city: 'Karachi',
    province: 'Sindh',
    sdgs: [4],
    startDate: '2026-03-01',
    endDate: '2026-03-20',
    verifiedOn: '2026-04-02',
    beneficiaries: 120,
    faculty: ['Dr. Khan'],
    credits: [credit({})],
    ...over,
  };
}

describe('buildCsReport', () => {
  it('counts a student once across projects and tiers them on their total', () => {
    const report = buildCsReport(
      [
        draft({ credits: [credit({ hours: 10 })] }),
        draft({
          ref: 'QCI-BBBB0002',
          source: 'quick',
          sdgs: [4, 11],
          beneficiaries: 30,
          credits: [
            credit({ hours: 7, hoursSource: CS_HOURS_SOURCE.quick }),
            credit({ userId: 'u2', name: 'Bilal', hours: 3 }),
          ],
        }),
      ],
      ALL,
    );
    expect(report.summary).toMatchObject({
      projects: 2,
      structuredProjects: 1,
      quickProjects: 1,
      students: 2,
      universities: 1,
      personHours: 20,
      beneficiaries: 150,
    });
    expect(
      report.summary.byTier.find((t) => t.code === 'recognized')?.students,
    ).toBe(1);
    expect(
      report.summary.byTier.find((t) => t.code === 'below')?.students,
    ).toBe(1);
    expect(report.summary.bySdg).toEqual([
      { sdg: 4, projects: 2, hours: 20 },
      { sdg: 11, projects: 1, hours: 10 },
    ]);
    const ayesha = report.students.filter((s) => s.name === 'Ayesha');
    expect(ayesha.map((s) => s.totalHours)).toEqual([17, 17]);
  });

  it('filters by verification date, type and university', () => {
    const drafts = [
      draft({ verifiedOn: '2026-01-15' }),
      draft({
        ref: 'CS-CCCC0003',
        verifiedOn: '2026-05-10',
        credits: [
          credit({ userId: 'u3', university: 'LUMS', hours: 5 }),
          credit({ userId: 'u4', university: 'ned university ', hours: 6 }),
        ],
      }),
      draft({ ref: 'QCI-DDDD0004', source: 'quick', verifiedOn: '2026-05-11' }),
    ];
    const report = buildCsReport(drafts, {
      from: '2026-02-01',
      to: '2026-06-30',
      university: 'NED',
      source: 'structured',
    });
    expect(report.projects.map((p) => p.ref)).toEqual(['CS-CCCC0003']);
    expect(report.projects[0]).toMatchObject({
      students: 1,
      personHours: 6,
      universities: 'ned university',
    });
  });

  it('leaves out a project with no credited hours', () => {
    const report = buildCsReport(
      [draft({ credits: [credit({ hours: 0 })] })],
      ALL,
    );
    expect(report.projects).toHaveLength(0);
    expect(report.summary.students).toBe(0);
  });
});

describe('dates', () => {
  it('uses the Pakistan calendar date', () => {
    expect(pktDate(new Date('2026-04-01T20:30:00Z'))).toBe('2026-04-02');
    expect(pktDate(null)).toBe('');
  });

  it('labels the period', () => {
    expect(periodLabel({ from: '2026-01-01', to: '2026-06-30' })).toBe(
      '2026-01-01 to 2026-06-30',
    );
    expect(periodLabel({ from: null, to: null })).toBe('All time');
  });
});

describe('export files', () => {
  const report = buildCsReport(
    [draft({}), draft({ ref: 'QCI-EEEE0005', source: 'quick', province: '' })],
    ALL,
  );
  const snapshot = (includeStudents: boolean) =>
    ({
      id: '00000000-0000-0000-0000-000000000001',
      code: 'CSR-20261029-ABC123',
      preparedFor: 'Higher Education Commission',
      filters: ALL,
      includeStudents,
      summary: report.summary,
      projects: report.projects,
      students: includeStudents ? report.students : null,
      generatedById: null,
      generatedByName: 'Admin',
      createdAt: new Date('2026-10-29T10:00:00Z'),
    }) as CsReportSnapshot;

  it('writes the Students sheet only when names are included', async () => {
    for (const include of [true, false]) {
      const wb = new ExcelJS.Workbook();
      const file = await csReportXlsx(snapshot(include));
      await wb.xlsx.load(file as unknown as ExcelJS.Buffer);
      expect(wb.worksheets.map((w) => w.name)).toEqual(
        include ? ['Summary', 'Projects', 'Students'] : ['Summary', 'Projects'],
      );
      expect(wb.getWorksheet('Projects')?.rowCount).toBe(3);
    }
  });

  it('writes a PDF', async () => {
    const pdf = await csReportPdf(snapshot(false));
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
