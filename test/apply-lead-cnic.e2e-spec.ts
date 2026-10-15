/**
 * The CNIC a team lead types in the apply dialog (row 1) must survive to the approved seat and the
 * report's Identity card. Real Nest app + scratch Postgres.
 */
import { bootHarness, Harness, E2eUser, oppPayload } from './e2e/harness';
import { adminApprove } from './e2e/helpers';
import { UserRole } from '../src/users/enums/user-role.enum';
import { Otp } from '../src/students/entities/otp.entity';
import { Participation } from '../src/engagement/entities/participant.entity';
import { OpportunityApplication } from '../src/opportunities/entities/opportunity-application.entity';

const day = (d: number) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

describe("Team lead's apply-time CNIC reaches the approved seat and report identity (real app + real Postgres)", () => {
  let h: Harness;
  let admin: E2eUser;
  beforeAll(async () => {
    h = await bootHarness();
    admin = await h.makeUser(UserRole.SUPER_ADMIN);
  });
  afterAll(async () => {
    await h.app.close();
  });

  const liveOpp = async () => {
    const org = await h.makeOrg();
    const ngo = await h.makeUser(UserRole.NGO, { org });
    const res = await h.as(ngo).post('/opportunities').send(oppPayload());
    await adminApprove(h, admin, res.body.id);
    await h.opps.update(res.body.id, {
      status: 'active',
      workflowStage: 'live',
      admin_approved: true,
      timeline: { type: 'fixed', start_date: day(-3), end_date: day(30), expected_hours: 20, volunteers_required: 6 },
      participation_scope: { rule: 'open_all_universities' },
    } as any);
    return h.reload(res.body.id);
  };
  const student = () => h.makeUser(UserRole.STUDENT, { overrides: { university: 'E2E University', cnic: null } as any });
  const otpVerify = async (caller: E2eUser, email: string, projectId: string) => {
    await h.as(caller).post('/student/verify-team-member/send').send({ email, projectId, blockIfOnRoster: true }).expect(201);
    const row = await h.ds.getRepository(Otp).findOne({ where: { email: email.toLowerCase() } });
    await h.as(caller).post('/student/verify-team-member/confirm').send({ email, otp: row!.otp }).expect(201);
  };
  const row = (over: Record<string, any>) => ({
    name: 'Person',
    cnic: '35202-1234567-1',
    mobile: '+923001112233',
    email: 'x@e2e.test',
    university: 'E2E University',
    program: 'BS CS',
    role: 'Member',
    ...over,
  });

  it('lead CNIC typed at apply is saved to the profile, lands on the approved lead seat, and shows on /engagement/my', async () => {
    const opp = await liveOpp();
    const lead = await student();
    const mate = await student();
    await otpVerify(lead, mate.email, opp.id);

    const applied = await h.as(lead).post(`/students/opportunities/${opp.id}/apply`).send({
      participation_type: 'team',
      team_id: 'TM-CNIC-1',
      primary_faculty_email: 'faculty@e2e.test',
      attendance_approver_type: 'partner',
      contact_phone_e164: '+923009998877',
      team_members: [
        row({ name: 'Lead Self', email: lead.email, role: 'Lead', cnic: '35202-7654321-9' }),
        row({ name: 'Mate', email: mate.email, cnic: '35202-1111111-1' }),
      ],
    });
    expect(applied.status).toBe(201);

    // profile now carries the lead CNIC
    const profile = await h.users.findOneOrFail({ where: { id: lead.id } });
    expect(String(profile.cnic).replace(/\D/g, '')).toBe('3520276543219');

    await h.ds.getRepository(OpportunityApplication).update(applied.body.data.application_id, { internalStatus: 'pending_admin' } as any);
    await h.as(admin).post(`/admin/applications/${applied.body.data.application_id}/approve`).send({}).expect(201);

    const seat = await h.ds.getRepository(Participation).findOneOrFail({ where: { projectId: opp.id, studentId: lead.id } });
    expect(seat.isTeamLead).toBe(true);
    expect(seat.cnicLast4).toBe('3219');

    const my = (await h.as(lead).get('/engagement/my')).body.data as any[];
    const mine = my.find((r) => r.projectId === opp.id);
    expect(String(mine.cnic).replace(/\D/g, '')).toBe('3520276543219'); // what the report identity card reads
  });

  it('does not overwrite a CNIC already on the profile', async () => {
    const opp = await liveOpp();
    const lead = await h.makeUser(UserRole.STUDENT, { overrides: { university: 'E2E University', cnic: '3520299999999' } as any });
    const mate = await student();
    await otpVerify(lead, mate.email, opp.id);
    await h.as(lead).post(`/students/opportunities/${opp.id}/apply`).send({
      participation_type: 'team',
      team_id: 'TM-CNIC-2',
      primary_faculty_email: 'faculty@e2e.test',
      attendance_approver_type: 'partner',
      contact_phone_e164: '+923009998877',
      team_members: [
        row({ name: 'Lead Self', email: lead.email, role: 'Lead', cnic: '35202-7654321-9' }),
        row({ name: 'Mate', email: mate.email, cnic: '35202-1111111-1' }),
      ],
    }).expect(201);
    expect((await h.users.findOneOrFail({ where: { id: lead.id } })).cnic).toBe('3520299999999');
  });
});
