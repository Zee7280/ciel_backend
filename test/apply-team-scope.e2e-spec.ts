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
import { StudentReport } from '../src/reports/entities/student-report.entity';

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

  describe('admin Teams & enrollments: preview, snapshot and undo', () => {
    const seat = async (opp: { id: string }, who: E2eUser, over: Record<string, any> = {}) => {
      const parts = h.ds.getRepository(Participation);
      return parts.save(
        parts.create({
          email: who.email,
          mobile: '+923005550000',
          cnic: 'enc',
          cnicHash: `hash-${who.email}`,
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
          projectId: opp.id,
          studentId: who.id,
          fullName: who.email.split('@')[0],
          participationMode: 'individual',
          isTeamLead: false,
          ...over,
        } as any) as unknown as Participation,
      );
    };
    const draft = async (opp: { id: string }, who: E2eUser, status = 'draft') => {
      const reports = h.ds.getRepository(StudentReport);
      return reports.save(
        reports.create({ studentId: who.id, opportunityId: opp.id, project_id: opp.id, status } as any) as unknown as StudentReport,
      );
    };
    const reportCount = (oppId: string, studentId: string) =>
      h.ds.getRepository(StudentReport).count({ where: { studentId, opportunityId: oppId } });
    const seatCount = (oppId: string) => h.ds.getRepository(Participation).count({ where: { projectId: oppId } });

    it('delete team: preview lists the impact, delete returns a snapshot, undo restores seats + report, second undo is refused', async () => {
      const opp = await liveOpp();
      const a = await student('E2E University');
      const b = await student('E2E University');
      const teamId = 'TM-2026-SNAP-TEAM';
      await seat(opp, a, { teamId, participationMode: 'team', isTeamLead: true });
      await seat(opp, b, { teamId, participationMode: 'team' });
      await draft(opp, b);

      const preview = await h.as(admin).get(`/admin/opportunities/${opp.id}/teams/${teamId}/delete-preview`);
      expect(preview.status).toBe(200);
      expect(preview.body.data.members).toHaveLength(2);
      expect(preview.body.data.reports).toHaveLength(1);
      expect(await seatCount(opp.id)).toBe(2);

      const del = await h.as(admin).del(`/admin/opportunities/${opp.id}/teams/${teamId}`);
      expect(del.status).toBe(200);
      const snapshotId = del.body.snapshot_id as string;
      expect(snapshotId).toBeTruthy();
      expect(await seatCount(opp.id)).toBe(0);
      expect(await reportCount(opp.id, b.id)).toBe(0);

      const list = await h.as(admin).get(`/admin/opportunities/${opp.id}/team-snapshots`);
      expect(list.status).toBe(200);
      expect(list.body.data[0]).toMatchObject({ id: snapshotId, kind: 'delete_team', summary: { participations: 2, reports: 1 } });
      expect(list.body.data[0].restored_at).toBeNull();

      const undo = await h.as(admin).post(`/admin/opportunities/${opp.id}/team-snapshots/${snapshotId}/restore`).send({});
      expect(undo.status).toBe(200);
      expect(await seatCount(opp.id)).toBe(2);
      expect(await reportCount(opp.id, b.id)).toBe(1);
      const lead = await h.ds.getRepository(Participation).findOne({ where: { projectId: opp.id, studentId: a.id } });
      expect(lead).toMatchObject({ teamId, isTeamLead: true });

      const again = await h.as(admin).post(`/admin/opportunities/${opp.id}/team-snapshots/${snapshotId}/restore`).send({});
      expect(again.status).toBe(400);
      expect(again.body.message).toMatch(/already undone/);
    });

    it('delete lead member promotes the next seat; undo hands the lead role back; undo is refused if the student re-enrolled', async () => {
      const opp = await liveOpp();
      const a = await student('E2E University');
      const b = await student('E2E University');
      const teamId = 'TM-2026-SNAP-LEAD';
      const lead = await seat(opp, a, { teamId, participationMode: 'team', isTeamLead: true });
      await seat(opp, b, { teamId, participationMode: 'team' });

      const prev = await h.as(admin).get(`/admin/opportunities/${opp.id}/teams/${teamId}/members/${lead.id}/delete-preview`);
      expect(prev.status).toBe(200);
      expect(prev.body.warnings.join(' ')).toMatch(/will become the team lead/);

      const del = await h.as(admin).del(`/admin/opportunities/${opp.id}/teams/${teamId}/members/${lead.id}`);
      expect(del.status).toBe(200);
      const promoted = await h.ds.getRepository(Participation).findOne({ where: { projectId: opp.id, studentId: b.id } });
      expect(promoted!.isTeamLead).toBe(true);

      const undo = await h.as(admin).post(`/admin/opportunities/${opp.id}/team-snapshots/${del.body.snapshot_id}/restore`).send({});
      expect(undo.status).toBe(200);
      const roles = await h.ds.getRepository(Participation).find({ where: { projectId: opp.id } });
      expect(roles.filter((r) => r.isTeamLead).map((r) => r.studentId)).toEqual([a.id]);

      // delete again, student re-enrols, then undo of the first deletion must not duplicate seats
      const del2 = await h.as(admin).del(`/admin/opportunities/${opp.id}/teams/${teamId}/members/${lead.id}`);
      await seat(opp, a, { cnicHash: 'hash-new-a' });
      const clash = await h.as(admin).post(`/admin/opportunities/${opp.id}/team-snapshots/${del2.body.snapshot_id}/restore`).send({});
      expect(clash.status).toBe(400);
      expect(clash.body.message).toMatch(/already has a new enrollment/);
      expect(await h.ds.getRepository(Participation).count({ where: { projectId: opp.id, studentId: a.id } })).toBe(1);
    });

    it('merge: preview flags blockers, merge removes the non-lead draft, undo puts teams, leads and the draft back', async () => {
      const opp = await liveOpp();
      const a = await student('E2E University');
      const b = await student('E2E University');
      const sa = await seat(opp, a);
      const sb = await seat(opp, b);
      await draft(opp, b);

      const ok = await h.as(admin).post(`/admin/opportunities/${opp.id}/teams/merge-preview`).send({ member_participation_ids: [sa.id, sb.id], lead_participation_id: sa.id });
      expect(ok.status).toBe(200);
      expect(ok.body.data.can_merge).toBe(true);
      expect(ok.body.data.draft_reports_to_remove).toBe(1);

      const merged = await h.as(admin).post(`/admin/opportunities/${opp.id}/teams/merge`).send({ member_participation_ids: [sa.id, sb.id], lead_participation_id: sa.id });
      expect(merged.status).toBe(201);
      expect(merged.body.snapshot_id).toBeTruthy();
      expect(await reportCount(opp.id, b.id)).toBe(0);
      const rows = await h.ds.getRepository(Participation).find({ where: { projectId: opp.id } });
      expect(new Set(rows.map((r) => r.teamId)).size).toBe(1);

      const undo = await h.as(admin).post(`/admin/opportunities/${opp.id}/team-snapshots/${merged.body.snapshot_id}/restore`).send({});
      expect(undo.status).toBe(200);
      const after = await h.ds.getRepository(Participation).find({ where: { projectId: opp.id } });
      expect(after.every((r) => !r.teamId && r.participationMode === 'individual' && !r.isTeamLead)).toBe(true);
      expect(await reportCount(opp.id, b.id)).toBe(1);
    });

    it('roster ops: move a seat into another team, make lead, split to individual, each undoable', async () => {
      const opp = await liveOpp();
      const [a, b, c, d] = await Promise.all([1, 2, 3, 4].map(() => student('E2E University')));
      const t1 = 'TM-2026-OPS-ONE';
      const t2 = 'TM-2026-OPS-TWO';
      const sa = await seat(opp, a, { teamId: t1, participationMode: 'team', isTeamLead: true, teamDisplayName: 'Team One' });
      const sb = await seat(opp, b, { teamId: t1, participationMode: 'team' });
      const sc = await seat(opp, c, { teamId: t2, participationMode: 'team', isTeamLead: true, teamDisplayName: 'Team Two' });
      await seat(opp, d);
      await draft(opp, b);
      const get = (id: string) => h.ds.getRepository(Participation).findOneOrFail({ where: { id } });
      const url = `/admin/opportunities/${opp.id}/team-ops`;

      // blockers
      expect((await h.as(admin).post(`${url}/preview`).send({ op: 'move', member_participation_id: sb.id, target_team_id: t1 })).body.blockers.join(' ')).toMatch(/already on that team/);
      expect((await h.as(admin).post(`${url}/preview`).send({ op: 'set_lead', member_participation_id: sa.id })).body.blockers.join(' ')).toMatch(/already the team lead/);
      expect((await h.as(admin).post(`${url}/preview`).send({ op: 'split', member_participation_id: sc.id })).body.data.can_apply).toBe(true);
      expect((await h.as(admin).post(`${url}/apply`).send({ op: 'move', member_participation_id: sb.id, target_team_id: 'no-such-team' })).status).toBe(400);

      // move b (with a draft) into team two
      const pv = await h.as(admin).post(`${url}/preview`).send({ op: 'move', member_participation_id: sb.id, target_team_id: t2 });
      expect(pv.body.data.can_apply).toBe(true);
      expect(pv.body.warnings.join(' ')).toMatch(/1 draft report/);
      const mv = await h.as(admin).post(`${url}/apply`).send({ op: 'move', member_participation_id: sb.id, target_team_id: t2 });
      expect(mv.status).toBe(200);
      expect(await get(sb.id)).toMatchObject({ teamId: t2, isTeamLead: false, participationMode: 'team' });
      expect(await reportCount(opp.id, b.id)).toBe(0);
      const undoMove = await h.as(admin).post(`/admin/opportunities/${opp.id}/team-snapshots/${mv.body.snapshot_id}/restore`).send({});
      expect(undoMove.status).toBe(200);
      expect(await get(sb.id)).toMatchObject({ teamId: t1 });
      expect(await reportCount(opp.id, b.id)).toBe(1);

      // make b lead of team one
      const lead = await h.as(admin).post(`${url}/apply`).send({ op: 'set_lead', member_participation_id: sb.id });
      expect(lead.status).toBe(200);
      expect((await get(sb.id)).isTeamLead).toBe(true);
      expect((await get(sa.id)).isTeamLead).toBe(false);

      // split the new lead: a is promoted, b becomes individual; undo restores both roles
      const split = await h.as(admin).post(`${url}/apply`).send({ op: 'split', member_participation_id: sb.id });
      expect(split.status).toBe(200);
      expect(await get(sb.id)).toMatchObject({ teamId: null, participationMode: 'individual', isTeamLead: false });
      expect((await get(sa.id)).isTeamLead).toBe(true);
      await h.as(admin).post(`/admin/opportunities/${opp.id}/team-snapshots/${split.body.snapshot_id}/restore`).send({});
      expect(await get(sb.id)).toMatchObject({ teamId: t1, isTeamLead: true });
      expect((await get(sa.id)).isTeamLead).toBe(false);
    });

    it('admin patch can still correct a seat but warns when the university is outside the listing scope', async () => {
      const opp = await liveOpp({ participation_scope: { rule: 'own_university_only', creator_university_name: BNU, university_names: [BNU] } });
      const a = await student('BNU');
      const teamId = 'TM-2026-PATCH-WARN';
      const sa = await seat(opp, a, { teamId, participationMode: 'team', isTeamLead: true, universityName: BNU });
      const base = `/admin/opportunities/${opp.id}/teams/${teamId}/members/${sa.id}`;
      const bad = await h.as(admin).patch(base).send({ university_name: 'LUMS' });
      expect(bad.status).toBe(200);
      expect(bad.body.warnings.join(' ')).toMatch(/is at LUMS, but this opportunity is open to/);
      const ok = await h.as(admin).patch(base).send({ university_name: 'BNU' });
      expect(ok.status).toBe(200);
      expect(ok.body.warnings).toBeUndefined();
    });

    it('merge preview blocks (and merge refuses) when a non-lead already submitted a report', async () => {
      const opp = await liveOpp();
      const a = await student('E2E University');
      const b = await student('E2E University');
      const sa = await seat(opp, a);
      const sb = await seat(opp, b);
      await draft(opp, b, 'submitted');
      const body = { member_participation_ids: [sa.id, sb.id], lead_participation_id: sa.id };
      const pv = await h.as(admin).post(`/admin/opportunities/${opp.id}/teams/merge-preview`).send(body);
      expect(pv.body.data.can_merge).toBe(false);
      expect(pv.body.blockers.join(' ')).toMatch(/submitted or verified report/);
      expect((await h.as(admin).post(`/admin/opportunities/${opp.id}/teams/merge`).send(body)).status).toBe(400);
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

    const sendOtp = (lead: E2eUser, email: string, projectId: string) =>
      h.as(lead).post('/student/verify-team-member/send').send({ email, projectId, blockIfOnRoster: true });

    it('OTP is refused for a teammate at another university or with no CIEL account', async () => {
      const opp = await scoped();
      const lead = await student('BNU');
      const lums = await student('LUMS');
      const wrongUni = await sendOtp(lead, lums.email, opp.id);
      expect(wrongUni.status).toBe(400);
      expect(wrongUni.body.message).toMatch(/is at LUMS, but this opportunity is open to .*BNU.* students only/);

      const stranger = await sendOtp(lead, `nobody.${Date.now()}@e2e.test`, opp.id);
      expect(stranger.status).toBe(400);
      expect(stranger.body.message).toMatch(/has no CIEL student account/);
      expect(await h.ds.getRepository(Otp).count({ where: { email: lums.email.toLowerCase() } })).toBe(0);
    });

    it('apply refuses an unregistered teammate even if an OTP row exists, and a declared out-of-scope university', async () => {
      const opp = await scoped();
      const lead = await student('BNU');
      const ghostEmail = `ghost.${Date.now()}@e2e.test`;
      await h.ds.getRepository(Otp).save(
        h.ds.getRepository(Otp).create({ email: ghostEmail, otp: '', expiresAt: new Date(), verifiedAt: new Date(), projectId: opp.id } as any),
      );
      const ghost = await h.as(lead).post(`/students/opportunities/${opp.id}/apply`).send(
        applyBody({ participation_type: 'team', team_members: [member({ email: ghostEmail, university: 'BNU' })] }),
      );
      expect(ghost.status).toBe(400);
      expect(ghost.body.message).toMatch(/has no CIEL student account/);

      const real = await student('BNU');
      await otpVerify(lead, real.email, opp.id);
      const declaredWrong = await h.as(lead).post(`/students/opportunities/${opp.id}/apply`).send(
        applyBody({ participation_type: 'team', team_members: [member({ email: real.email, university: 'LUMS' })] }),
      );
      expect(declaredWrong.status).toBe(400);
      expect(declaredWrong.body.message).toMatch(/is at LUMS, but this opportunity is open to/);
    });

    it('registered BNU teammate with the short spelling "BNU" is accepted end to end', async () => {
      const opp = await scoped();
      const lead = await student('BNU');
      const mate = await student('Beaconhouse National University (BNU)');
      await otpVerify(lead, mate.email, opp.id);
      const ok = await h.as(lead).post(`/students/opportunities/${opp.id}/apply`).send(
        applyBody({ participation_type: 'team', team_members: [member({ email: mate.email, university: 'BNU', cnic: '3520200000001' })] }),
      );
      expect(ok.status).toBe(201);
    });

    it('a listing that is "open to all" in its scope but still carries restricted_universities is enforced (legacy shape)', async () => {
      const opp = await liveOpp({ participation_scope: { rule: 'open_all_universities' }, restricted_universities: [BNU] });
      const lead = await student('BNU');
      const lums = await student('LUMS');
      expect((await sendOtp(lead, lums.email, opp.id)).status).toBe(400);
      const outsiderLead = await h.as(lums).post(`/students/opportunities/${opp.id}/apply`).send(applyBody());
      expect(outsiderLead.status).toBe(403);
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

    it('refuses a seat outside the scope or without a CIEL account, refuses an unverified email, then seats the verified BNU teammate', async () => {
      const opp = await liveOpp({ participation_scope: { rule: 'own_university_only', creator_university_name: BNU, university_names: [BNU] } });
      const { lead, teamId } = await leadWithSeat(opp);

      const outOfScope = await h.as(lead).post('/engagement/register').send(registerBody(opp.id, teamId, { universityName: 'LUMS' }));
      expect(outOfScope.status).toBe(400);
      expect(outOfScope.body.message).toMatch(/is at LUMS, but this opportunity is open to/);

      const ghost = await h.as(lead).post('/engagement/register').send(registerBody(opp.id, teamId));
      expect(ghost.status).toBe(400);
      expect(ghost.body.message).toMatch(/has no CIEL student account/);

      const lums = await student('LUMS');
      const lumsSeat = await h.as(lead).post('/engagement/register').send(registerBody(opp.id, teamId, { email: lums.email, universityName: BNU }));
      expect(lumsSeat.status).toBe(400);
      expect(lumsSeat.body.message).toMatch(/is at LUMS, but this opportunity is open to/);

      const mate = await student('BNU');
      const body = registerBody(opp.id, teamId, { email: mate.email });
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
