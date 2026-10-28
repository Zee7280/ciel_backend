/**
 * Impact Report lifecycle, end to end, through the real HTTP routes the frontend uses:
 *   seat gate -> draft autosaves -> submit gates (sections, hours) -> submit -> locks ->
 *   faculty/partner read-only -> admin reject (revision) -> student edit + resubmit ->
 *   admin publish (CII lock) -> post-publish locks, partner package, re-approve idempotency,
 *   force reject / close, public verification, team-lead rules, malformed ids.
 * Real Nest app + scratch Postgres (never the dev DB — see e2e-env.ts).
 */
import request from 'supertest';
import { DeepPartial, Repository } from 'typeorm';
import { bootHarness, Harness, E2eUser, oppPayload, uniq } from './e2e/harness';
import { adminApprove } from './e2e/helpers';
import { UserRole } from '../src/users/enums/user-role.enum';
import { User } from '../src/users/entities/user.entity';
import { Opportunity } from '../src/opportunities/entities/opportunity.entity';
import { Participation } from '../src/engagement/entities/participant.entity';
import { StudentReport } from '../src/reports/entities/student-report.entity';
import { OpportunityApplication } from '../src/opportunities/entities/opportunity-application.entity';

const day = (d: number) =>
  new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

/** A supertest response whose JSON body is known to have shape `T`. */
type Res<T> = Omit<request.Response, 'body'> & { body: T };
const typed = <T>(t: request.Test): Promise<Res<T>> =>
  t.then((r) => r as Res<T>);

/** Column-level patch for `h.opps.update` (the entity's jsonb columns are `any`). */
type OppPatch = Partial<Opportunity>;
type ReportPatch = Parameters<Repository<StudentReport>['update']>[1];

/** What the student / admin report routes return (only the fields these tests inspect). */
interface ReportData {
  id?: string;
  report_id: string;
  status: string;
  is_editable?: boolean;
  already_submitted?: boolean;
  report_submitted_at?: string;
  admin_status?: string;
  faculty_status?: string;
  admin_approved_at: string;
  feedback?: string;
  admin_feedback?: string;
  section2?: { problem_statement?: string };
}
interface ValidationIssue {
  field?: string;
  message?: unknown;
}
interface ReportRes {
  message?: string;
  data: ReportData;
  validation_issues: ValidationIssue[];
}
interface ListRes {
  data: Array<{ id?: string; report_id?: string }>;
  meta: { counts: { needsReview: number } };
}
type MailPackageArg = { audience?: string; to?: string } | undefined;

const ETHICS = {
  authentic: true,
  informed_consent: true,
  no_harm: true,
  privacy_respected: true,
};
const COMPETENCY = {
  cognitive_systemic: 3,
  cognitive_critical: 3,
  cognitive_evaluate: 3,
  practical_design: 3,
  practical_evidence: 3,
  practical_engagement: 3,
  social_empathy: 3,
  social_diversity: 3,
  social_collaboration: 3,
  transformative_longterm: 3,
  transformative_benefits: 3,
  transformative_sustainability: 3,
};

/** A body that clears every section-level submit rule (mirrors the live wizard). */
function fullSections(signature = 'Jane Student') {
  return {
    section1: { privacy_consent: true, review_checked: [true, true, true] },
    section2: {
      problem_statement:
        'Community lacks access to clean drinking water, and many households have relied on unsafe open wells for years, leading to repeated illness among children and elderly residents during the dry season.',
      discipline: 'Environmental Engineering',
      discipline_contribution:
        'Engineering methods were used to design, install and pressure-test the filtration units, then train household members on routine cleaning and maintenance procedures.',
      affected_group: 'Households without safe water',
      affected_count: '40',
      system_gaps: ['Access'],
      baseline_evidence: ['Survey'],
    },
    section3: {
      contribution_intent_statement:
        'Students will support safer water handling in the host community by installing household filtration units, demonstrating correct usage, and documenting baseline and follow-up water quality readings so that the partner organization can track improvement over the coming months and plan further interventions where needed.',
    },
    section4: {
      activity_blocks: [
        {
          title: 'Water filter installation',
          primary_category: 'Infrastructure',
          sub_category: 'Water / Sanitation Infrastructure',
          status: 'Completed',
          description:
            'Installed household water filters across five homes, showed each family how to assemble, clean and use the units correctly, and answered questions about ongoing maintenance.',
          outputs: [{ title: 'Filters installed', quantity: '5' }],
        },
      ],
      project_summary: {
        distinct_total_beneficiaries: 50,
        counting_method: 'Headcount',
      },
    },
    section5: {
      observed_change:
        'Households report improved water quality and fewer stomach illnesses since the filters were installed, with several families noting that children miss fewer school days and that water now looks and tastes noticeably cleaner than before the project began, according to informal household feedback collected during follow-up visits.',
      challenges:
        'Replacement parts were hard to find locally in the first week, and the team had to travel to a neighboring town to source the correct filter cartridges before installation could continue.',
      measurable_outcomes: [
        {
          outcome_area: 'Health',
          outcome_sub_category: 'Water quality',
          metric_category: 'Health outcome',
          metric: 'Households served',
          baseline: 0,
          endline: 50,
          unit: 'households',
          confidence_level: ['Directly Measured'],
          measurement_explanation:
            "Counted directly from the partner organization's household register, which was updated and cross-checked by the team at each site visit during the project.",
        },
      ],
    },
    section6: { use_resources: 'no' },
    section7: { has_partners: 'no' },
    section8: {
      has_evidence: 'no',
      media_visible: 'internal',
      ethical_compliance: ETHICS,
    },
    section9: {
      academic_integration: 'Course-linked assignment',
      skills_grown: ['💬 Communication'],
      reflection_biggest_learning: 'listening to the community',
      reflection_moment: 'children choosing books on day one',
      reflection_discipline_help: 'simple data tracking for attendance',
      personal_learning:
        'I learned how to document community work carefully, listen to residents before proposing solutions, and record evidence in a way that other people could later verify.',
      academic_application:
        'The project used fieldwork and data-collection methods from my engineering coursework, including basic water-quality testing and structured household interviews to track outcomes over time.',
      competency_scores: COMPETENCY,
    },
    section10: {
      continuation_status: 'no',
      continuation_details:
        'Funding is exhausted and no further paid sessions are planned, but the partner organization has agreed to keep one filter-maintenance volunteer on site so households can still get help with basic repairs and replacement parts if something breaks after the project formally ends this term, and the school has also offered to store spare parts so the volunteer does not need to travel far to get them when a filter needs attention.',
      mechanisms: ['No continuation mechanism'],
      scaling_potential: 'Not scalable',
      policy_influence: 'No',
    },
    section11: {
      final_declaration: [true, true, true, true, true],
      signature_name: signature,
    },
  };
}

describe('Impact Report lifecycle (real app + real Postgres)', () => {
  let h: Harness;
  let admin: E2eUser;
  let reports: Repository<StudentReport>;

  beforeAll(async () => {
    h = await bootHarness();
    admin = await h.makeUser(UserRole.SUPER_ADMIN);
    reports = h.ds.getRepository(StudentReport);
  });
  afterAll(async () => {
    await h.app.close();
  });
  beforeEach(() => h.mail.reset());

  const student = (over: Partial<User> = {}) =>
    h.makeUser(UserRole.STUDENT, {
      overrides: {
        university: 'E2E University',
        cnic: null,
        ...over,
      } as unknown as Partial<User>,
    });

  /** Live NGO opportunity, 6 required hours, window open, open to all universities. */
  const liveOpp = async (over: OppPatch = {}) => {
    const org = await h.makeOrg(`Host NGO ${uniq()}`);
    const ngo = await h.makeUser(UserRole.NGO, { org });
    const res = await h.as(ngo).post('/opportunities').send(oppPayload());
    expect(res.status).toBe(201);
    const created = res.body as { id: string };
    await adminApprove(h, admin, created.id);
    await h.opps.update(created.id, {
      status: 'active',
      workflowStage: 'live',
      admin_approved: true,
      timeline: {
        type: 'fixed',
        start_date: day(-20),
        end_date: day(20),
        expected_hours: 6,
        volunteers_required: 8,
      },
      participation_scope: { rule: 'open_all_universities' },
      ...over,
    } as OppPatch);
    return { opp: await h.reload(created.id), ngo, org };
  };

  const seat = (
    projectId: string,
    u: E2eUser,
    o: {
      lead?: boolean;
      teamId?: string | null;
      facultyEmail?: string | null;
      /** Default true: the named faculty already confirmed supervision. */
      supervised?: boolean;
    } = {},
  ) => {
    const parts = h.ds.getRepository(Participation);
    return parts.save(
      parts.create({
        email: u.email,
        mobile: '+923005550000',
        cnic: 'enc',
        cnicHash: `hash-${u.email}-${Math.random()}`,
        cnicLast4: '0000',
        universityId: 'uni',
        universityName: 'E2E University',
        academicProgram: 'BS CS',
        yearOfStudy: '3rd Year',
        department: 'Computer Science',
        academicIntegrationType: 'Voluntary',
        emailVerified: true,
        mobileVerified: true,
        status: 'approved',
        projectId,
        studentId: u.id,
        fullName: u.email.split('@')[0],
        participationMode: o.teamId ? 'team' : 'individual',
        isTeamLead: o.teamId ? !!o.lead : false,
        teamId: o.teamId ?? null,
        primaryFacultyEmail:
          o.facultyEmail === undefined ? 'faculty@e2e.test' : o.facultyEmail,
        facultySupervisionConfirmedAt:
          o.supervised === false ? null : new Date(),
        attendanceApproverType: 'partner',
      } as DeepPartial<Participation>),
    );
  };

  const logHours = async (
    u: E2eUser,
    seatId: string,
    start: string,
    end: string,
    daysAgo = 2,
  ) => {
    const r = await h
      .as(u)
      .post(`/engagement/${seatId}/attendance`)
      .send({
        dateOfEngagement: day(-daysAgo),
        startTime: start,
        endTime: end,
        organizationName: 'E2E School',
        activityType: 'Teaching',
        description: 'Taught a class',
      });
    expect(r.status).toBe(201);
    return (r.body as { data: unknown }).data;
  };

  const draft = (u: E2eUser, oppId: string, body: Record<string, any>) =>
    typed<ReportRes>(
      h
        .as(u)
        .post('/student/reports/draft')
        .send({ opportunityId: oppId, project_id: oppId, ...body }),
    );
  const submit = (u: E2eUser, oppId: string, body: Record<string, any>) =>
    typed<ReportRes>(
      h
        .as(u)
        .post(`/student/reports/${oppId}/submit`)
        .send({ project_id: oppId, ...body }),
    );
  const view = (u: E2eUser, key: string) =>
    typed<ReportRes>(h.as(u).get(`/student/reports/${key}`));
  const check = (u: E2eUser, oppId: string) =>
    typed<ReportRes>(
      h.as(u).get(`/students/reports/check?opportunityId=${oppId}`),
    );
  const adminVerify = (id: string, body: Record<string, any>) =>
    typed<ReportRes>(
      h.as(admin).patch(`/admin/reports/${id}/verify`).send(body),
    );
  const row = (id: string) => reports.findOneOrFail({ where: { id } });

  /** Seated solo student on a live listing with the required hours already logged. */
  const readyWorld = async () => {
    const { opp, ngo, org } = await liveOpp();
    const lead = await student();
    const leadSeat = await seat(opp.id, lead);
    await logHours(lead, leadSeat.id, '09:00', '12:00', 3);
    await logHours(lead, leadSeat.id, '09:00', '12:00', 2);
    return { opp, ngo, org, lead, leadSeat };
  };

  // ------------------------------------------------------------------ gates before any write
  describe('R1 who may start a report', () => {
    it('a student without an approved seat cannot draft or submit; a seated one can draft', async () => {
      const { opp } = await liveOpp();
      const stranger = await student();
      const d = await draft(stranger, opp.id, {
        section2: { problem_statement: 'x' },
      });
      expect(d.status).toBe(403);
      expect(d.body.message).toMatch(/Apply to this opportunity/);
      const s = await submit(stranger, opp.id, fullSections());
      expect(s.status).toBe(403);
      expect(await reports.count({ where: { studentId: stranger.id } })).toBe(
        0,
      );

      const seated = await student();
      await seat(opp.id, seated);
      const ok = await draft(seated, opp.id, {
        section2: { problem_statement: 'first words' },
      });
      expect(ok.status).toBe(201);
      expect(ok.body.data.report_id).toBeTruthy();
      expect((await row(ok.body.data.report_id)).status).toBe('draft');
    });

    it('a listing that is not live yet refuses report writes (403), and a closed reporting window refuses too', async () => {
      const { opp } = await liveOpp();
      const s = await student();
      await seat(opp.id, s);
      await h.opps.update(opp.id, {
        admin_approved: false,
        workflowStage: 'pending_approval',
        status: 'pending_approval',
      } as OppPatch);
      const notLive = await draft(s, opp.id, {
        section2: { problem_statement: 'x' },
      });
      expect(notLive.status).toBe(403);
      expect(notLive.body.message).toMatch(/not live/);

      await h.opps.update(opp.id, {
        admin_approved: true,
        workflowStage: 'live',
        status: 'active',
        timeline: {
          type: 'fixed',
          start_date: day(-200),
          end_date: day(-100),
          expected_hours: 6,
          volunteers_required: 8,
        },
      } as OppPatch);
      const closed = await draft(s, opp.id, {
        section2: { problem_statement: 'x' },
      });
      expect(closed.status).toBe(403);
      expect(closed.body.message).toMatch(/closed/i);
    });

    it("a stranger student / faculty / NGO cannot read a seated student's report", async () => {
      const w = await readyWorld();
      const d = await draft(w.lead, w.opp.id, fullSections());
      expect(d.status).toBe(201);
      const rid = d.body.data.report_id;
      const stranger = await student();
      const r1 = await view(stranger, rid);
      expect(r1.body?.data ?? null).toBeNull(); // no seat -> nothing of the report is returned
      const r2 = await view(stranger, w.opp.id);
      // no seat → pre-populate must not happen and no report body may leak
      expect(r2.body?.data?.section2?.problem_statement).toBeUndefined();
      const faculty = await h.makeUser(UserRole.FACULTY);
      expect(
        (await h.as(faculty).get(`/faculty/reports/${rid}`)).status,
      ).toBeGreaterThanOrEqual(400);
      const otherNgo = await h.makeUser(UserRole.NGO, {
        org: await h.makeOrg(),
      });
      expect((await h.as(otherNgo).get(`/partner/reports/${rid}`)).status).toBe(
        403,
      );
    });
  });

  // ------------------------------------------------------------------ drafts
  describe('R2 draft autosaves', () => {
    it('repeated partial saves merge section by section; status/check/view agree; no reviewer mail', async () => {
      const w = await readyWorld();
      const full = fullSections();
      const d1 = await draft(w.lead, w.opp.id, {
        section2: full.section2,
        section1: {
          ...full.section1,
          faculty_supervisor_email: `unregistered.${uniq()}@e2e.test`,
        },
      });
      expect(d1.status).toBe(201);
      const rid = d1.body.data.report_id;
      const d2 = await draft(w.lead, w.opp.id, { section3: full.section3 });
      expect(d2.status).toBe(201);
      expect(d2.body.data.report_id).toBe(rid); // same row, never a duplicate
      const r = await row(rid);
      expect(r.status).toBe('draft');
      expect(r.section2?.problem_statement).toBe(
        full.section2.problem_statement,
      ); // kept
      expect(r.section3?.contribution_intent_statement).toBe(
        full.section3.contribution_intent_statement,
      );
      expect(await reports.count({ where: { studentId: w.lead.id } })).toBe(1);

      const c = await check(w.lead, w.opp.id);
      expect(c.status).toBe(200);
      expect(c.body.data.report_id).toBe(rid);
      expect(c.body.data.status).toBe('draft');
      expect(c.body.data.is_editable).toBe(true);

      const v = await view(w.lead, w.opp.id);
      expect(v.status).toBe(200);
      expect(v.body.data.status).toBe('draft');
      expect(v.body.data.section2?.problem_statement).toBe(
        full.section2.problem_statement,
      );
      // an autosave is not a submit: nobody is emailed (faculty invite / admin review)
      expect(h.mail.of('sendAdminStudentReportSubmitted')).toHaveLength(0);
      expect(h.mail.of('sendFacultyInvite')).toHaveLength(0);
    });

    it('the student cannot self-assign AI scores through a draft or submit body', async () => {
      const w = await readyWorld();
      const d = await draft(w.lead, w.opp.id, {
        ...fullSections(),
        section11: {
          ...fullSections().section11,
          ai_generated_impact_score: 99,
          institutional_alignment_score: 99,
          verified_narrative: 'x',
          cii_index: { totalScore: 99 },
        },
      });
      expect(d.status).toBe(201);
      const r = await row(d.body.data.report_id);
      const s11 = r.section11 as Record<string, unknown> | null;
      expect(s11?.ai_generated_impact_score).toBeUndefined();
      expect(s11?.institutional_alignment_score).toBeUndefined();
      expect(s11?.cii_index).toBeUndefined();
    });
  });

  // ------------------------------------------------------------------ submit gates
  describe('R3 submit gates', () => {
    it('incomplete sections -> 400 with validation_issues; row stays draft and keeps its content', async () => {
      const w = await readyWorld();
      const partial = { section2: fullSections().section2 };
      const d = await draft(w.lead, w.opp.id, partial);
      const rid = d.body.data.report_id;
      const s = await submit(w.lead, w.opp.id, {});
      expect(s.status).toBe(400);
      expect(Array.isArray(s.body.validation_issues)).toBe(true);
      expect(s.body.validation_issues.length).toBeGreaterThan(0);
      const r = await row(rid);
      expect(r.status).toBe('draft');
      expect(r.reportSubmittedAt).toBeNull();
      expect(r.section2?.problem_statement).toBe(
        partial.section2.problem_statement,
      );
      expect(h.mail.of('sendAdminStudentReportSubmitted')).toHaveLength(0);
    });

    it('required hours not met -> 400 naming the hours; still draft', async () => {
      const { opp } = await liveOpp();
      const s = await student();
      const st = await seat(opp.id, s);
      await logHours(s, st.id, '09:00', '11:00'); // 2h of 6h
      const r = await submit(s, opp.id, fullSections());
      expect(r.status).toBe(400);
      expect(r.body.message).toMatch(/Required engagement hours/);
      expect(r.body.validation_issues?.[0]?.field).toBe(
        'metrics.individual_hours',
      );
      const rows = await reports.find({ where: { studentId: s.id } });
      expect(
        rows.every((x) => x.status === 'draft' && !x.reportSubmittedAt),
      ).toBe(true);
    });

    it('a first-time submit with no prior draft still needs a seat and hours (no partial row left behind)', async () => {
      const { opp } = await liveOpp();
      const s = await student();
      await seat(opp.id, s);
      const r = await submit(s, opp.id, fullSections());
      expect(r.status).toBe(400);
      expect(await reports.count({ where: { studentId: s.id } })).toBe(0);
    });
  });

  // ------------------------------------------------------------------ submit + locks
  describe('R4 submit, lock, reviewer visibility', () => {
    it('submit -> submitted; stamps; admin mail once; second submit is a no-op; autosave no longer edits', async () => {
      const w = await readyWorld();
      const body = fullSections();
      const s = await submit(w.lead, w.opp.id, body);
      expect(s.status).toBe(201);
      expect(s.body.data.status).toBe('submitted');
      expect(s.body.data.report_submitted_at).toBeTruthy();
      const rid = s.body.data.report_id;
      const r = await row(rid);
      expect(r.status).toBe('submitted');
      expect(r.admin_status).toBe('pending');
      expect(r.review_package).toBeTruthy();
      expect(h.mail.of('sendAdminStudentReportSubmitted')).toHaveLength(1);

      // student sees it locked
      const c = await check(w.lead, w.opp.id);
      expect(c.body.data.status).toBe('submitted');
      expect(c.body.data.is_editable).toBe(false);

      // double submit: same row, no re-stamp, no second mail
      const again = await submit(w.lead, w.opp.id, {
        ...body,
        section2: {
          ...body.section2,
          problem_statement:
            'CHANGED AFTER SUBMIT ' + body.section2.problem_statement,
        },
      });
      expect(again.status).toBe(201);
      expect(again.body.data.already_submitted).toBe(true);
      const r2 = await row(rid);
      expect(r2.section2?.problem_statement).toBe(
        body.section2.problem_statement,
      );
      expect(new Date(r2.reportSubmittedAt!).getTime()).toBe(
        new Date(r.reportSubmittedAt!).getTime(),
      );
      expect(h.mail.of('sendAdminStudentReportSubmitted')).toHaveLength(1);

      // autosave after submit must not touch content or status
      const d = await draft(w.lead, w.opp.id, {
        section2: { ...body.section2, problem_statement: 'DRAFT AFTER SUBMIT' },
      });
      expect(d.status).toBe(201);
      const r3 = await row(rid);
      expect(r3.status).toBe('submitted');
      expect(r3.section2?.problem_statement).toBe(
        body.section2.problem_statement,
      );
    });

    it('faculty is read-only; partner cannot verify and cannot open before CIEL PK accepts; admin lists it as needing review', async () => {
      const w = await readyWorld();
      const s = await submit(w.lead, w.opp.id, fullSections());
      const rid = s.body.data.report_id;
      const faculty = await h.makeUser(UserRole.FACULTY, {
        email: 'faculty@e2e.test'.replace('faculty', `fac.${uniq()}`),
      });
      const act = await h
        .as(faculty)
        .post(`/faculty/reports/${rid}/action`)
        .send({ status: 'approved' });
      expect(act.status).toBe(403);
      for (const p of [
        `/partner/reports/${rid}/verify`,
        `/partners/student-reports/${rid}/verify`,
      ]) {
        const r = await h.as(w.ngo).patch(p).send({ action: 'approve' });
        expect(r.status).toBe(403);
      }
      const early = await h.as(w.ngo).get(`/partner/reports/${rid}`);
      expect(early.status).toBe(403);
      expect((await row(rid)).admin_status).toBe('pending');

      const list = await h.as(admin).get('/admin/reports?limit=200');
      expect(list.status).toBe(200);
      const listBody = list.body as ListRes;
      expect(listBody.data.map((x) => x.id)).toContain(rid);
      expect(listBody.meta.counts.needsReview).toBeGreaterThanOrEqual(1);
      const one = await h.as(admin).get(`/admin/reports/${rid}`);
      expect(one.status).toBe(200);
    });
  });

  // ------------------------------------------------------------------ admin decisions
  describe('R5 admin reject -> student revision -> resubmit -> publish', () => {
    it('full cycle with the right statuses, mails and locks at every step', async () => {
      const w = await readyWorld();
      const body = fullSections();
      const rid = (await submit(w.lead, w.opp.id, body)).body.data.report_id;

      // cannot publish before CII lock; cannot reject without a reason; cannot approve a draft
      const noCii = await adminVerify(rid, { action: 'approve' });
      expect(noCii.status).toBe(400);
      expect(noCii.body.message).toMatch(/CII/);
      expect((await adminVerify(rid, { action: 'reject' })).status).toBe(400);
      expect(
        (await adminVerify(rid, { action: 'reject', reason: '   ' })).status,
      ).toBe(400);
      expect(
        (await adminVerify(rid, { action: 'bogus', reason: 'x' })).status,
      ).toBe(400);
      expect((await row(rid)).status).toBe('submitted');

      // reject with reason -> revision, student notified, editable again
      h.mail.reset();
      const rej = await adminVerify(rid, {
        action: 'reject',
        reason: 'Please add the baseline survey.',
      });
      expect(rej.status).toBe(200);
      expect(rej.body.data.status).toBe('revision');
      expect(rej.body.data.admin_status).toBe('rejected');
      const c = await check(w.lead, w.opp.id);
      expect(c.body.data.status).toBe('revision');
      expect(c.body.data.is_editable).toBe(true);
      expect(
        String(c.body.data.feedback || c.body.data.admin_feedback),
      ).toMatch(/baseline survey/);
      // the rejected report cannot be approved by a second click
      const reApprove = await adminVerify(rid, { action: 'approve' });
      expect(reApprove.status).toBe(400);
      expect(reApprove.body.message).toMatch(/resubmits/);
      // ...and neither can CII Confirm publish it while it is sent back
      await reports.update(rid, {
        ciiV45: { finalCII: 70, inputFingerprint: 'fp' },
      } as ReportPatch);
      const ciiConfirm = await h
        .as(admin)
        .post(`/admin/community-service/reports/${rid}/cii-v4-5/approve`)
        .send({});
      expect(ciiConfirm.status).toBe(400);
      expect((ciiConfirm.body as { message?: string }).message).toMatch(
        /resubmits/,
      );
      expect((await row(rid)).status).toBe('revision');
      await reports.update(rid, { ciiV45: null } as ReportPatch);

      // student edits in revision (autosave keeps 'revision'), then resubmits
      const edited = {
        ...body.section2,
        problem_statement:
          body.section2.problem_statement +
          ' Baseline survey of forty households attached.',
      };
      const d = await draft(w.lead, w.opp.id, { section2: edited });
      expect(d.status).toBe(201);
      expect((await row(rid)).status).toBe('revision');
      expect((await row(rid)).section2?.problem_statement).toBe(
        edited.problem_statement,
      );
      h.mail.reset();
      const re = await submit(w.lead, w.opp.id, { ...body, section2: edited });
      expect(re.status).toBe(201);
      expect(re.body.data.already_submitted).toBeUndefined();
      const r = await row(rid);
      expect(r.status).toBe('submitted');
      expect(r.admin_status).toBe('pending');
      expect(r.admin_feedback || '').toBe('');
      expect(r.section2?.problem_statement).toBe(edited.problem_statement);
      expect(h.mail.of('sendAdminStudentReportSubmitted')).toHaveLength(1);
      expect((await check(w.lead, w.opp.id)).body.data.is_editable).toBe(false);

      // CIEL PK locks the CII (AI step simulated: lock written as approveCiiV45ForAdmin would)
      await reports.update(rid, {
        ciiV45: { finalCII: 72, frameworkVersion: '4.5' },
        ciiV45Lock: {
          locked: true,
          hash: 'e2e',
          lockedAt: new Date().toISOString(),
          lockedByAdminId: admin.id,
          inputFingerprint: 'fp',
          scoreStatusAtLock: 'FINAL',
          adminApprovedScore: 72,
        },
      } as ReportPatch);
      h.mail.reset();
      const pub = await adminVerify(rid, { action: 'approve' });
      expect(pub.status).toBe(200);
      expect(pub.body.data.status).toBe('verified');
      expect(pub.body.data.admin_status).toBe('approved');
      expect(pub.body.data.faculty_status).toBe('approved');
      expect(pub.body.data.admin_approved_at).toBeTruthy();
      const v = await row(rid);
      expect(v.status).toBe('verified');
      expect(v.partner_status).toBe('not_applicable');
      expect(v.adminReviewedBy).toContain(admin.id);
      // package mail goes out (student at least), once
      await new Promise((res) => setTimeout(res, 150));
      const pkg = h.mail.of('sendReportPackagePublished');
      expect(pkg.length).toBeGreaterThanOrEqual(1);
      expect(
        pkg.some((m) => {
          const arg = m.args[0] as MailPackageArg;
          return arg?.audience === 'student' && arg?.to === w.lead.email;
        }),
      ).toBe(true);

      // student: verified, locked for edits, score visible only as published
      const sc = await check(w.lead, w.opp.id);
      expect(sc.body.data.status).toBe('verified');
      expect(sc.body.data.is_editable).toBe(false);
      expect(
        (await draft(w.lead, w.opp.id, { section2: body.section2 })).status,
      ).toBe(400);
      expect((await submit(w.lead, w.opp.id, body)).status).toBe(400);
      const sv = await view(w.lead, rid);
      expect(sv.status).toBe(200);
      expect(sv.body.data.status).toBe('verified');

      // host NGO now opens the package read-only; a stranger org still cannot
      const host = await h.as(w.ngo).get(`/partner/reports/${rid}`);
      expect(host.status).toBe(200);
      const list = await h.as(w.ngo).get('/partner/reports?limit=100');
      expect(list.status).toBe(200);
      expect((list.body as ListRes).data.map((x) => x.id)).toContain(rid);
      const otherNgo = await h.makeUser(UserRole.NGO, {
        org: await h.makeOrg(),
      });
      expect((await h.as(otherNgo).get(`/partner/reports/${rid}`)).status).toBe(
        403,
      );

      // re-approve is idempotent: same timestamp, no second package mail
      h.mail.reset();
      const again = await adminVerify(rid, { action: 'approve' });
      expect(again.status).toBe(200);
      expect(new Date(again.body.data.admin_approved_at).getTime()).toBe(
        new Date(v.adminApprovedAt!).getTime(),
      );
      await new Promise((res) => setTimeout(res, 100));
      expect(h.mail.of('sendReportPackagePublished')).toHaveLength(0);

      // public verification works for a verified report
      const slug = v.verificationPublicSlug;
      expect(slug).toBeTruthy();
      const pubv = await h
        .as(null)
        .get(`/public/impact-reports/${slug}/verification`);
      expect(pubv.status).toBe(200);

      // undoing a published decision needs force; close needs a reason and ends the report
      expect(
        (await adminVerify(rid, { action: 'reject', reason: 'oops' })).status,
      ).toBe(400);
      expect((await adminVerify(rid, { action: 'close' })).status).toBe(400);
      const closed = await adminVerify(rid, {
        action: 'close',
        reason: 'Duplicate of another package',
      });
      expect(closed.status).toBe(200);
      expect(closed.body.data.status).toBe('closed');
      expect((await row(rid)).closeReason).toBe('Duplicate of another package');
    });

    it('force reject of a published report reopens it for the student and retires the CII lock', async () => {
      const w = await readyWorld();
      const rid = (await submit(w.lead, w.opp.id, fullSections())).body.data
        .report_id;
      await reports.update(rid, {
        ciiV45: { finalCII: 60 },
        ciiV45Lock: {
          locked: true,
          hash: 'e2e',
          lockedAt: new Date().toISOString(),
          lockedByAdminId: admin.id,
          inputFingerprint: 'fp',
          scoreStatusAtLock: 'FINAL',
        },
      } as ReportPatch);
      expect((await adminVerify(rid, { action: 'approve' })).status).toBe(200);
      const forced = await adminVerify(rid, {
        action: 'reject',
        reason: 'Evidence withdrawn',
        force: true,
      });
      expect(forced.status).toBe(200);
      expect(forced.body.data.status).toBe('revision');
      const r = await row(rid);
      expect(r.ciiV45Lock?.locked).not.toBe(true);
      expect((await check(w.lead, w.opp.id)).body.data.is_editable).toBe(true);
      // student resubmits; admin must lock the CII again before publishing
      const re = await submit(w.lead, w.opp.id, fullSections());
      expect(re.status).toBe(201);
      expect((await row(rid)).status).toBe('submitted');
      const pub = await adminVerify(rid, { action: 'approve' });
      expect(pub.status).toBe(400);
      expect(pub.body.message).toMatch(/CII/);
    });

    it('unlock sends a verified report back to a real draft that autosaves again', async () => {
      const w = await readyWorld();
      const body = fullSections();
      const rid = (await submit(w.lead, w.opp.id, body)).body.data.report_id;
      await reports.update(rid, {
        ciiV45: { finalCII: 60 },
        ciiV45Lock: { locked: true },
      } as ReportPatch);
      expect((await adminVerify(rid, { action: 'approve' })).status).toBe(200);
      const un = await adminVerify(rid, {
        action: 'unlock',
        reason: 'Student asked to extend',
        force: true,
      });
      expect(un.status).toBe(200);
      expect(un.body.data.status).toBe('draft');
      const edited = {
        ...body.section2,
        problem_statement: 'After unlock ' + body.section2.problem_statement,
      };
      expect((await draft(w.lead, w.opp.id, { section2: edited })).status).toBe(
        201,
      );
      expect((await row(rid)).section2?.problem_statement).toBe(
        edited.problem_statement,
      );
      expect(
        (await submit(w.lead, w.opp.id, { ...body, section2: edited })).status,
      ).toBe(201);
      expect((await row(rid)).status).toBe('submitted');
    });
  });

  // ------------------------------------------------------------------ team rules
  describe('R6 team projects', () => {
    it('only the lead writes; every member needs their own hours; members can read the shared report', async () => {
      const { opp } = await liveOpp();
      const lead = await student();
      const mate = await student();
      const teamId = `TM-${uniq().toUpperCase()}`;
      const leadSeat = await seat(opp.id, lead, { lead: true, teamId });
      const mateSeat = await seat(opp.id, mate, { teamId });
      await logHours(lead, leadSeat.id, '09:00', '12:00', 3);
      await logHours(lead, leadSeat.id, '09:00', '12:00', 2);

      const mateDraft = await draft(mate, opp.id, {
        section2: fullSections().section2,
      });
      expect(mateDraft.status).toBe(403);
      expect(mateDraft.body.message).toMatch(/team lead/i);
      expect((await submit(mate, opp.id, fullSections())).status).toBe(403);

      const short = await submit(lead, opp.id, fullSections());
      expect(short.status).toBe(400);
      expect(short.body.message).toMatch(
        /Every team member must individually meet/,
      );
      expect(
        short.body.validation_issues.some((i) =>
          String(i.message).includes(mateSeat.fullName),
        ),
      ).toBe(true);

      await logHours(mate, mateSeat.id, '09:00', '12:00', 3);
      await logHours(lead, mateSeat.id, '09:00', '12:00', 2); // lead proxy entry counts for the mate
      const ok = await submit(lead, opp.id, fullSections());
      expect(ok.status).toBe(201);
      const rid = ok.body.data.report_id;
      expect(await reports.count({ where: { opportunityId: opp.id } })).toBe(1);

      const mateView = await view(mate, opp.id);
      expect(mateView.status).toBe(200);
      expect(mateView.body.data.status).toBe('submitted');
      expect(mateView.body.data.report_id ?? mateView.body.data.id).toBe(rid);
      const mateCheck = await check(mate, opp.id);
      expect(mateCheck.body.data.report_id).toBe(rid);
    });
  });

  it('reminding the reviewer: the owner and their teammates may; another team or a solo student on the same project may not', async () => {
    const { opp } = await liveOpp();
    const lead = await student();
    const mate = await student();
    const teamId = `TM-${uniq().toUpperCase()}`;
    const leadSeat = await seat(opp.id, lead, { lead: true, teamId });
    const mateSeat = await seat(opp.id, mate, { teamId });
    for (const [u, st] of [
      [lead, leadSeat],
      [mate, mateSeat],
    ] as const) {
      await logHours(u, st.id, '09:00', '12:00', 3);
      await logHours(u, st.id, '09:00', '12:00', 2);
    }
    const rid = (await submit(lead, opp.id, fullSections())).body.data
      .report_id;
    const otherTeamMember = await student();
    await seat(opp.id, otherTeamMember, {
      lead: true,
      teamId: `TM-${uniq().toUpperCase()}`,
    });
    const solo = await student();
    await seat(opp.id, solo);

    const remind = (u: E2eUser) =>
      h.as(u).post(`/student/reports/${rid}/remind-reviewer`).send({});
    expect((await remind(lead)).status).toBe(201);
    expect((await remind(mate)).status).toBe(201);
    for (const outsider of [otherTeamMember, solo]) {
      const r = await remind(outsider);
      expect(r.status).toBe(403);
      expect(JSON.stringify(r.body)).not.toContain(lead.email); // the lead's e-mail is never disclosed
    }
  });

  // ------------------------------------------------------------------ robustness
  describe('R7 malformed ids and listings', () => {
    it('garbage / unknown ids are 4xx, never 500, on every report endpoint', async () => {
      const s = await student();
      const unknown = '00000000-0000-4000-8000-000000000000';
      const probes: Array<
        [E2eUser, 'get' | 'post' | 'patch', string, Record<string, unknown>?]
      > = [
        [s, 'get', '/student/reports/not-a-uuid'],
        [s, 'get', `/student/reports/${unknown}`],
        [s, 'get', '/students/reports/check?opportunityId=not-a-uuid'],
        [s, 'post', '/student/reports/not-a-uuid/submit', fullSections()],
        [
          s,
          'post',
          '/student/reports/draft',
          { opportunityId: 'not-a-uuid', section2: {} },
        ],
        [s, 'post', `/student/reports/${unknown}/draft`, { section2: {} }],
        [s, 'post', '/student/reports/not-a-uuid/remind-reviewer', {}],
        [admin, 'get', '/admin/reports/not-a-uuid'],
        [admin, 'get', `/admin/reports/${unknown}`],
        [
          admin,
          'patch',
          '/admin/reports/not-a-uuid/verify',
          { action: 'approve' },
        ],
        [
          admin,
          'patch',
          `/admin/reports/${unknown}/verify`,
          { action: 'reject', reason: 'x' },
        ],
        [admin, 'get', '/admin/reports/not-a-uuid/ai-evaluation-payload'],
      ];
      for (const [u, m, p, b] of probes) {
        const api = h.as(u);
        const res =
          m === 'get' ? await api.get(p) : await api[m](p).send(b ?? {});
        expect({ p, status: res.status < 500 }).toEqual({ p, status: true });
        expect(res.status).toBeGreaterThanOrEqual(200);
        expect(res.status).toBeLessThan(500);
      }
    });

    it('a student only ever lists their own reports; studentId spoofing is refused', async () => {
      const w = await readyWorld();
      const rid = (
        await draft(w.lead, w.opp.id, { section2: fullSections().section2 })
      ).body.data.report_id;
      const other = await student();
      const spoof = await h
        .as(other)
        .get(`/students/reports?studentId=${w.lead.id}`);
      expect([400, 403]).toContain(spoof.status);
      const mineOther = await h.as(other).get('/student/reports');
      expect(mineOther.status).toBe(200);
      expect(
        (mineOther.body as ListRes).data.map((x) => x.id ?? x.report_id),
      ).not.toContain(rid);
      const mine = await h.as(w.lead).get('/student/reports');
      expect(mine.status).toBe(200);
      expect(
        (mine.body as ListRes).data.map((x) => x.id ?? x.report_id),
      ).toContain(rid);
      const alias = await h
        .as(other)
        .get(`/student/reports?studentId=${w.lead.id}`);
      expect(alias.status).toBe(200);
      expect(
        (alias.body as ListRes).data.map((x) => x.id ?? x.report_id),
      ).not.toContain(rid);
    });
  });

  describe('R-tracker admin Project Journey: report start and the faculty named for it', () => {
    type Tracking = Record<string, unknown>;
    const trackingFor = async (oppId: string, studentId: string) => {
      const res = await h.as(admin).get(`/admin/opportunities/${oppId}/teams`);
      expect(res.status).toBe(200);
      const body = res.body as {
        summary?: { applications_roster?: Array<Record<string, unknown>> };
      };
      const roster = body.summary?.applications_roster ?? [];
      const row = roster.find((r) => r.student_user_id === studentId);
      expect(row).toBeDefined();
      return row?.enrollment_tracking as Tracking;
    };

    it('shows when the report started / was submitted and the faculty email, with its CIEL account', async () => {
      const w = await readyWorld();
      const fac = await h.makeUser(UserRole.FACULTY, {
        overrides: { name: 'Dr Report Faculty' },
      });
      const apps = h.ds.getRepository(OpportunityApplication);
      const app = await apps.save(
        apps.create({
          opportunityId: w.opp.id,
          studentUserId: w.lead.id,
          internalStatus: 'approved',
          primaryFacultyEmail: fac.email,
          applyPayload: {},
        } as DeepPartial<OpportunityApplication>),
      );
      await h.ds.getRepository(Participation).update(w.leadSeat.id, {
        applicationId: app.id,
        primaryFacultyEmail: ` ${fac.email.toUpperCase()} `,
        secondaryFacultyEmail: 'second.faculty@e2e.test',
      });

      const before = await trackingFor(w.opp.id, w.lead.id);
      expect(before.impact_report_started).toBe(false);
      expect(before.impact_report_started_at).toBeNull();
      expect(before.impact_report_submitted_at).toBeNull();
      expect(before.report_faculty_email).toBe(fac.email);
      expect(before.report_faculty_secondary_email).toBe(
        'second.faculty@e2e.test',
      );
      expect(before.report_faculty_name).toBe('Dr Report Faculty');
      expect(before.report_faculty_account_role).toBe('faculty');
      // existing fields are unchanged
      expect(before.impact_report_summary).toBe('No impact report yet');
      // the fixture seat is already confirmed by its faculty
      expect(before.report_supervision_required).toBe(true);
      expect(before.report_supervision_confirmed_at).not.toBeNull();

      const rid = (
        await draft(w.lead, w.opp.id, { section2: fullSections().section2 })
      ).body.data.report_id;
      const started = await trackingFor(w.opp.id, w.lead.id);
      expect(started.impact_report_started).toBe(true);
      expect(started.impact_report_id).toBe(rid);
      expect(new Date(String(started.impact_report_started_at)).getTime()).toBe(
        (await row(rid)).createdAt.getTime(),
      );
      expect(started.impact_report_submitted_at).toBeNull();

      expect((await submit(w.lead, w.opp.id, fullSections())).status).toBe(201);
      const sub = await trackingFor(w.opp.id, w.lead.id);
      expect(new Date(String(sub.impact_report_submitted_at)).getTime()).toBe(
        (await row(rid)).reportSubmittedAt!.getTime(),
      );
      expect(sub.report_faculty_email).toBe(fac.email);
    });

    it('an email with no CIEL account shows no name; a missing email reads null', async () => {
      const w = await readyWorld();
      const apps = h.ds.getRepository(OpportunityApplication);
      const app = await apps.save(
        apps.create({
          opportunityId: w.opp.id,
          studentUserId: w.lead.id,
          internalStatus: 'approved',
          applyPayload: {},
        } as DeepPartial<OpportunityApplication>),
      );
      const parts = h.ds.getRepository(Participation);
      await parts.update(w.leadSeat.id, {
        applicationId: app.id,
        primaryFacultyEmail: `nobody.${uniq()}@e2e.test`,
      });
      const unknown = await trackingFor(w.opp.id, w.lead.id);
      expect(unknown.report_faculty_email).toMatch(/^nobody\./);
      expect(unknown.report_faculty_name).toBeNull();
      expect(unknown.report_faculty_account_role).toBeNull();

      await parts.update(w.leadSeat.id, {
        primaryFacultyEmail: null as unknown as string,
        facultySupervisorEmail: null as unknown as string,
      });
      const none = await trackingFor(w.opp.id, w.lead.id);
      expect(none.report_faculty_email).toBeNull();
      expect(none.report_faculty_secondary_email).toBeNull();
    });
  });

  describe('R-supervision the named faculty confirms before a new report can start', () => {
    type SupervisionState = {
      blocked: boolean;
      required: boolean;
      confirmed: boolean;
      faculty_email: string | null;
      faculty_name: string | null;
      faculty_registered: boolean;
      requested_at: string | null;
    };
    const supervision = async (u: E2eUser, oppId: string) => {
      const r = await h.as(u).get(`/student/reports/${oppId}/supervision`);
      expect(r.status).toBe(200);
      return (r.body as { data: SupervisionState }).data;
    };
    const unconfirmedWorld = async () => {
      const { opp } = await liveOpp();
      const fac = await h.makeUser(UserRole.FACULTY, {
        overrides: { name: 'Dr Supervisor' },
      });
      const lead = await student();
      const leadSeat = await seat(opp.id, lead, {
        facultyEmail: fac.email,
        supervised: false,
      });
      await logHours(lead, leadSeat.id, '09:00', '12:00', 3);
      await logHours(lead, leadSeat.id, '09:00', '12:00', 2);
      return { opp, fac, lead, leadSeat };
    };

    it('blocks the first draft and submit, asks the faculty once, then opens after the faculty confirms', async () => {
      const w = await unconfirmedWorld();
      const before = await supervision(w.lead, w.opp.id);
      expect(before).toMatchObject({
        required: true,
        confirmed: false,
        blocked: true,
        faculty_email: w.fac.email,
        faculty_name: 'Dr Supervisor',
        faculty_registered: true,
        requested_at: null,
      });

      const d1 = await draft(w.lead, w.opp.id, {
        section2: fullSections().section2,
      });
      expect(d1.status).toBe(403);
      expect((d1.body as unknown as { code: string }).code).toBe(
        'faculty_supervision_pending',
      );
      expect(h.mail.of('sendReportSupervisionRequest')).toHaveLength(1);
      expect(
        h.mail.of('sendReportSupervisionRequest')[0].args[0],
      ).toMatchObject({
        to: w.fac.email,
        teamSize: 1,
      });
      // No report row was written, and a second attempt does not mail again.
      expect(await reports.count({ where: { studentId: w.lead.id } })).toBe(0);
      expect((await submit(w.lead, w.opp.id, fullSections())).status).toBe(403);
      expect(h.mail.of('sendReportSupervisionRequest')).toHaveLength(1);
      expect((await supervision(w.lead, w.opp.id)).requested_at).not.toBeNull();

      // A reminder right after the request is throttled.
      const remind = await h
        .as(w.lead)
        .post(`/student/reports/${w.opp.id}/supervision/remind`);
      expect(remind.status).toBe(201);
      expect((remind.body as { sent: boolean }).sent).toBe(false);
      expect(h.mail.of('sendReportSupervisionRequest')).toHaveLength(1);

      // The faculty sees the request; another faculty cannot confirm it.
      const list = await h.as(w.fac).get('/faculty/report-supervision');
      expect(list.status).toBe(200);
      const pending = (
        list.body as {
          data: { pending: Array<{ participation_id: string }> };
        }
      ).data.pending;
      expect(pending.map((p) => p.participation_id)).toContain(w.leadSeat.id);
      const stranger = await h.makeUser(UserRole.FACULTY);
      expect(
        (
          await h
            .as(stranger)
            .post(`/faculty/report-supervision/${w.leadSeat.id}/confirm`)
        ).status,
      ).toBe(403);
      expect(
        (
          await h
            .as(w.lead)
            .post(`/faculty/report-supervision/${w.leadSeat.id}/confirm`)
        ).status,
      ).toBe(403);

      const ok = await h
        .as(w.fac)
        .post(`/faculty/report-supervision/${w.leadSeat.id}/confirm`);
      expect(ok.status).toBe(201);
      const after = await supervision(w.lead, w.opp.id);
      expect(after).toMatchObject({ confirmed: true, blocked: false });
      const listAfter = await h.as(w.fac).get('/faculty/report-supervision');
      const data = (
        listAfter.body as {
          data: {
            pending: Array<{ participation_id: string }>;
            confirmed: Array<{ participation_id: string }>;
          };
        }
      ).data;
      expect(data.pending.map((p) => p.participation_id)).not.toContain(
        w.leadSeat.id,
      );
      expect(data.confirmed.map((p) => p.participation_id)).toContain(
        w.leadSeat.id,
      );

      const d2 = await draft(w.lead, w.opp.id, {
        section2: fullSections().section2,
      });
      expect(d2.status).toBe(201);
      expect((await submit(w.lead, w.opp.id, fullSections())).status).toBe(201);
    });

    it('a report already started is never stopped, and exempt seats are not asked', async () => {
      // Started before the rule: an existing row keeps autosaving.
      const w = await unconfirmedWorld();
      await reports.save(
        reports.create({
          studentId: w.lead.id,
          opportunityId: w.opp.id,
          project_id: w.opp.id,
          status: 'draft',
        }),
      );
      expect((await supervision(w.lead, w.opp.id)).blocked).toBe(false);
      expect(
        (await draft(w.lead, w.opp.id, { section2: fullSections().section2 }))
          .status,
      ).toBe(201);

      // No faculty named on the seat (legacy): not gated.
      const { opp } = await liveOpp();
      const solo = await student();
      await seat(opp.id, solo, { facultyEmail: null, supervised: false });
      expect((await supervision(solo, opp.id)).required).toBe(false);
      expect(
        (await draft(solo, opp.id, { section2: fullSections().section2 }))
          .status,
      ).toBe(201);

      // Named faculty is the opportunity's own supervisor: already involved.
      const own = await liveOpp();
      const ownFaculty = 'own.supervisor@e2e.test';
      await h.opps.update(own.opp.id, {
        supervision: { contact: ownFaculty, supervisor_name: 'Dr Own' },
      } as never);
      const s2 = await student();
      await seat(own.opp.id, s2, {
        facultyEmail: ownFaculty.toUpperCase(),
        supervised: false,
      });
      expect((await supervision(s2, own.opp.id)).required).toBe(false);
      expect(
        (await draft(s2, own.opp.id, { section2: fullSections().section2 }))
          .status,
      ).toBe(201);
      expect(h.mail.of('sendReportSupervisionRequest')).toHaveLength(0);
    });

    it('confirming the team lead confirms the whole team; CIEL PK admin can confirm on the faculty’s behalf', async () => {
      const { opp } = await liveOpp();
      const fac = await h.makeUser(UserRole.FACULTY);
      const lead = await student();
      const mate = await student();
      const teamId = `TM-${uniq()}`;
      const leadSeat = await seat(opp.id, lead, {
        lead: true,
        teamId,
        facultyEmail: fac.email,
        supervised: false,
      });
      const mateSeat = await seat(opp.id, mate, {
        teamId,
        facultyEmail: fac.email,
        supervised: false,
      });
      const list = await h.as(fac).get('/faculty/report-supervision');
      const row = (
        list.body as {
          data: {
            pending: Array<{
              participation_id: string;
              team_members: Array<{ lead: boolean }>;
            }>;
          };
        }
      ).data.pending.find((p) => p.participation_id === leadSeat.id);
      expect(row?.team_members).toHaveLength(2);
      // Only the lead seat is listed, not each member.
      expect(
        (
          list.body as {
            data: { pending: Array<{ participation_id: string }> };
          }
        ).data.pending.map((p) => p.participation_id),
      ).not.toContain(mateSeat.id);

      const res = await h
        .as(admin)
        .post(`/faculty/report-supervision/${leadSeat.id}/confirm`);
      expect(res.status).toBe(201);
      expect(
        (res.body as { data: { confirmed_seats: number } }).data
          .confirmed_seats,
      ).toBe(2);
      const parts = h.ds.getRepository(Participation);
      for (const id of [leadSeat.id, mateSeat.id]) {
        const p = await parts.findOneByOrFail({ id });
        expect(p.facultySupervisionConfirmedAt).not.toBeNull();
        expect(p.facultySupervisionConfirmedBy).toBe(admin.id);
      }
      // Idempotent: confirming again changes nothing.
      const again = await h
        .as(fac)
        .post(`/faculty/report-supervision/${leadSeat.id}/confirm`);
      expect(again.status).toBe(201);
      expect(
        (await parts.findOneByOrFail({ id: leadSeat.id }))
          .facultySupervisionConfirmedBy,
      ).toBe(admin.id);
    });
  });
});
