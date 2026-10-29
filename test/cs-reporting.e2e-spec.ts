/**
 * Community-service reporting, end to end (real Nest app + scratch Postgres): a CIEL PK-verified
 * community-service project and an approved Quick Community Impact log become one frozen report
 * with Excel and PDF downloads.
 */
import ExcelJS from 'exceljs';
import { bootHarness, E2eUser, Harness, oppPayload, uniq } from './e2e/harness';
import { UserRole } from '../src/users/enums/user-role.enum';
import { Participation } from '../src/engagement/entities/participant.entity';
import { AttendanceLog } from '../src/engagement/entities/attendance-log.entity';
import { StudentReport } from '../src/reports/entities/student-report.entity';
import { QuickWorkLog } from '../src/quick-work/entities/quick-work-log.entity';
import { QuickWorkParticipant } from '../src/quick-work/entities/quick-work-participant.entity';
import { AuditLog } from '../src/audit-logs/entities/audit-log.entity';

type ReportItem = {
  id: string;
  code: string;
  includeStudents: boolean;
  summary: {
    projects: number;
    structuredProjects: number;
    quickProjects: number;
    students: number;
    personHours: number;
    beneficiaries: number;
  };
};

/** Collects a binary supertest response into a Buffer. */
const binary = (
  res: NodeJS.ReadableStream,
  cb: (err: Error | null, body: Buffer) => void,
) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('Community service reporting (real app + real Postgres)', () => {
  let h: Harness;
  let admin: E2eUser;
  /** Unique per run, so the university filter isolates this test's records. */
  const uni = `CSR University ${uniq()}`;

  beforeAll(async () => {
    h = await bootHarness();
    admin = await h.makeUser(UserRole.SUPER_ADMIN);

    const student = (name: string) =>
      h.makeUser(UserRole.STUDENT, {
        overrides: {
          name,
          university: uni,
          registrationNumber: `REG-${name}`,
          enrollmentYear: '2023',
        },
      });
    const reporter = await student('Ayesha');
    const teammate = await student('Bilal');
    const quickLead = await student('Sana');

    // A community-service project: two students on the roster with approved attendance; the
    // reporter's report is verified by CIEL PK.
    const org = await h.makeOrg();
    const ngo = await h.makeUser(UserRole.NGO, { org });
    const opp = await h.as(ngo).post('/opportunities').send(oppPayload());
    expect(opp.status).toBe(201);
    const projectId = (opp.body as { id: string }).id;
    const seats = h.ds.getRepository(Participation);
    const logs = h.ds.getRepository(AttendanceLog);
    for (const [u, hours] of [
      [reporter, 6],
      [teammate, 4.5],
    ] as const) {
      const seat = await seats.save(
        seats.create({
          projectId,
          studentId: u.id,
          fullName: u.email,
          status: 'approved',
          email: u.email,
          mobile: '+923005550000',
          cnic: 'enc',
          cnicHash: `hash-${u.email}`,
          cnicLast4: '0000',
          universityId: 'e2e',
          universityName: uni,
          academicProgram: 'BS CS',
          yearOfStudy: '3rd Year',
          department: 'Computer Science',
          academicIntegrationType: 'Voluntary',
          emailVerified: true,
          mobileVerified: true,
          attendanceApproverType: 'partner',
        }),
      );
      await logs.save(
        logs.create({
          participantId: seat.id,
          projectId,
          dateOfEngagement: '2026-03-10',
          startTime: '09:00',
          endTime: '15:00',
          sessionHours: hours,
          organizationName: 'E2E',
          activityType: 'Fieldwork',
          description: 'Session',
          approvalStatus: 'approved',
        }),
      );
    }
    // A pending session never counts.
    await logs.save(
      logs.create({
        participantId: (
          await seats.findOneByOrFail({
            projectId,
            studentId: teammate.id,
          })
        ).id,
        projectId,
        dateOfEngagement: '2026-03-11',
        startTime: '09:00',
        endTime: '19:00',
        sessionHours: 10,
        organizationName: 'E2E',
        activityType: 'Fieldwork',
        description: 'Unreviewed session',
      }),
    );
    const reports = h.ds.getRepository(StudentReport);
    await reports.save(
      reports.create({
        studentId: reporter.id,
        opportunityId: projectId,
        project_id: projectId,
        status: 'verified',
        admin_status: 'approved',
        adminApprovedAt: new Date('2026-04-02T06:00:00Z'),
        section4: { distinct_total_beneficiaries: 80 },
      } as Partial<StudentReport>),
    );

    // An approved Quick Community Impact log with one credited student (90 minutes).
    const quick = h.ds.getRepository(QuickWorkLog);
    const log = await quick.save(
      quick.create({
        leadUserId: quickLead.id,
        status: 'approved',
        university: uni,
        title: 'Tree planting',
        activityType: 'Environment',
        activityDate: '2026-04-05',
        location: 'Jinnah Park, Lahore',
        sdg: 13,
        peopleReached: 25,
        facultyName: 'Dr Reviewer',
        reviewedAt: new Date('2026-04-06T06:00:00Z'),
      }),
    );
    const qp = h.ds.getRepository(QuickWorkParticipant);
    await qp.save(
      qp.create({
        logId: log.id,
        userId: quickLead.id,
        isLead: true,
        name: 'Sana',
        email: quickLead.email,
        studentId: 'SID-1',
        joinStatus: 'confirmed',
        present: true,
        startTime: '10:00',
        endTime: '11:30',
        breakMinutes: 0,
        minutes: 90,
        certificateCode: 'CIEL-QCI-2026-7K3M-Q9TD',
      }),
    );
  });

  afterAll(async () => {
    await h.app.close();
  });

  const create = (body: Record<string, unknown>) =>
    h.as(admin).post('/admin/cs-reports').send(body);

  const download = (id: string, format: 'xlsx' | 'pdf') =>
    h
      .as(admin)
      .get(`/admin/cs-reports/${id}/${format}`)
      .buffer(true)
      .parse(binary);

  it('is for CIEL PK admins only', async () => {
    const student = await h.makeUser(UserRole.STUDENT);
    expect((await h.as(student).get('/admin/cs-reports')).status).toBe(403);
    expect((await h.as(null).post('/admin/cs-reports').send({})).status).toBe(
      401,
    );
  });

  it('builds a named report from verified projects and approved quick logs', async () => {
    const res = await create({
      university: uni,
      from: '2026-04-01',
      to: '2026-04-30',
      includeStudents: true,
      preparedFor: 'Higher Education Commission',
    });
    expect(res.status).toBe(201);
    const item = res.body as ReportItem;
    expect(item.code).toMatch(/^CSR-\d{8}-[0-9A-Z]{6}$/);
    expect(item.summary).toMatchObject({
      projects: 2,
      structuredProjects: 1,
      quickProjects: 1,
      students: 3,
      personHours: 12,
      beneficiaries: 105,
    });

    const xlsx = await download(item.id, 'xlsx');
    expect(xlsx.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.body as unknown as ExcelJS.Buffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      'Summary',
      'Projects',
      'Students',
    ]);
    const students = wb.getWorksheet('Students')!;
    const byName = new Map<string, ExcelJS.Row>();
    students.eachRow((row, n) => {
      if (n > 1) byName.set(row.getCell(1).text, row);
    });
    expect([...byName.keys()].sort()).toEqual(['Ayesha', 'Bilal', 'Sana']);
    // Bilal's pending 10-hour session is not counted.
    expect(byName.get('Bilal')!.getCell(10).value).toBe(4.5);
    expect(byName.get('Bilal')!.getCell(5).value).toBe('REG-Bilal');
    expect(byName.get('Sana')!.getCell(10).value).toBe(1.5);
    expect(byName.get('Sana')!.getCell(14).value).toBe(
      'CIEL-QCI-2026-7K3M-Q9TD',
    );

    const pdf = await download(item.id, 'pdf');
    expect(pdf.status).toBe(200);
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');

    const audit = await h.ds
      .getRepository(AuditLog)
      .findBy({ target: item.code });
    expect(audit.map((a) => a.action).sort()).toEqual([
      'GET /admin/cs-reports/:id/pdf',
      'GET /admin/cs-reports/:id/xlsx',
    ]);
  });

  it('keeps names out of a totals-only report and filters by type and date', async () => {
    const res = await create({ university: uni, source: 'structured' });
    expect(res.status).toBe(201);
    const item = res.body as ReportItem;
    expect(item.summary).toMatchObject({ projects: 1, students: 2 });

    const xlsx = await download(item.id, 'xlsx');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.body as unknown as ExcelJS.Buffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Summary', 'Projects']);

    const listed = (await h.as(admin).get('/admin/cs-reports'))
      .body as ReportItem[];
    expect(listed[0].id).toBe(item.id);
    expect(listed[0]).not.toHaveProperty('students');

    const none = await create({ university: uni, to: '2026-01-01' });
    expect(none.status).toBe(400);
    const bad = await create({ from: '2026-05-01', to: '2026-04-01' });
    expect(bad.status).toBe(400);
  });
});
