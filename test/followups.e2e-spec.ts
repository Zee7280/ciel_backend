/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
// This e2e inspects loosely typed JSON bodies end to end; the shapes are asserted by the expectations.
process.env.MAIL_WEBHOOK_SECRET = 'e2e-mail-webhook-secret-123456';
process.env.CRON_SECRET = 'e2e-cron-secret-0123456789';
/**
 * Section 9.5 follow-up, end to end against the real app + Postgres:
 *   student plans a check (Yes) → CIEL PK publishes → follow-up scheduled with generated questions
 *   → nightly dispatch mails on the due date, reminders at +7 / +14, never twice
 *   → partner answers on the no-login page → student sees results after admin review
 *   → "No" plan creates nothing; sending a report back cancels a scheduled follow-up.
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
import { FollowUpsService } from '../src/followups/followups.service';
import { ReportFollowUp } from '../src/followups/entities/report-follow-up.entity';
import {
  addDaysIso,
  addMonthsIso,
  karachiToday,
} from '../src/followups/followup.util';

const day = (d: number) =>
  new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
/** Opportunity end date used by every report below; the wizard derives the due date from it. */
const END = day(20);
type Res<T> = Omit<request.Response, 'body'> & { body: T };
const typed = <T>(t: request.Test): Promise<Res<T>> =>
  t.then((r) => r as Res<T>);
type OppPatch = Partial<Opportunity>;
type ReportPatch = Parameters<Repository<StudentReport>['update']>[1];
type Rec = Record<string, any>;

const ETHICS = {
  authentic: true,
  informed_consent: true,
  no_harm: true,
  privacy_respected: true,
};
const COMPETENCY = Object.fromEntries(
  [
    'cognitive_systemic',
    'cognitive_critical',
    'cognitive_evaluate',
    'practical_design',
    'practical_evidence',
    'practical_engagement',
    'social_empathy',
    'social_diversity',
    'social_collaboration',
    'transformative_longterm',
    'transformative_benefits',
    'transformative_sustainability',
  ].map((k) => [k, 3]),
);

/** Clears every submit rule; `section10` carries the 9.5 answer under test. */
function fullSections(followup: Rec): Rec {
  return {
    section1: { privacy_consent: true, review_checked: [true, true, true] },
    section2: {
      problem_statement:
        'Grade 4–6 students had no working classroom lights or fans, so afternoon classes were cancelled in summer and attendance dropped across the whole primary block.',
      discipline: 'Engineering',
      discipline_contribution:
        'Electrical engineering coursework was used to audit the wiring load, identify unsafe junctions and specify LED fittings and fans within the school budget.',
      affected_group: 'Primary school children',
      affected_count: '120',
      system_gaps: ['Infrastructure'],
      baseline_evidence: ['Observation'],
    },
    section3: {
      contribution_intent_statement:
        'Students will restore safe classroom lighting and ventilation and hand the maintenance routine to school staff so that afternoon classes continue through summer and attendance recovers to its pre-summer level over the following term.',
    },
    section4: {
      activity_blocks: [
        {
          id: 'act1',
          title: 'Classroom LED retrofit',
          primary_category: 'Infrastructure',
          sub_category: 'Facility repair',
          status: 'Completed',
          description:
            'Audited wiring in six rooms, replaced unsafe junctions and installed LED fittings and fans with the partner electrician.',
          outputs: [{ title: 'Rooms rewired', quantity: '6' }],
        },
      ],
      project_summary: {
        distinct_total_beneficiaries: 120,
        counting_method: 'Headcount',
      },
    },
    section5: {
      observed_change:
        'Afternoon classes resumed in all six rooms within a week of the retrofit, and the head teacher reports that attendance in the primary block recovered to its pre-summer level by the end of the month according to the register, with no heat-related early closures recorded since the fans were installed.',
      challenges:
        'LED fittings arrived a week late, so the team rescheduled two sessions and worked while the rooms were empty to keep children away from the wiring.',
      measurable_outcomes: [
        {
          activity_id: 'act1',
          outcome_area: '10. Infrastructure / Facility Development',
          outcome_sub_category: 'Community Space Development',
          metric_category: '🔹 Percentage-Based (Advanced)',
          metric: 'Percentage Improvement (%)',
          metric_other: 'Attendance rate (%)',
          unit: '%',
          baseline: 70,
          endline: 90,
          confidence_level: ['Partner / official record'],
          measurement_explanation:
            'School attendance register for four weeks before versus four weeks after the retrofit, cross-checked with the head teacher.',
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
      reflection_biggest_learning: 'planning with the partner',
      reflection_moment: 'lights on',
      reflection_discipline_help: 'load calculations',
      personal_learning:
        'I learned to plan technical work around a school timetable and to document each step so staff could maintain the fittings afterwards.',
      academic_application:
        'Circuit analysis and load calculations from coursework were applied directly to the audit and to choosing fittings the school could afford.',
      competency_scores: COMPETENCY,
    },
    section10: {
      continuation_status: 'partially',
      continuation_details:
        'The LED fittings and fans stay with the school and are in daily use in all six rooms, so the physical improvement continues on its own. The weekly maintenance check depends on the caretaker keeping the routine we handed over, which the head teacher has agreed to supervise for the coming year. Replacement bulbs and fan servicing cost about four thousand rupees a year, which the school has not yet budgeted, so that part may stop without further support from the partner.',
      mechanisms: ['Partner-led continuation'],
      scaling_potential: 'Not scalable',
      policy_influence: 'No',
      ...followup,
    },
    section11: {
      final_declaration: [true, true, true, true, true],
      signature_name: 'Jane Student',
    },
  };
}

/** Tests share one database, so each report gets its own recipient and mails are filtered by it. */
const followupYes = (email: string) => ({
  followup_plan: 'yes',
  followup_owner_role: 'Partner / NGO representative',
  followup_owner_name: 'Ms. Nighat',
  followup_owner_email: email,
  followup_interval: '3',
  // The wizard stores the computed due date (end + interval); submit validation requires it.
  followup_due_date: addMonthsIso(END, 3),
  followup_check: 'Whether the reported benefits are still continuing',
  followup_check_notes:
    'Check that the fans and lights in all six rooms still work',
});

describe('Section 9.5 follow-up (real app + real Postgres)', () => {
  let h: Harness;
  let admin: E2eUser;
  let reports: Repository<StudentReport>;
  let followUps: Repository<ReportFollowUp>;
  let service: FollowUpsService;

  beforeAll(async () => {
    h = await bootHarness();
    admin = await h.makeUser(UserRole.SUPER_ADMIN);
    reports = h.ds.getRepository(StudentReport);
    followUps = h.ds.getRepository(ReportFollowUp);
    service = h.app.get(FollowUpsService);
  });
  afterAll(async () => {
    await h.app.close();
  });
  beforeEach(() => h.mail.reset());

  const student = () =>
    h.makeUser(UserRole.STUDENT, {
      overrides: {
        university: 'E2E University',
        cnic: null,
      } as unknown as Partial<User>,
    });

  const liveOpp = async () => {
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
        end_date: END,
        expected_hours: 6,
        volunteers_required: 8,
      },
      participation_scope: { rule: 'open_all_universities' },
    } as OppPatch);
    return { opp: await h.reload(created.id), org };
  };

  const seat = (projectId: string, u: E2eUser) => {
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
        participationMode: 'individual',
        isTeamLead: false,
        primaryFacultyEmail: 'faculty@e2e.test',
        facultySupervisionConfirmedAt: new Date(),
        attendanceApproverType: 'partner',
      } as DeepPartial<Participation>),
    );
  };

  const logHours = async (
    u: E2eUser,
    seatId: string,
    start: string,
    end: string,
    daysAgo: number,
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
  };

  type SubmitRes = { data: { report_id: string; status: string } };
  const submit = (u: E2eUser, oppId: string, body: Rec) =>
    typed<SubmitRes>(
      h
        .as(u)
        .post(`/student/reports/${oppId}/submit`)
        .send({ project_id: oppId, ...body }),
    );
  const adminVerify = (id: string, body: Rec) =>
    typed<{ data: { status: string } }>(
      h.as(admin).patch(`/admin/reports/${id}/verify`).send(body),
    );

  /** Seated student with hours, report submitted with the given 9.5 answer, CII locked, published. */
  const publishedReport = async (plan: 'yes' | Rec) => {
    const email = `nighat-${uniq()}@partner.test`;
    const followup = plan === 'yes' ? followupYes(email) : plan;
    const { opp } = await liveOpp();
    const lead = await student();
    const seatRow = await seat(opp.id, lead);
    await logHours(lead, seatRow.id, '09:00', '12:00', 3);
    await logHours(lead, seatRow.id, '09:00', '12:00', 2);
    const sub = await submit(lead, opp.id, fullSections(followup));
    if (sub.status !== 201) {
      console.log('SUBMIT REJECTED', JSON.stringify(sub.body));
    }
    expect(sub.status).toBe(201);
    const rid = sub.body.data.report_id;
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
    const pub = await adminVerify(rid, { action: 'approve' });
    expect(pub.status).toBe(200);
    expect(pub.body.data.status).toBe('verified');
    return { rid, lead, opp, email };
  };

  /** Follow-up mails captured for one recipient (other tests' follow-ups may be due the same day). */
  const mailsTo = (email: string) =>
    h.mail
      .of('sendFollowUpVerification')
      .filter((c) => (c.args[0] as Rec).to === email);

  /** The approve hook runs detached; wait for the follow-up row (or its absence) to settle. */
  const waitForFollowUp = async (rid: string, expectRow: boolean) => {
    for (let i = 0; i < 40; i += 1) {
      const row = await followUps.findOne({ where: { reportId: rid } });
      if (!!row === expectRow) return row;
      await new Promise((r) => setTimeout(r, 50));
    }
    return followUps.findOne({ where: { reportId: rid } });
  };

  const tokenFromMail = (call: { args: unknown[] }): string => {
    const input = call.args[0] as { reviewLink: string };
    const url = new URL(input.reviewLink);
    return url.searchParams.get('token') || '';
  };

  it('publishing a report with a planned check schedules the follow-up with generated questions; admin sees it', async () => {
    const { rid, lead, email } = await publishedReport('yes');
    const row = await waitForFollowUp(rid, true);
    expect(row).toBeTruthy();
    expect(row!.status).toBe('scheduled');
    expect(row!.recipientEmail).toBe(email);
    // 3 months after the opportunity end date, not after approval
    expect(row!.dueDate).toBe(addMonthsIso(END, 3));
    expect(row!.tokenHash).toHaveLength(64);
    expect(mailsTo(email)).toHaveLength(0);

    const adminView = await h.as(admin).get(`/admin/reports/${rid}/followup`);
    expect(adminView.status).toBe(200);
    const body = adminView.body as Rec;
    expect(body.followUp.status).toBe('scheduled');
    expect(body.followUp.tokenHash).toBeUndefined();
    expect(body.questions.map((q: Rec) => q.activityId)).toEqual([
      'act1',
      null,
    ]);
    expect(body.questions[0].questionText).toMatch(
      /still in use and in working condition/,
    );
    expect(body.questions[0].countLabel).toBe(
      'Rooms rewired still in use (of 6)',
    );
    expect(body.questions[1].questionText).toMatch(
      /fans and lights in all six rooms still work/,
    );
    expect(body.schedule.reminder1).toBe(addDaysIso(row!.dueDate, 7));
    expect(body.schedule.reminder2).toBe(addDaysIso(row!.dueDate, 14));
    expect(body.followUp.projectRef.host).toMatch(/^Host NGO /);

    // the student sees the plan, nothing sent yet; a stranger cannot
    const mine = await h.as(lead).get(`/students/reports/${rid}/followup`);
    expect(mine.status).toBe(200);
    expect((mine.body as Rec).followUp.status).toBe('scheduled');
    expect((mine.body as Rec).followUp.answers).toEqual([]);
    const other = await student();
    expect(
      (await h.as(other).get(`/students/reports/${rid}/followup`)).status,
    ).toBe(403);

    // a second approve is a no-op (same row, still one follow-up)
    await adminVerify(rid, { action: 'approve' });
    await new Promise((r) => setTimeout(r, 150));
    expect(await followUps.count({ where: { reportId: rid } })).toBe(1);
  });

  it('nightly dispatch mails on the due date, reminders at +7 and +14, never twice; the partner answers once', async () => {
    const { rid, lead, email } = await publishedReport('yes');
    const row = (await waitForFollowUp(rid, true))!;
    const due = row.dueDate;
    const at = (iso: string) => new Date(`${iso}T06:00:00+05:00`);

    // the day before: nothing
    let run = await service.dispatchDue(at(addDaysIso(due, -1)));
    expect(run.enabled).toBe(true);
    expect(mailsTo(email)).toHaveLength(0);

    // due date: initial email, once
    await service.dispatchDue(at(due));
    expect(mailsTo(email)).toHaveLength(1);
    run = await service.dispatchDue(at(due));
    expect(mailsTo(email)).toHaveLength(1);
    let mails = mailsTo(email);
    expect((mails[0].args[0] as Rec).kind).toBe('initial');
    expect((mails[0].args[0] as Rec).to).toBe(email);
    expect((mails[0].args[0] as Rec).questions).toHaveLength(2);
    expect((mails[0].args[0] as Rec).subject).toMatch(
      /^CIEL PK \| Impact follow-up \| /,
    );
    const initialToken = tokenFromMail(mails[0]);
    expect(initialToken.length).toBeGreaterThan(30);
    expect(
      (await followUps.findOneOrFail({ where: { id: row.id } })).status,
    ).toBe('sent');

    // +6: nothing; +7: reminder 1; +14: final reminder; +15: nothing
    await service.dispatchDue(at(addDaysIso(due, 6)));
    expect(mailsTo(email)).toHaveLength(1);
    await service.dispatchDue(at(addDaysIso(due, 7)));
    expect(mailsTo(email)).toHaveLength(2);
    await service.dispatchDue(at(addDaysIso(due, 14)));
    expect(mailsTo(email)).toHaveLength(3);
    await service.dispatchDue(at(addDaysIso(due, 15)));
    mails = mailsTo(email);
    expect(mails.map((m) => (m.args[0] as Rec).kind)).toEqual([
      'initial',
      'reminder1',
      'reminder2',
    ]);
    expect(
      await h.ds
        .getRepository('report_follow_up_dispatches')
        .count({ where: { followUpId: row.id, status: 'sent' } }),
    ).toBe(3);
    const latestToken = tokenFromMail(mails[2]);
    expect(latestToken).not.toBe(initialToken);

    // both the first and the latest email's links open the same follow-up (no login)
    const anon = h.as(null);
    const viaOld = await anon.get(`/public/followups/${initialToken}`);
    expect(viaOld.status).toBe(200);
    const viaNew = await anon.get(`/public/followups/${latestToken}`);
    expect(viaNew.status).toBe(200);
    const pub = viaNew.body as Rec;
    expect(pub.status).toBe('reminded');
    expect(pub.projectRef.title).toBeTruthy();
    expect(pub.questions).toHaveLength(2);
    expect(
      await anon.get('/public/followups/not-a-real-token-at-all-000000000'),
    ).toMatchObject({ status: 404 });

    // incomplete answers are refused; a complete, confirmed response is stored once
    const [q1, q2] = pub.questions as Rec[];
    const partial = await anon
      .post(`/public/followups/${latestToken}/response`)
      .send({
        representativeName: 'Ms. Nighat',
        consent: true,
        answers: [{ questionId: q1.id, choice: 'yes' }],
      });
    expect(partial.status).toBe(400);
    const noConsent = await anon
      .post(`/public/followups/${latestToken}/response`)
      .send({
        representativeName: 'Ms. Nighat',
        consent: false,
        answers: [
          { questionId: q1.id, choice: 'yes' },
          { questionId: q2.id, choice: 'partially' },
        ],
      });
    expect(noConsent.status).toBe(400);
    const ok = await anon
      .post(`/public/followups/${latestToken}/response`)
      .send({
        representativeName: 'Ms. Nighat',
        consent: true,
        generalComment: 'Two fans need new capacitors.',
        answers: [
          {
            questionId: q1.id,
            choice: 'yes',
            numericValue: 6,
            note: 'All rooms lit',
          },
          { questionId: q2.id, choice: 'partially', note: 'Two fans slow' },
        ],
      });
    expect(ok.status).toBe(201);
    const again = await anon
      .post(`/public/followups/${latestToken}/response`)
      .send({
        representativeName: 'Someone else',
        consent: true,
        answers: [{ questionId: q1.id, choice: 'no' }],
      });
    expect(again.status).toBe(409);
    expect(
      (await followUps.findOneOrFail({ where: { id: row.id } })).status,
    ).toBe('responded');
    // no more mail after a response
    await service.dispatchDue(at(addDaysIso(due, 30)));
    expect(mailsTo(email)).toHaveLength(3);

    // student: responded but answers hidden until CIEL PK reviews
    let mine = (await h.as(lead).get(`/students/reports/${rid}/followup`))
      .body as Rec;
    expect(mine.followUp.status).toBe('responded');
    expect(mine.followUp.answers).toEqual([]);
    const reviewed = await h
      .as(admin)
      .post(`/admin/reports/${rid}/followup/mark-reviewed`)
      .send({});
    expect(reviewed.status).toBe(201);
    expect((reviewed.body as Rec).answers).toHaveLength(2);
    mine = (await h.as(lead).get(`/students/reports/${rid}/followup`))
      .body as Rec;
    expect(mine.followUp.reviewedAt).toBeTruthy();
    expect(mine.followUp.answers.map((a: Rec) => a.choice).sort()).toEqual([
      'partially',
      'yes',
    ]);
    expect(mine.followUp.generalComment).toBe('Two fans need new capacitors.');
  });

  it('admin can edit the questions before the first email; the edited set is what gets mailed', async () => {
    const { rid, email } = await publishedReport('yes');
    const row = (await waitForFollowUp(rid, true))!;
    const view = (await h.as(admin).get(`/admin/reports/${rid}/followup`))
      .body as Rec;
    const [q1, q2] = view.questions as Rec[];
    const edited = await h
      .as(admin)
      .patch(`/admin/reports/${rid}/followup/questions`)
      .send({
        questions: [
          {
            id: q1.id,
            questionText:
              'Are all six rooms still lit and ventilated every afternoon?',
            activityTitle: q1.activityTitle,
            countLabel: 'Rooms in use',
            include: true,
          },
          { id: q2.id, questionText: q2.questionText, include: false },
          {
            questionText:
              'Has the caretaker kept the weekly maintenance check going?',
            activityTitle: 'Maintenance routine',
          },
        ],
      });
    expect(edited.status).toBe(200);
    const body = edited.body as Rec;
    expect(body.followUp.questionSetVersion).toBe(2);
    expect(body.followUp.questionsEditedAt).toBeTruthy();
    expect(body.questions.map((q: Rec) => [q.include, q.generatedBy])).toEqual([
      [true, 'rules'],
      [false, 'rules'],
      [true, 'admin'],
    ]);

    const sendNow = await h
      .as(admin)
      .post(`/admin/reports/${rid}/followup/send-now`)
      .send({});
    expect(sendNow.status).toBe(201);
    const mail = mailsTo(email);
    expect(mail).toHaveLength(1);
    expect(
      (mail[0].args[0] as Rec).questions.map((q: Rec) => q.questionText),
    ).toEqual([
      'Are all six rooms still lit and ventilated every afternoon?',
      'Has the caretaker kept the weekly maintenance check going?',
    ]);
    expect(
      (await followUps.findOneOrFail({ where: { id: row.id } })).status,
    ).toBe('sent');

    // the partner declines → no further mail
    const token = tokenFromMail(mail[0]);
    const declined = await h
      .as(null)
      .post(`/public/followups/${token}/decline`)
      .send({ reason: 'Left the organisation' });
    expect(declined.status).toBe(201);
    expect(
      (await followUps.findOneOrFail({ where: { id: row.id } })).status,
    ).toBe('declined');
    await service.dispatchDue(
      new Date(`${addDaysIso(row.dueDate, 7)}T06:00:00+05:00`),
    );
    expect(mailsTo(email)).toHaveLength(1);
    expect((await h.as(null).get(`/public/followups/${token}`)).status).toBe(
      200,
    );

    // "wrong representative": plain re-activate explains, a new contact reopens a fresh cycle
    const plain = await h
      .as(admin)
      .post(`/admin/reports/${rid}/followup/activate`)
      .send({});
    expect(plain.status).toBe(400);
    expect(String(plain.body.message)).toMatch(/declined by the contact/);
    const replacement = `director-${uniq()}@partner.test`;
    const reopened = await h
      .as(admin)
      .post(`/admin/reports/${rid}/followup/activate`)
      .send({
        recipientName: 'Village Director',
        recipientEmail: replacement,
        recipientRole: 'School / host representative',
      });
    expect(reopened.status).toBe(201);
    expect(reopened.body.followUp).toMatchObject({
      status: 'scheduled',
      cycle: 2,
      decidedByAdmin: true,
      declinedAt: null,
    });
    // the declined contact's link is dead; the new contact gets the initial email on the next run
    expect((await h.as(null).get(`/public/followups/${token}`)).status).toBe(
      404,
    );
    await service.dispatchDue(new Date());
    const toReplacement = mailsTo(replacement);
    expect(toReplacement).toHaveLength(1);
    expect((toReplacement[0].args[0] as Rec).kind).toBe('initial');
    expect(mailsTo(email)).toHaveLength(1);
  });

  it('"No" creates nothing; sending a published report back cancels a scheduled follow-up', async () => {
    const no = await publishedReport({
      followup_plan: 'no',
      followup_no_reason:
        'One-time service completed; no ongoing result to check',
    });
    expect(await waitForFollowUp(no.rid, false)).toBeNull();
    const noView = (await h.as(admin).get(`/admin/reports/${no.rid}/followup`))
      .body as Rec;
    expect(noView.followUp).toBeNull();
    expect(noView.plan).toBe('no');
    expect(noView.canActivate).toBe(false);

    const yes = await publishedReport('yes');
    const row = (await waitForFollowUp(yes.rid, true))!;
    expect(row.status).toBe('scheduled');
    const back = await adminVerify(yes.rid, {
      action: 'reject',
      reason: 'Add the register photo',
      force: true,
    });
    expect(back.status).toBe(200);
    for (let i = 0; i < 40; i += 1) {
      if (
        (await followUps.findOneOrFail({ where: { id: row.id } })).status ===
        'cancelled'
      )
        break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const cancelled = await followUps.findOneOrFail({ where: { id: row.id } });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelReason).toBe('report_reject');
    await service.dispatchDue(
      new Date(`${addDaysIso(row.dueDate, 1)}T06:00:00+05:00`),
    );
    expect(mailsTo(yes.email)).toHaveLength(0);
  });

  // ------------------------------------------------------------------ Phase 3: delivery + opt-out
  it('a provider bounce parks the follow-up, lists the address, and an admin re-targets it to a new contact', async () => {
    const { rid, email } = await publishedReport('yes');
    const row = (await waitForFollowUp(rid, true))!;
    const at = (iso: string) => new Date(`${iso}T06:00:00+05:00`);
    await service.dispatchDue(at(row.dueDate));
    expect(mailsTo(email)).toHaveLength(1);

    const anon = h.as(null);
    const payload = {
      events: [{ type: 'bounced', email, detail: '550 5.1.1 user unknown' }],
    };
    expect(
      (await anon.post('/mail/provider-webhook').send(payload)).status,
    ).toBe(401);
    expect(
      (
        await anon
          .post('/mail/provider-webhook')
          .set('Authorization', 'Bearer wrong-secret-000000')
          .send(payload)
      ).status,
    ).toBe(401);
    const ok = await anon
      .post('/mail/provider-webhook')
      .set('Authorization', `Bearer ${process.env.MAIL_WEBHOOK_SECRET}`)
      .send(payload);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ received: 1, matched: 1, bounced: 1 });

    const parked = await followUps.findOneOrFail({ where: { id: row.id } });
    expect(parked.status).toBe('needs_attention');
    expect(parked.lastError).toMatch(/bounced/);
    const view = (await h.as(admin).get(`/admin/reports/${rid}/followup`))
      .body as Rec;
    expect(view.dispatches[0].deliveryStatus).toBe('bounced');
    expect(view.dispatches[0].deliveryDetail).toBe('550 5.1.1 user unknown');

    // reminders stop; the bounced address can never be chosen again
    await service.dispatchDue(at(addDaysIso(row.dueDate, 7)));
    expect(mailsTo(email)).toHaveLength(1);
    const sameAgain = await h
      .as(admin)
      .post(`/admin/reports/${rid}/followup/activate`)
      .send({ recipientName: 'Same', recipientEmail: email });
    expect(sameAgain.status).toBe(400);

    // CIEL PK names a new contact: scheduled for today, mailed on the next run
    const newEmail = `director-${uniq()}@partner.test`;
    const retarget = await h
      .as(admin)
      .post(`/admin/reports/${rid}/followup/activate`)
      .send({
        recipientName: 'Village Director',
        recipientEmail: newEmail,
        recipientRole: 'School / host representative',
      });
    expect(retarget.status).toBe(201);
    expect(retarget.body.followUp.status).toBe('scheduled');
    expect(retarget.body.followUp.decidedByAdmin).toBe(true);
    expect(retarget.body.followUp.recipientEmail).toBe(newEmail);
    await service.dispatchDue(new Date());
    expect(mailsTo(newEmail)).toHaveLength(1);
    expect((mailsTo(newEmail)[0].args[0] as Rec).recipientName).toBe(
      'Village Director',
    );

    const audit = (
      await h.as(admin).get(`/admin/reports/${rid}/followup/audit`)
    ).body as Rec;
    expect(audit.logs.map((l: Rec) => l.action)).toEqual(
      expect.arrayContaining([
        'REPORT_FOLLOWUP_ACTIVATED',
        'REPORT_FOLLOWUP_EMAIL_SENT',
        'REPORT_FOLLOWUP_DELIVERY_FAILED',
      ]),
    );
  });

  it('a partner who opts out is never mailed by another report; the student-planned follow-up is parked for the admin', async () => {
    const shared = `shared-${uniq()}@partner.test`;
    const first = await publishedReport(followupYes(shared));
    const row = (await waitForFollowUp(first.rid, true))!;
    await service.dispatchDue(new Date(`${row.dueDate}T06:00:00+05:00`));
    const token = tokenFromMail(mailsTo(shared)[0]);
    const declined = await h
      .as(null)
      .post(`/public/followups/${token}/decline`)
      .send({ reason: 'Please stop', optOut: true });
    expect(declined.status).toBe(201);
    expect(declined.body.optedOut).toBe(true);

    const second = await publishedReport(followupYes(shared));
    const parked = (await waitForFollowUp(second.rid, true))!;
    expect(parked.status).toBe('needs_attention');
    expect(parked.lastError).toMatch(/opted out/);
    await service.dispatchDue(new Date(`${parked.dueDate}T06:00:00+05:00`));
    expect(mailsTo(shared)).toHaveLength(1);

    // the address is on the admin's do-not-email list; re-activating without a new contact is refused
    const list = (await h.as(admin).get('/admin/followups/opt-outs'))
      .body as Rec[];
    expect(list.map((o) => o.email)).toContain(shared);
    const stuck = await h
      .as(admin)
      .post(`/admin/reports/${second.rid}/followup/activate`)
      .send({});
    expect(stuck.status).toBe(400);
    expect(String(stuck.body.message)).toMatch(/opted out or bounced/);
    // the person confirmed they want follow-ups again: admin removes the entry and the follow-up schedules
    expect(
      (
        await h
          .as(admin)
          .del(`/admin/followups/opt-outs/${encodeURIComponent(shared)}`)
      ).status,
    ).toBe(200);
    const resumed = await h
      .as(admin)
      .post(`/admin/reports/${second.rid}/followup/activate`)
      .send({});
    expect(resumed.status).toBe(201);
    expect(resumed.body.followUp.status).toBe('scheduled');
    expect(
      (
        await h
          .as(admin)
          .del(`/admin/followups/opt-outs/${encodeURIComponent(shared)}`)
      ).status,
    ).toBe(404);
  });

  // ------------------------------------------------------------------ Phase 4: tracker + decisions
  it('"Not decided yet" reports wait in the tracker until CIEL PK names a contact; the tracker lists, counts and exports', async () => {
    const later = await publishedReport({
      followup_plan: 'later',
      followup_decision_owner: 'admin',
    });
    expect(await waitForFollowUp(later.rid, false)).toBeNull();

    const list = (
      await h.as(admin).get('/admin/followups?status=all&limit=100')
    ).body as Rec;
    expect(list.pendingDecisions.map((p: Rec) => p.reportId)).toContain(
      later.rid,
    );
    expect(list.stats.pendingDecisions).toBeGreaterThanOrEqual(1);
    expect(list.stats.byStatus).toBeDefined();
    expect(list.total).toBeGreaterThanOrEqual(1);
    expect(list.rows[0]).toMatchObject({
      reportId: expect.any(String),
      outcome: expect.objectContaining({ bucket: expect.any(String) }),
    });

    // without a recipient the activation explains what is needed; with one it starts
    const refused = await h
      .as(admin)
      .post(`/admin/reports/${later.rid}/followup/activate`)
      .send({});
    expect(refused.status).toBe(400);
    expect(String(refused.body.message)).toMatch(
      /left the decision to CIEL PK/,
    );
    const contact = `teacher-${uniq()}@school.test`;
    const started = await h
      .as(admin)
      .post(`/admin/reports/${later.rid}/followup/activate`)
      .send({
        recipientName: 'Head Teacher',
        recipientEmail: contact,
        recipientRole: 'School / host representative',
        dueDate: addDaysIso(karachiToday(), 10),
      });
    expect(started.status).toBe(201);
    expect(started.body.followUp).toMatchObject({
      status: 'scheduled',
      decidedByAdmin: true,
      dueDate: addDaysIso(karachiToday(), 10),
    });
    expect(started.body.questions.length).toBeGreaterThanOrEqual(1);
    expect(
      (
        (await h.as(admin).get('/admin/followups')).body as Rec
      ).pendingDecisions.map((p: Rec) => p.reportId),
    ).not.toContain(later.rid);

    // search + CSV carry the new row
    const found = (
      await h.as(admin).get(`/admin/followups?q=${encodeURIComponent(contact)}`)
    ).body as Rec;
    expect(found.rows).toHaveLength(1);
    expect(found.rows[0].recipientEmail).toBe(contact);
    expect(found.rows[0].outcome.bucket).toBe('no_response');
    const csv = await h
      .as(admin)
      .get(`/admin/followups/export.csv?q=${encodeURIComponent(contact)}`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    const lines = String(csv.text).trim().split(/\r?\n/);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^"Report ID","Project","Student"/);
    expect(lines[1]).toContain(`"${contact}"`);
    expect(lines[1]).toContain('"CIEL PK"');
    expect(lines[1]).toContain('"no_response"');
  });

  // ------------------------------------------------------------------ production wiring
  it('the Vercel-cron nightly endpoint runs the follow-up dispatch and reports it without failing the other jobs', async () => {
    const today = karachiToday();
    const email = `cron-${uniq()}@partner.test`;
    const { rid } = await publishedReport({
      ...followupYes(email),
      followup_interval: 'custom',
      followup_custom_date: today,
      followup_due_date: today,
    });
    const row = (await waitForFollowUp(rid, true))!;
    expect(row.dueDate).toBe(today);

    const anon = h.as(null);
    expect((await anon.get('/internal/jobs/nightly')).status).toBe(401);
    const run = await anon
      .get('/internal/jobs/nightly')
      .set('Authorization', `Bearer ${process.env.CRON_SECRET}`);
    expect(run.status).toBe(200);
    expect(run.body.success).toBe(true);
    expect(run.body.follow_ups_error).toBeNull();
    expect(run.body.follow_ups).toMatchObject({ enabled: true, today });
    expect(run.body.follow_ups.sent).toBeGreaterThanOrEqual(1);
    expect(mailsTo(email)).toHaveLength(1);
    expect(
      (await followUps.findOneOrFail({ where: { id: row.id } })).status,
    ).toBe('sent');

    // a second run the same night is a no-op for this follow-up
    await anon
      .get('/internal/jobs/nightly')
      .set('Authorization', `Bearer ${process.env.CRON_SECRET}`);
    expect(mailsTo(email)).toHaveLength(1);
  });
});
