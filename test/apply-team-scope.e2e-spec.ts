/**
 * Apply (individual / team) and report teammate registration against the real Nest app + scratch
 * Postgres: university scope, teammate OTP, min team size, duplicate CNIC. Mail is captured.
 */
import { bootHarness, Harness, E2eUser, oppPayload } from './e2e/harness';
import { adminApprove } from './e2e/helpers';
import { randomUUID } from 'crypto';
import { UserRole } from '../src/users/enums/user-role.enum';
import { Otp } from '../src/students/entities/otp.entity';
import { Participation } from '../src/engagement/entities/participant.entity';

const BNU = 'Beaconhouse National University (BNU)';
const day = (d: number) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

describe('Apply + teammate registration: scope, OTP, roster integrity (real app + real Postgres)', () => {
  let h: Harness;
  let admin: E2eUser;

  beforeAll(async () => {
    h = await bootHarness();
    admin = await h.makeUser(UserRole.SUPER_ADMIN);
  });
  afterAll(async () => {
    await h.app.close();
  });
  beforeEach(() => h.mail.reset());

  const liveOpp = async (over: Record<string, any> = {}) => {
    const org = await h.makeOrg();
    const ngo = await h.makeUser(UserRole.NGO, { org });
    const res = await h.as(ngo).post('/opportunities').send(oppPayload());
    expect(res.status).toBe(201);
    await adminApprove(h, admin, res.body.id);
    await h.opps.update(res.body.id, {
      status: 'active',
      workflowStage: 'live',
      admin_approved: true,
      timeline: { type: 'fixed', start_date: day(-3), end_date: day(30), expected_hours: 20, volunteers_required: 6 },
      participation_scope: { rule: 'open_all_universities' },
      ...over,
    } as any);
    return h.reload(res.body.id);
  };

  const student = (university: string) =>
    h.makeUser(UserRole.STUDENT, { overrides: { university, cnic: null } as any });

  /** Same two calls the dialog / report make; returns nothing but leaves a verifiedAt row. */
  const otpVerify = async (caller: E2eUser, email: string, projectId: string) => {
    const send = await h.as(caller).post('/student/verify-team-member/send').send({ email, projectId, blockIfOnRoster: true });
    expect(send.status).toBe(201);
    const row = await h.ds.getRepository(Otp).findOne({ where: { email: email.toLowerCase() } });
    expect(row?.otp).toMatch(/^\d{6}$/);
    const confirm = await h.as(caller).post('/student/verify-team-member/confirm').send({ email, otp: row!.otp });
    expect(confirm.status).toBe(201);
    const after = await h.ds.getRepository(Otp).findOne({ where: { email: email.toLowerCase() } });
    expect(after?.verifiedAt).toBeTruthy();
    expect(after?.otp).toBe('');
  };

  const member = (over: Record<string, any> = {}) => ({
    name: 'Ayesha Member',
    cnic: '35202-1234567-1',
    mobile: '+923001112233',
    email: `member.${Math.random().toString(36).slice(2, 8)}@e2e.test`,
    university: 'E2E University',
    program: 'BS CS',
    role: 'Member',
    ...over,
  });

  const applyBody = (over: Record<string, any> = {}) => ({
    participation_type: 'individual',
    primary_faculty_email: 'faculty@e2e.test',
    attendance_approver_type: 'partner',
    contact_phone_e164: '+923009998877',
    ...over,
  });

  describe('open opportunity', () => {
    it('individual apply succeeds through the validated :id/apply route (unknown keys are ignored)', async () => {
      const opp = await liveOpp();
      const lead = await student('E2E University');
      const res = await h.as(lead).post(`/students/opportunities/${opp.id}/apply`).send(applyBody({ junk_key: 'x' }));
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
    });

    it('rejects a malformed body on the :id/apply route instead of swallowing it (DTO now applies)', async () => {
      const opp = await liveOpp();
      const lead = await student('E2E University');
      const res = await h.as(lead).post(`/students/opportunities/${opp.id}/apply`).send(applyBody({ primary_faculty_email: 'not-an-email' }));
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/primary_faculty_email/);
    });

    it('rejects a team with nobody besides the lead', async () => {
      const opp = await liveOpp();
      const lead = await student('E2E University');
      const res = await h.as(lead).post(`/students/opportunities/${opp.id}/apply`).send(applyBody({ participation_type: 'team', team_members: [] }));
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/at least one teammate/);
    });

    it('rejects a teammate whose email never confirmed the OTP', async () => {
      const opp = await liveOpp();
      const lead = await student('E2E University');
      const m = member();
      const res = await h.as(lead).post(`/students/opportunities/${opp.id}/apply`).send(applyBody({ participation_type: 'team', team_members: [m] }));
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(new RegExp(`${m.email} has not confirmed the email OTP`));
    });

    it('accepts the dialog payload (lead row + OTP-verified member) and rejects a shared CNIC', async () => {
      const opp = await liveOpp();
      const lead = await student('E2E University');
      const m = member();
      await otpVerify(lead, m.email, opp.id);

      const dup = await h.as(lead).post(`/students/opportunities/${opp.id}/apply`).send(
        applyBody({
          participation_type: 'team',
          team_id: `TM-2026-E2E-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
          team_members: [member({ name: 'Lead Self', email: lead.email, role: 'Lead', cnic: '3520212345671' }), m],
        }),
      );
      expect(dup.status).toBe(400);
      expect(dup.body.message).toMatch(/have the same CNIC/);

      const ok = await h.as(lead).post(`/students/opportunities/${opp.id}/apply`).send(
        applyBody({
          participation_type: 'team',
          team_id: `TM-2026-E2E-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
          team_members: [member({ name: 'Lead Self', email: lead.email, role: 'Lead', cnic: '35202-7654321-9' }), m],
        }),
      );
      expect(ok.status).toBe(201);
      expect(ok.body.success).toBe(true);
    });
  });

  describe('admin Teams & enrollments merge', () => {
    it('explains that a pending applicant (application id) is not enrolled instead of echoing raw ids', async () => {
      const opp = await liveOpp();
      const lead = await student('E2E University');
      const applied = await h.as(lead).post(`/students/opportunities/${opp.id}/apply`).send(applyBody());
      expect(applied.status).toBe(201);
      const appId = applied.body.data.application_id as string;

      const res = await h.as(admin).post(`/admin/opportunities/${opp.id}/teams/merge`).send({
        member_participation_ids: [appId, randomUUID()],
        lead_participation_id: appId,
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/applied but is not enrolled yet. Use "Approve & enroll" first/);
      expect(res.body.message).toMatch(/1 selected enrollment was not found/);
      expect(res.body.message).not.toContain(appId);
    });
  });

  describe('university-scoped opportunity (own university = BNU)', () => {
    const scoped = () =>
      liveOpp({ participation_scope: { rule: 'own_university_only', creator_university_name: BNU, university_names: [BNU] } });

    it('lead at another university is refused', async () => {
      const opp = await scoped();
      const lead = await student('LUMS');
      const res = await h.as(lead).post(`/students/opportunities/${opp.id}/apply`).send(applyBody());
      expect(res.status).toBe(403);
    });

    it('teammate declared outside the scope is refused even with OTP; the short spelling "BNU" passes for lead and member', async () => {
      const opp = await scoped();
      const lead = await student('BNU');
      const bad = member({ university: 'LUMS' });
      await otpVerify(lead, bad.email, opp.id);
      const refused = await h.as(lead).post(`/students/opportunities/${opp.id}/apply`).send(applyBody({ participation_type: 'team', team_members: [bad] }));
      expect(refused.status).toBe(400);
      expect(refused.body.message).toMatch(/Ayesha Member is at LUMS, but this opportunity is open to .*BNU.* students only/);

      const good = member({ university: 'BNU', cnic: '3520200000001' });
      await otpVerify(lead, good.email, opp.id);
      const ok = await h.as(lead).post(`/students/opportunities/${opp.id}/apply`).send(applyBody({ participation_type: 'team', team_members: [good] }));
      expect(ok.status).toBe(201);
    });
  });

  describe('report Section 1: lead registers a teammate seat (POST /engagement/register)', () => {
    const registerBody = (projectId: string, teamId: string, over: Record<string, any> = {}) => ({
      projectId,
      participationMode: 'team',
      isTeamLead: false,
      teamId,
      fullName: 'Ayesha Member',
      cnic: '3520211111111',
      mobile: '+923001112233',
      email: `seat.${Math.random().toString(36).slice(2, 8)}@e2e.test`,
      universityId: 'bnu',
      universityName: BNU,
      academicProgram: 'BS CS',
      yearOfStudy: '3rd Year',
      department: 'Computer Science',
      academicIntegrationType: 'Voluntary',
      ...over,
    });

    /** Columns the Participation table requires when a seat is inserted straight into the DB. */
    const seatColumns = (email: string, university: string) => ({
      email,
      mobile: '+923005550000',
      cnic: 'enc',
      cnicHash: `hash-${email}`,
      cnicLast4: '0000',
      universityId: 'uni',
      universityName: university,
      academicProgram: 'BS CS',
      yearOfStudy: '3rd Year',
      department: 'Computer Science',
      academicIntegrationType: 'Voluntary',
      emailVerified: true,
      mobileVerified: true,
      status: 'approved',
    });

    const leadWithSeat = async (opp: { id: string }) => {
      const lead = await student('BNU');
      const teamId = `TM-2026-E2E-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      const parts = h.ds.getRepository(Participation);
      await parts.save(
        parts.create({
          ...seatColumns(lead.email, BNU),
          projectId: opp.id,
          studentId: lead.id,
          fullName: 'Lead',
          participationMode: 'team',
          isTeamLead: true,
          teamId,
        } as any),
      );
      return { lead, teamId };
    };

    it('refuses a seat outside the university scope, refuses an unverified email, then seats the verified teammate', async () => {
      const opp = await liveOpp({ participation_scope: { rule: 'own_university_only', creator_university_name: BNU, university_names: [BNU] } });
      const { lead, teamId } = await leadWithSeat(opp);

      const outOfScope = await h.as(lead).post('/engagement/register').send(registerBody(opp.id, teamId, { universityName: 'LUMS' }));
      expect(outOfScope.status).toBe(400);
      expect(outOfScope.body.message).toMatch(/is at LUMS, but this opportunity is open to/);

      const body = registerBody(opp.id, teamId);
      const noOtp = await h.as(lead).post('/engagement/register').send(body);
      expect(noOtp.status).toBe(400);
      expect(noOtp.body.message).toMatch(/has not confirmed the email OTP/);

      await otpVerify(lead, body.email, opp.id);
      const seated = await h.as(lead).post('/engagement/register').send(body);
      expect(seated.status).toBe(201);
      const row = await h.ds.getRepository(Participation).findOne({ where: { projectId: opp.id, email: body.email } });
      expect(row).toBeTruthy();
      expect(row!.teamId).toBe(teamId);
      expect(row!.isTeamLead).toBe(false);

      // Editing the same (now existing) seat again does not demand a fresh OTP.
      const edit = await h.as(lead).post('/engagement/register').send({ ...body, academicProgram: 'BS SE' });
      expect(edit.status).toBe(201);
    });

    it('a student verifying their own seat on an open project needs no OTP and is not scope-blocked', async () => {
      const opp = await liveOpp();
      const me = await student('E2E University');
      const parts = h.ds.getRepository(Participation);
      await parts.save(
        parts.create({ ...seatColumns(me.email, 'E2E University'), projectId: opp.id, studentId: me.id, fullName: 'Me', participationMode: 'individual', isTeamLead: false } as any),
      );
      const res = await h.as(me).post('/engagement/register').send({
        ...registerBody(opp.id, '', { email: me.email, universityName: 'E2E University', participationMode: 'individual' }),
        teamId: undefined,
      });
      expect(res.status).toBe(201);
    });
  });
});
