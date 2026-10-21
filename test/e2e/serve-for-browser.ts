/**
 * Boots the real app on :3001 against the e2e scratch DB (never the dev DB), seeds a student +
 * two live opportunities, writes tokens/ids to OUT, and streams every OTP code to OTP_LOG so a
 * browser test can complete the teammate verification. Mail is captured, not sent.
 */
import './e2e-env';
import { writeFileSync, appendFileSync } from 'fs';
import { DeepPartial } from 'typeorm';
import { bootHarness, HarnessOptions, oppPayload } from './harness';
import { adminApprove } from './helpers';
import { UserRole } from '../../src/users/enums/user-role.enum';
import { User } from '../../src/users/entities/user.entity';
import { Opportunity } from '../../src/opportunities/entities/opportunity.entity';
import { Otp } from '../../src/students/entities/otp.entity';
import { Participation } from '../../src/engagement/entities/participant.entity';
import { npePackageVersion } from '../../src/ranking/npe-ranking-eligibility';
import { NpeRankingRun } from '../../src/ranking/entities/npe-ranking-run.entity';
import { NpeRankingEvaluation } from '../../src/ranking/entities/npe-ranking-evaluation.entity';
import { StudentReport } from '../../src/reports/entities/student-report.entity';
import { Client } from 'pg';

const OUT = process.env.OUT || '/tmp/serve-for-browser.json';
const OTP_LOG = process.env.OTP_LOG || '/tmp/serve-for-browser-otps.log';
const BNU = 'Beaconhouse National University (BNU)';
const day = (d: number) =>
  new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

/** `pg` ships no typings (and @types/pg is not installed): the few client members this file uses. */
type PgClient = {
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
};
const PgClient = Client as unknown as new (config: {
  host: string;
  port: number;
  user?: string;
  password?: string;
  database: string;
}) => PgClient;

/** The slice of the NPE evaluation payload the stub reads. */
type NpeStubPayload = {
  title?: string;
  projectId?: string;
  packageVersion?: string;
  uploaded_evidence_files?: { file_id: string; file_name: string }[];
};

type CreatedBody = { id: string };

async function freshScratchDb() {
  const c = new PgClient({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: 'postgres',
  });
  await c.connect();
  try {
    await c.query('DROP DATABASE IF EXISTS ciel_e2e_scratch WITH (FORCE)');
    await c.query('CREATE DATABASE ciel_e2e_scratch');
  } finally {
    await c.end();
  }
}

(async () => {
  await freshScratchDb();
  // Deterministic stand-in for OpenAI: a finished evaluation for any package, with a mixed evidence-read report.
  const aiStub: HarnessOptions['ai'] = {
    summarize: (section: string, payload: NpeStubPayload) => {
      if (section !== 'npe_ranking_evaluation')
        return Promise.resolve({ summary: '' });
      const keys = [
        'impact',
        'need',
        'sustain',
        'partner',
        'efficiency',
        'sdg',
        'scale',
        'learning',
      ];
      const base = 3 + (String(payload.title).length % 5) / 4; // 3.0 – 4.0, varies per project
      const criteria = Object.fromEntries(
        keys.map((k, i) => [
          k,
          {
            anchor: Math.min(5, base + (i % 3) * 0.3),
            confidence: 'high',
            reason: 'stub',
            claimIds: [`${k}-1`],
          },
        ]),
      );
      const claims = keys.map((k) => ({
        id: `${k}-1`,
        criterion: k,
        statement: `Documented ${k}`,
        source: 'Detailed report',
        locator: 'S4',
        support: 'high',
        limitation: 'stub',
      }));
      const files = payload.uploaded_evidence_files ?? [];
      return Promise.resolve({
        summary: 'stub',
        npeRanking: {
          projectId: payload.projectId,
          packageVersion: payload.packageVersion,
          readComplete: true,
          flags: [],
          summary: `Stub reading of ${payload.title}.`,
          limitations: 'Stub evaluation for browser testing.',
          criteria,
          claims,
        },
        evidenceInspection: {
          inspected: files
            .slice(0, 1)
            .map((f) => ({ id: f.file_id, name: f.file_name })),
          notInspected: files.slice(1).map((f) => ({
            id: f.file_id,
            name: f.file_name,
            reason:
              'file type cannot be read by the analyzer (video / office document / other)',
          })),
        },
      });
    },
  };
  const h = await bootHarness({ ai: aiStub });
  const admin = await h.makeUser(UserRole.SUPER_ADMIN);
  const org = await h.makeOrg('Browser NGO');
  const ngo = await h.makeUser(UserRole.NGO, { org });

  const liveOpp = async (title: string, scope: Record<string, unknown>) => {
    const res = await h
      .as(ngo)
      .post('/opportunities')
      .send(oppPayload({ title }));
    if (res.status !== 201)
      throw new Error(
        `create failed ${res.status} ${JSON.stringify(res.body)}`,
      );
    const created = res.body as CreatedBody;
    await adminApprove(h, admin, created.id);
    const live: DeepPartial<Opportunity> = {
      status: 'active',
      workflowStage: 'live',
      admin_approved: true,
      timeline: {
        type: 'fixed',
        start_date: day(-3),
        end_date: day(30),
        expected_hours: 20,
        volunteers_required: 4,
      },
      participation_scope: scope,
    };
    await h.opps.update(created.id, live);
    return created.id;
  };

  const scopedId = await liveOpp('Browser Scoped (BNU only)', {
    rule: 'own_university_only',
    creator_university_name: BNU,
    university_names: [BNU],
  });
  const openId = await liveOpp('Browser Open', {
    rule: 'open_all_universities',
  });

  // Legacy-shaped listing: scope says "open to all" but restricted_universities names BNU.
  const legacyId = await liveOpp('Browser Legacy (BNU restricted)', {
    rule: 'open_all_universities',
  });
  await h.opps.update(legacyId, { restricted_universities: [BNU] });
  const lumsStudent = await h.makeUser(UserRole.STUDENT, {
    overrides: { name: 'Lums Student', university: 'LUMS' },
  });
  const bnuMate = await h.makeUser(UserRole.STUDENT, {
    overrides: { name: 'Bnu Mate', university: 'BNU' },
  });

  const lead = await h.makeUser(UserRole.STUDENT, {
    overrides: {
      name: 'Zubair Student',
      university: 'BNU',
      phone: '+923038444425',
      cnic: null,
    } as unknown as Partial<User>,
  });
  // Lead with an approved team seat on the open project (for the report Section 1 teammate flow).
  const reportLead = await h.makeUser(UserRole.STUDENT, {
    overrides: {
      name: 'Report Lead',
      university: 'BNU',
      phone: '+923031111111',
      cnic: null,
    } as unknown as Partial<User>,
  });
  const parts = h.ds.getRepository(Participation);
  const teamId = 'TM-2026-BROWSER-SEED';
  await parts.save(
    parts.create({
      projectId: scopedId,
      studentId: reportLead.id,
      email: reportLead.email,
      fullName: 'Report Lead',
      mobile: '+923031111111',
      cnic: 'enc',
      cnicHash: 'hash-report-lead',
      cnicLast4: '0000',
      universityId: 'bnu',
      universityName: BNU,
      academicProgram: 'BS CS',
      yearOfStudy: '3rd Year',
      department: 'Computer Science',
      academicIntegrationType: 'Voluntary',
      emailVerified: true,
      mobileVerified: true,
      status: 'approved',
      participationMode: 'team',
      isTeamLead: true,
      teamId,
    }),
  );

  // Admin + an enrolled team with a draft report, for the Teams & enrollments browser checks.
  const adminUser = await h.makeUser(UserRole.SUPER_ADMIN, {
    overrides: { name: 'Browser Admin' },
  });
  const seatCols = (email: string) => ({
    email,
    mobile: '+923005550000',
    cnic: 'enc',
    cnicHash: `hash-${email}`,
    cnicLast4: '0000',
    universityId: 'bnu',
    universityName: BNU,
    academicProgram: 'BS CS',
    yearOfStudy: '3rd Year',
    department: 'Computer Science',
    academicIntegrationType: 'Voluntary',
    emailVerified: true,
    mobileVerified: true,
    status: 'approved',
    primaryFacultyEmail: 'faculty@e2e.test',
    attendanceApproverType: 'partner' as const,
  });
  const teamA = await h.makeUser(UserRole.STUDENT, {
    overrides: { name: 'Alpha Lead', university: 'BNU' },
  });
  const teamB = await h.makeUser(UserRole.STUDENT, {
    overrides: { name: 'Beta Member', university: 'BNU' },
  });
  const adminTeamId = 'TM-2026-ADMIN-DEMO';
  await parts.save(
    parts.create({
      ...seatCols(teamA.email),
      projectId: openId,
      studentId: teamA.id,
      fullName: 'Alpha Lead',
      participationMode: 'team',
      isTeamLead: true,
      teamId: adminTeamId,
    }),
  );
  await parts.save(
    parts.create({
      ...seatCols(teamB.email),
      projectId: openId,
      studentId: teamB.id,
      fullName: 'Beta Member',
      participationMode: 'team',
      isTeamLead: false,
      teamId: adminTeamId,
    }),
  );
  // Third seat on the same team: lets a browser run check lead→member attendance across two members.
  const teamZ = await h.makeUser(UserRole.STUDENT, {
    overrides: { name: 'Zubair Member', university: 'BNU' },
  });
  await parts.save(
    parts.create({
      ...seatCols(teamZ.email),
      projectId: openId,
      studentId: teamZ.id,
      fullName: 'Zubair Member',
      participationMode: 'team',
      isTeamLead: false,
      teamId: adminTeamId,
    }),
  );
  const teamC = await h.makeUser(UserRole.STUDENT, {
    overrides: { name: 'Gamma Lead', university: 'BNU' },
  });
  const teamD = await h.makeUser(UserRole.STUDENT, {
    overrides: { name: 'Delta Member', university: 'BNU' },
  });
  await parts.save(
    parts.create({
      ...seatCols(teamC.email),
      projectId: openId,
      studentId: teamC.id,
      fullName: 'Gamma Lead',
      participationMode: 'team',
      isTeamLead: true,
      teamId: 'TM-2026-ADMIN-GAMMA',
    }),
  );
  await parts.save(
    parts.create({
      ...seatCols(teamD.email),
      projectId: openId,
      studentId: teamD.id,
      fullName: 'Delta Member',
      participationMode: 'team',
      isTeamLead: false,
      teamId: 'TM-2026-ADMIN-GAMMA',
    }),
  );
  const reports = h.ds.getRepository(StudentReport);
  await reports.save(
    reports.create({
      studentId: teamB.id,
      opportunityId: openId,
      project_id: openId,
      status: 'draft',
    }),
  );

  const userJson = (
    u: { id: string; email: string },
    name: string,
    phone: string,
  ) => ({
    id: u.id,
    userId: u.id,
    name,
    email: u.email,
    role: 'student',
    university: 'BNU',
    institution: 'BNU',
    department: 'Computer Science',
    phone,
    status: 'active',
  });

  // Approved, CII-locked packages + one finished analysis run, for the Ranking Studio click-through.
  {
    const reports = h.ds.getRepository(StudentReport);
    const runRow = await h.ds.getRepository(NpeRankingRun).save(
      h.ds.getRepository(NpeRankingRun).create({
        rubricVersion: 'NPE-1.2',
        scope: 'national',
        role: 'ciel_admin',
        status: 'draft',
        createdByUserId: admin.id,
        packageVersions: {},
        reviewClearances: {},
        meta: {},
      }),
    );
    const seeds = [
      [
        'Clean Water Drive',
        'LUMS',
        'Computer Science',
        4,
        'Leadership',
        'Lahore',
        92,
        44,
        320,
        4.6,
      ],
      [
        'Reading Corner Renewal',
        'LUMS',
        'Education',
        4,
        'Communication',
        'Lahore',
        84,
        31,
        120,
        4.1,
      ],
      [
        'Solar Study Lights',
        'BNU',
        'Engineering',
        7,
        'Problem Solving',
        'Karachi',
        88,
        52,
        210,
        4.3,
      ],
      [
        'Women Enterprise Workshops',
        'BNU',
        'Management',
        8,
        'Leadership',
        'Karachi',
        76,
        28,
        90,
        3.7,
      ],
      [
        'Food Rescue Network',
        'NUST',
        'Social Sciences',
        2,
        'Teamwork',
        'Islamabad',
        81,
        36,
        640,
        3.9,
      ],
      [
        'Heritage Access Map',
        'NUST',
        'Arts & Design',
        11,
        'Creativity',
        'Islamabad',
        69,
        22,
        75,
        3.2,
      ],
      [
        'Unread Neighbourhood Clinic',
        'LUMS',
        'Health',
        3,
        'Empathy',
        'Lahore',
        78,
        30,
        140,
        0,
      ],
      [
        'Unread Tree Plantation',
        'NUST',
        'Environment',
        13,
        'Teamwork',
        'Islamabad',
        72,
        26,
        95,
        0,
      ],
    ] as const;
    for (const [
      title,
      uni,
      dept,
      sdg,
      skill,
      city,
      cii,
      hours,
      reach,
      anchor,
    ] of seeds) {
      const stu = await h.makeUser(UserRole.STUDENT, {
        overrides: {
          name: `${title} Lead`,
          university: uni,
          department: dept,
        },
      });
      const opp = await h
        .as(ngo)
        .post('/opportunities')
        .send(
          oppPayload({
            title: `${title} ${Math.random().toString(36).slice(2, 6)}`,
          }),
        );
      if (opp.status !== 201)
        throw new Error(
          `ranking seed opp failed ${opp.status} ${JSON.stringify(opp.body)}`,
        );
      const oppId = (opp.body as CreatedBody).id;
      await adminApprove(h, admin, oppId);
      const past: DeepPartial<Opportunity> = {
        status: 'active',
        workflowStage: 'live',
        admin_approved: true,
        timeline: {
          type: 'fixed',
          start_date: day(-60),
          end_date: day(-30),
          expected_hours: 10,
          volunteers_required: 4,
        },
        location: { city },
      };
      await h.opps.update(oppId, past);
      // Seeded as loose JSON on purpose (e.g. numeric hours), so it is not shaped like the entity's section types.
      const rep = await reports.save(
        reports.create({
          studentId: stu.id,
          opportunityId: oppId,
          project_id: oppId,
          status: 'verified',
          faculty_status: 'approved',
          admin_status: 'approved',
          partner_status: 'not_applicable',
          reportSubmittedAt: new Date(Date.now() - 20 * 86400000),
          submission_date: new Date(Date.now() - 20 * 86400000),
          section1: {
            participation_type: 'individual',
            team_lead: {
              name: stu.email,
              university: uni,
              degree: dept,
              hours,
            },
            metrics: { total_verified_hours: hours },
          },
          section2: { problem_statement: 'x' },
          section3: { primary_sdg: { goal_number: sdg } },
          section4: {
            project_summary: { distinct_total_beneficiaries: reach },
          },
          section8: {
            media_visible: 'public',
            evidence_files: [
              {
                url: 'https://bkt.s3.eu.amazonaws.com/e/receipt.pdf',
                name: 'receipt.pdf',
              },
              {
                url: 'https://bkt.s3.eu.amazonaws.com/e/clip.mp4',
                name: 'clip.mp4',
              },
            ],
          },
          section9: { skills_grown: [`🎯 ${skill}`] },
          review_package: { packet_integrity: { ok: true } },
          ciiV45: { finalCII: cii },
          ciiV45Lock: {
            locked: true,
            adminApprovedScore: cii,
            scoreStatusAtLock: 'FINAL',
            finalBadge: { name: cii >= 80 ? 'Advanced' : 'Impact Contributor' },
          },
        } as unknown as DeepPartial<StudentReport>),
      );
      if (!anchor) continue; // seeded as 'approved but not yet read by the AI'
      const criteria = Object.fromEntries(
        [
          'impact',
          'need',
          'sustain',
          'partner',
          'efficiency',
          'sdg',
          'scale',
          'learning',
        ].map((k, i) => [
          k,
          {
            anchor: Math.max(1, Math.min(5, anchor + ((i % 3) - 1) * 0.4)),
            confidence: 'high',
            reason: 'seeded',
            claimIds: ['c1'],
          },
        ]),
      );
      await h.ds.getRepository(NpeRankingEvaluation).save(
        h.ds.getRepository(NpeRankingEvaluation).create({
          runId: runRow.id,
          reportId: rep.id,
          packageVersion: npePackageVersion(rep),
          readComplete: true,
          flags: [],
          criteria,
          claims: [
            {
              id: 'c1',
              statement: 'Measured outcome documented in the report.',
              source: 'Detailed report',
              locator: 'S5',
              support: 'high',
            },
          ],
          summary: `${title}: documented outcomes with partner verification.`,
          limitations: 'Seeded demo evaluation.',
        }),
      );
    }
  }

  const lumsOrg = await h.makeOrg('LUMS', 'UNIVERSITY');
  await h.orgs.update(lumsOrg.id, {
    description: 'LUMS',
    city: 'Lahore',
    region: 'Punjab',
    contactName: 'LUMS Office',
    contactEmail: 'office@lums.test',
    contactPhone: '+923001112244',
    websiteUrl: 'https://lums.example.org',
  });
  const lumsUser = await h.makeUser(UserRole.UNIVERSITY, {
    org: lumsOrg,
    overrides: {
      name: 'LUMS Office',
      university: 'LUMS',
      institution: 'LUMS',
      city: 'Lahore',
    },
  });
  const emptyUniOrg = await h.makeOrg('Empty Uni', 'UNIVERSITY');
  await h.orgs.update(emptyUniOrg.id, {
    description: 'Empty Uni',
    city: 'Lahore',
    region: 'Punjab',
    contactName: 'Empty Office',
    contactEmail: 'office@empty.test',
    contactPhone: '+923001112266',
    websiteUrl: 'https://empty.example.org',
  });
  const emptyUniUser = await h.makeUser(UserRole.UNIVERSITY, {
    org: emptyUniOrg,
    overrides: {
      name: 'Empty Uni Office',
      university: 'Empty Uni',
      institution: 'Empty Uni',
      city: 'Lahore',
    },
  });

  // Partner / faculty logins with complete profiles, for the "Duplicate opportunity" click-through.
  await h.orgs.update(org.id, {
    description: 'Browser NGO working on clean water',
    city: 'Lahore',
    region: 'Punjab',
    contactName: 'NGO Contact',
    contactEmail: ngo.email,
    contactPhone: '+923001112233',
    websiteUrl: 'https://browser-ngo.example.org',
  });
  const facultyUser = await h.makeUser(UserRole.FACULTY, {
    overrides: {
      name: 'Browser Faculty',
      university: 'BNU',
      institution: 'BNU',
      city: 'Lahore',
      department: 'Computer Science',
      designation: 'Professor',
    } as Partial<User>,
  });
  const facSrc = await h
    .as(facultyUser)
    .post('/opportunities')
    .send(
      oppPayload({
        title: 'Faculty Source Opportunity',
        supervision: {
          contact: facultyUser.email,
          supervisor_name: 'Browser Faculty',
        },
      }),
    );
  if (facSrc.status !== 201)
    throw new Error(
      `faculty source failed ${facSrc.status} ${JSON.stringify(facSrc.body)}`,
    );

  writeFileSync(
    OUT,
    JSON.stringify(
      {
        uni: {
          token: lumsUser.token,
          user: {
            id: lumsUser.id,
            userId: lumsUser.id,
            name: 'LUMS Office',
            email: lumsUser.email,
            role: 'university',
            status: 'active',
            organizationId: lumsOrg.id,
            university: 'LUMS',
            institution: 'LUMS',
            city: 'Lahore',
            phone: '+923001112244',
          },
        },
        emptyUni: {
          token: emptyUniUser.token,
          user: {
            id: emptyUniUser.id,
            userId: emptyUniUser.id,
            name: 'Empty Uni Office',
            email: emptyUniUser.email,
            role: 'university',
            status: 'active',
            organizationId: emptyUniOrg.id,
            university: 'Empty Uni',
            institution: 'Empty Uni',
            city: 'Lahore',
            phone: '+923001112255',
          },
        },
        ngo: {
          token: ngo.token,
          user: {
            id: ngo.id,
            userId: ngo.id,
            name: 'NGO Contact',
            email: ngo.email,
            role: 'ngo',
            status: 'active',
            organizationId: org.id,
            phone: '+923001112233',
            city: 'Lahore',
          },
          orgId: org.id,
        },
        faculty: {
          token: facultyUser.token,
          user: {
            id: facultyUser.id,
            userId: facultyUser.id,
            name: 'Browser Faculty',
            email: facultyUser.email,
            role: 'faculty',
            status: 'active',
            university: 'BNU',
            institution: 'BNU',
            city: 'Lahore',
            department: 'Computer Science',
            designation: 'Professor',
            phone: '+923001234567',
            contact: '+923001234567',
          },
          sourceId: (facSrc.body as CreatedBody).id,
        },
        lead: {
          token: lead.token,
          user: userJson(lead, 'Zubair Student', '+923038444425'),
        },
        reportLead: {
          token: reportLead.token,
          user: userJson(reportLead, 'Report Lead', '+923031111111'),
          teamId,
        },
        admin: {
          token: adminUser.token,
          user: {
            id: adminUser.id,
            userId: adminUser.id,
            name: 'Browser Admin',
            email: adminUser.email,
            role: 'admin',
            status: 'active',
          },
        },
        adminTeamId,
        alphaLead: {
          token: teamA.token,
          user: userJson(teamA, 'Alpha Lead', '+923005550000'),
        },
        betaMember: {
          token: teamB.token,
          user: userJson(teamB, 'Beta Member', '+923005550000'),
        },
        zubairMember: {
          token: teamZ.token,
          user: userJson(teamZ, 'Zubair Member', '+923005550000'),
        },
        legacyId,
        lumsEmail: lumsStudent.email,
        bnuMateEmail: bnuMate.email,
        scopedId,
        openId,
      },
      null,
      2,
    ),
  );
  writeFileSync(OTP_LOG, '');
  await h.app.listen(3001);
  console.log(`READY :3001 → ${OUT}`);

  const seen = new Map<string, string>();
  const otps = h.ds.getRepository(Otp);
  setInterval(() => {
    otps
      .find()
      .then((rows) => {
        for (const r of rows) {
          if (r.otp && seen.get(r.email) !== r.otp) {
            seen.set(r.email, r.otp);
            appendFileSync(OTP_LOG, `${r.email} ${r.otp}\n`);
          }
        }
      })
      .catch(() => undefined); // a failed poll is retried on the next tick
  }, 700);
})().catch((e) => {
  console.error('serve-for-browser failed', e);
  process.exit(1);
});
