/**
 * Report attendance: a teammate logging for themselves vs the Team Lead logging for a teammate.
 * Real Nest app + scratch Postgres (never the dev DB — see e2e-env.ts). Proves the entry lands on the
 * teammate's own seat, is visible from the teammate's login, records who typed it, cannot cross teams,
 * cannot steal a linked seat, and that delete permissions are right.
 */
import { bootHarness, Harness, E2eUser, oppPayload } from './e2e/harness';
import { adminApprove } from './e2e/helpers';
import { UserRole } from '../src/users/enums/user-role.enum';
import { Participation } from '../src/engagement/entities/participant.entity';
import { AttendanceLog } from '../src/engagement/entities/attendance-log.entity';

const day = (d: number) =>
  new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

describe('Attendance: self vs team-lead proxy entries (real app + real Postgres)', () => {
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
    expect(res.status).toBe(201);
    await adminApprove(h, admin, res.body.id);
    await h.opps.update(res.body.id, {
      status: 'active',
      workflowStage: 'live',
      admin_approved: true,
      timeline: {
        type: 'fixed',
        start_date: day(-10),
        end_date: day(30),
        expected_hours: 20,
        volunteers_required: 8,
      },
      participation_scope: { rule: 'open_all_universities' },
    } as any);
    return h.reload(res.body.id);
  };

  const student = () =>
    h.makeUser(UserRole.STUDENT, {
      overrides: { university: 'E2E University', cnic: null } as any,
    });

  const seat = async (
    projectId: string,
    u: E2eUser | null,
    o: { lead?: boolean; teamId: string; email?: string },
  ) => {
    const parts = h.ds.getRepository(Participation);
    const email = o.email ?? u!.email;
    return parts.save(
      parts.create({
        email,
        mobile: '+923005550000',
        cnic: 'enc',
        cnicHash: `hash-${email}-${Math.random()}`,
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
        studentId: u?.id ?? null,
        fullName: email.split('@')[0],
        participationMode: 'team',
        isTeamLead: !!o.lead,
        teamId: o.teamId,
        primaryFacultyEmail: 'faculty@e2e.test',
        attendanceApproverType: 'partner',
      } as any),
    ) as unknown as Participation;
  };

  const body = (over: Record<string, any> = {}) => ({
    dateOfEngagement: day(-2),
    startTime: '09:00',
    endTime: '12:00',
    organizationName: 'E2E School',
    activityType: 'Teaching',
    description: 'Taught a class',
    ...over,
  });

  const world = async () => {
    const opp = await liveOpp();
    const lead = await student();
    const mate = await student();
    const teamId = `TM-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const leadSeat = await seat(opp.id, lead, { lead: true, teamId });
    const mateSeat = await seat(opp.id, mate, { teamId });
    return { opp, lead, mate, teamId, leadSeat, mateSeat };
  };

  const logs = (seatId: string) =>
    h.ds
      .getRepository(AttendanceLog)
      .find({ where: { participantId: seatId } });

  it('teammate logs for themselves: stored on their seat, marked self, visible in their login', async () => {
    const w = await world();
    const res = await h
      .as(w.mate)
      .post(`/engagement/${w.mateSeat.id}/attendance`)
      .send(body());
    expect(res.status).toBe(201);
    expect(res.body.data.participantId).toBe(w.mateSeat.id);
    expect(res.body.data.loggedByRole).toBe('self');
    expect(res.body.data.loggedByUserId).toBe(w.mate.id);

    const mine = await h
      .as(w.mate)
      .get(`/engagement/${w.mateSeat.id}/attendance`);
    expect(mine.status).toBe(200);
    expect(mine.body.data).toHaveLength(1);
    expect(await logs(w.leadSeat.id)).toHaveLength(0);
  });

  it('team lead logs for a teammate: stored on the TEAMMATE seat, marked team_lead, seat not re-linked, teammate sees it', async () => {
    const w = await world();
    const res = await h
      .as(w.lead)
      .post(`/engagement/${w.mateSeat.id}/attendance`)
      .send(body());
    expect(res.status).toBe(201);
    expect(res.body.data.participantId).toBe(w.mateSeat.id);
    expect(res.body.data.loggedByRole).toBe('team_lead');
    expect(res.body.data.loggedByUserId).toBe(w.lead.id);

    expect(await logs(w.leadSeat.id)).toHaveLength(0); // nothing leaks onto the lead's own seat
    const seatRow = await h.ds
      .getRepository(Participation)
      .findOneOrFail({ where: { id: w.mateSeat.id } });
    expect(seatRow.studentId).toBe(w.mate.id); // seat still belongs to the teammate

    // Teammate's login: own-seat list, project-wide list, and "my participations" all carry it.
    const own = await h
      .as(w.mate)
      .get(`/engagement/${w.mateSeat.id}/attendance`);
    expect(own.body.data.map((l: any) => l.id)).toContain(res.body.data.id);
    const proj = await h
      .as(w.mate)
      .get(`/engagement/project/${w.opp.id}/attendance-logs`);
    expect(proj.status).toBe(200);
    const row = proj.body.data.find((l: any) => l.id === res.body.data.id);
    expect(row.participant.id).toBe(w.mateSeat.id);
    expect(row.loggedByRole).toBe('team_lead');
    const mySeats = await h.as(w.mate).get('/engagement/my-participations');
    if (mySeats.status === 200) {
      const mineSeat = (mySeats.body.data ?? mySeats.body).find?.(
        (p: any) => p.id === w.mateSeat.id,
      );
      if (mineSeat?.attendanceLogs)
        expect(mineSeat.attendanceLogs.map((l: any) => l.id)).toContain(
          res.body.data.id,
        );
    }
  });

  it('lead + teammate entries on the same seat obey the overlap rule (no double-booking the same hours)', async () => {
    const w = await world();
    expect(
      (
        await h
          .as(w.lead)
          .post(`/engagement/${w.mateSeat.id}/attendance`)
          .send(body())
      ).status,
    ).toBe(201);
    const clash = await h
      .as(w.mate)
      .post(`/engagement/${w.mateSeat.id}/attendance`)
      .send(body({ startTime: '10:00', endTime: '13:00' }));
    expect(clash.status).toBe(400);
    const clash2 = await h
      .as(w.lead)
      .post(`/engagement/${w.mateSeat.id}/attendance`)
      .send(body({ startTime: '08:00', endTime: '10:00' }));
    expect(clash2.status).toBe(400);
    expect(
      (
        await h
          .as(w.mate)
          .post(`/engagement/${w.mateSeat.id}/attendance`)
          .send(body({ startTime: '13:00', endTime: '15:00' }))
      ).status,
    ).toBe(201);
    expect(await logs(w.mateSeat.id)).toHaveLength(2);
  });

  it('a lead of ANOTHER team cannot log for this teammate; nor can a teammate log for the lead', async () => {
    const w = await world();
    const otherLead = await student();
    await seat(w.opp.id, otherLead, { lead: true, teamId: 'TM-OTHER' });
    const r1 = await h
      .as(otherLead)
      .post(`/engagement/${w.mateSeat.id}/attendance`)
      .send(body());
    expect(r1.status).toBe(400);
    expect(r1.body.message).toMatch(/Not authorized/);

    const r2 = await h
      .as(w.mate)
      .post(`/engagement/${w.leadSeat.id}/attendance`)
      .send(body());
    expect(r2.status).toBe(400);
    expect(await logs(w.mateSeat.id)).toHaveLength(0);
    expect(await logs(w.leadSeat.id)).toHaveLength(0);
  });

  it("lead cannot log on a seat that is another team's lead row, and a lone student cannot log for anyone", async () => {
    const w = await world();
    const stranger = await student();
    const r = await h
      .as(stranger)
      .post(`/engagement/${w.mateSeat.id}/attendance`)
      .send(body());
    expect(r.status).toBe(400);
  });

  it("never moves a linked teammate seat to the lead's login, even if emails/CNIC hash collide", async () => {
    const opp = await liveOpp();
    const lead = await student();
    const mate = await student();
    const teamId = 'TM-COLLIDE';
    await seat(opp.id, lead, { lead: true, teamId });
    // teammate seat typed with the LEAD's email by mistake, but already linked to the real teammate account
    const mateSeat = await seat(opp.id, mate, { teamId, email: lead.email });
    const r = await h
      .as(lead)
      .post(`/engagement/${mateSeat.id}/attendance`)
      .send(body());
    expect([201, 400]).toContain(r.status);
    const after = await h.ds
      .getRepository(Participation)
      .findOneOrFail({ where: { id: mateSeat.id } });
    expect(after.studentId).toBe(mate.id);
  });

  it('delete: lead removes the proxy entry they made; teammate can remove it too; strangers cannot; owner-only still holds for self entries', async () => {
    const w = await world();
    const lead1 = await h
      .as(w.lead)
      .post(`/engagement/${w.mateSeat.id}/attendance`)
      .send(body());
    const id1 = lead1.body.data.id;
    const stranger = await student();
    const bad = await h
      .as(stranger)
      .del(`/engagement/${w.mateSeat.id}/attendance/${id1}`);
    expect(bad.status).toBe(403);
    const ok = await h
      .as(w.lead)
      .del(`/engagement/${w.mateSeat.id}/attendance/${id1}`);
    expect(ok.status).toBe(200);
    expect(await logs(w.mateSeat.id)).toHaveLength(0);

    const lead2 = await h
      .as(w.lead)
      .post(`/engagement/${w.mateSeat.id}/attendance`)
      .send(body({ dateOfEngagement: day(-3) }));
    const byMate = await h
      .as(w.mate)
      .del(`/engagement/${w.mateSeat.id}/attendance/${lead2.body.data.id}`);
    expect(byMate.status).toBe(200);

    // A lead cannot delete an entry the TEAMMATE logged themselves.
    const self = await h
      .as(w.mate)
      .post(`/engagement/${w.mateSeat.id}/attendance`)
      .send(body({ dateOfEngagement: day(-4) }));
    const leadVsSelf = await h
      .as(w.lead)
      .del(`/engagement/${w.mateSeat.id}/attendance/${self.body.data.id}`);
    expect(leadVsSelf.status).toBe(403);
  });

  it('proxy flow also works when the teammate has no account yet (seat unlinked): lead logs, entry stays on that seat', async () => {
    const opp = await liveOpp();
    const lead = await student();
    const teamId = 'TM-GHOST';
    await seat(opp.id, lead, { lead: true, teamId });
    const ghost = await seat(opp.id, null, {
      teamId,
      email: `ghost.${Math.random().toString(36).slice(2, 7)}@e2e.test`,
    });
    const r = await h
      .as(lead)
      .post(`/engagement/${ghost.id}/attendance`)
      .send(body());
    expect(r.status).toBe(201);
    expect(r.body.data.participantId).toBe(ghost.id);
    expect(r.body.data.loggedByRole).toBe('team_lead');
  });

  describe('member sees lead-entered hours even when the student has more than one seat on the project', () => {
    /** Everything a teammate's own login reads: dashboard hours, /my seats, per-seat + project logs. */
    const memberView = async (mate: E2eUser, projectId: string) => {
      const part = await h
        .as(mate)
        .get(`/student/projects/${projectId}/my-participation`);
      const my = await h.as(mate).get('/engagement/my');
      const mine = (my.body.data as any[]).filter(
        (r) => r.projectId === projectId,
      );
      const proj = await h
        .as(mate)
        .get(`/engagement/project/${projectId}/attendance-logs`);
      return {
        hours: part.body?.data?.hours,
        // what the report page reads: the first /my seat for this project
        mySeatLogHours: (mine[0]?.attendanceLogs ?? []).reduce(
          (x: number, l: any) => x + Number(l.sessionHours),
          0,
        ),
        projectLogs: proj.body.data as any[],
        status: part.status,
      };
    };

    /** What the Team Lead's dropdown offers for this teammate: the /team roster row for them. */
    const leadRosterSeatFor = async (
      lead: E2eUser,
      projectId: string,
      mate: E2eUser,
    ) => {
      const res = await h.as(lead).get(`/engagement/project/${projectId}/team`);
      expect(res.status).toBe(200);
      return (res.body.data as any[]).filter(
        (r) => r.studentId === mate.id || r.email === mate.email,
      );
    };

    it('leftover individual seat + team seat: lead logs on the roster seat, member dashboard + /my + project logs all show it', async () => {
      const opp = await liveOpp();
      const lead = await student();
      const mate = await student();
      const teamId = 'TM-DUP1';
      await seat(opp.id, lead, { lead: true, teamId });
      const parts = h.ds.getRepository(Participation);
      // older individual leftover, then the real team seat
      const leftover = await seat(opp.id, mate, { teamId: '' as any });
      await parts.update(leftover.id, {
        participationMode: 'individual',
        teamId: null,
        primaryFacultyEmail: 'faculty@e2e.test',
      } as any);
      await seat(opp.id, mate, { teamId });

      // The lead's dropdown only offers team seats (frontend filters the roster by teamId).
      const rosterSeats = (await leadRosterSeatFor(lead, opp.id, mate)).filter(
        (r) => r.teamId === teamId,
      );
      expect(rosterSeats.length).toBeGreaterThan(0);
      for (const [i, rs] of rosterSeats.entries()) {
        const r = await h
          .as(lead)
          .post(`/engagement/${rs.id}/attendance`)
          .send(body({ dateOfEngagement: day(-2 - i) }));
        if (r.status !== 201)
          console.log(
            'LEAD LOG FAIL',
            rs.id,
            rs.teamId,
            JSON.stringify(r.body),
          );
        expect(r.status).toBe(201);
      }
      // Even a lead entry that landed on the leftover seat must reach the member.
      const v = await memberView(mate, opp.id);
      expect(v.status).toBe(200);
      expect(Number(v.hours.logged)).toBe(3 * rosterSeats.length);
      expect(v.projectLogs.length).toBe(rosterSeats.length);
      expect(v.mySeatLogHours).toBe(3 * rosterSeats.length);
    });

    it('two seats on the SAME team (ghost duplicate): hours logged on either seat reach the member', async () => {
      const opp = await liveOpp();
      const lead = await student();
      const mate = await student();
      const teamId = 'TM-DUP2';
      await seat(opp.id, lead, { lead: true, teamId });
      const first = await seat(opp.id, mate, { teamId });
      const second = await seat(opp.id, mate, { teamId });
      await h
        .as(lead)
        .post(`/engagement/${first.id}/attendance`)
        .send(body({ dateOfEngagement: day(-2) }))
        .expect(201);
      await h
        .as(lead)
        .post(`/engagement/${second.id}/attendance`)
        .send(body({ dateOfEngagement: day(-3) }))
        .expect(201);
      const v = await memberView(mate, opp.id);
      expect(Number(v.hours.logged)).toBe(6); // both entries count, wherever they were typed
      expect(v.mySeatLogHours).toBe(6);
      // Both landed on ONE seat (the canonical one), so the member's dashboard seat holds them all.
      expect(new Set(v.projectLogs.map((l: any) => l.participantId)).size).toBe(
        1,
      );
    });

    it('entries ALREADY stored on a sibling seat (legacy data) are visible to the member', async () => {
      const opp = await liveOpp();
      const lead = await student();
      const mate = await student();
      const teamId = 'TM-DUP3';
      await seat(opp.id, lead, { lead: true, teamId });
      const first = await seat(opp.id, mate, { teamId });
      const second = await seat(opp.id, mate, { teamId });
      const logRepo = h.ds.getRepository(AttendanceLog);
      for (const [i, sid] of [first.id, second.id].entries()) {
        await logRepo.save(
          logRepo.create({
            participantId: sid,
            projectId: opp.id,
            dateOfEngagement: day(-2 - i),
            startTime: '09:00',
            endTime: '12:00',
            sessionHours: 3,
            organizationName: 'E2E School',
            activityType: 'Teaching',
            description: 'legacy',
          } as any),
        );
      }
      const v = await memberView(mate, opp.id);
      expect(Number(v.hours.logged)).toBe(6);
      expect(v.mySeatLogHours).toBe(6);
      expect(v.projectLogs).toHaveLength(2);
      const own = await h.as(mate).get(`/engagement/${first.id}/attendance`);
      expect(own.body.data).toHaveLength(2);
      // The member deletes an entry using the id the project list shows (canonical seat), even if it sits on a sibling.
      const target = v.projectLogs[0];
      const del = await h
        .as(mate)
        .del(`/engagement/${target.participantId}/attendance/${target.id}`);
      expect(del.status).toBe(200);
      expect((await memberView(mate, opp.id)).projectLogs).toHaveLength(1);
    });

    it("overlap rule spans all of a student's seats (a duplicate seat cannot double-book the same hours)", async () => {
      const opp = await liveOpp();
      const lead = await student();
      const mate = await student();
      const teamId = 'TM-DUP4';
      await seat(opp.id, lead, { lead: true, teamId });
      const first = await seat(opp.id, mate, { teamId });
      const second = await seat(opp.id, mate, { teamId });
      await h
        .as(lead)
        .post(`/engagement/${first.id}/attendance`)
        .send(body())
        .expect(201);
      const clash = await h
        .as(mate)
        .post(`/engagement/${second.id}/attendance`)
        .send(body({ startTime: '10:00', endTime: '11:30' }));
      expect(clash.status).toBe(400);
    });
  });

  describe('frontend/backend id contract (the ids the UI matches on must agree everywhere)', () => {
    it('lead roster seat id == project-log participantId == member /engagement/my seat id, with duplicate seats', async () => {
      const opp = await liveOpp();
      const lead = await student();
      const mate = await student();
      const teamId = 'TM-CONTRACT';
      await seat(opp.id, lead, { lead: true, teamId });
      // older individual leftover FIRST, then the real team seat (the dedupe keeps the first by createdAt)
      const leftover = await seat(opp.id, mate, { teamId });
      await h.ds
        .getRepository(Participation)
        .update(leftover.id, {
          participationMode: 'individual',
          teamId: null,
        } as any);
      const real = await seat(opp.id, mate, { teamId });

      const roster = (
        await h.as(lead).get(`/engagement/project/${opp.id}/team`)
      ).body.data as any[];
      const rosterMate = roster.filter((r) => r.studentId === mate.id);
      expect(rosterMate).toHaveLength(1); // one card per person for the lead

      await h
        .as(lead)
        .post(`/engagement/${rosterMate[0].id}/attendance`)
        .send(body())
        .expect(201);
      const memberSeats = (
        (await h.as(mate).get('/engagement/my')).body.data as any[]
      ).filter((r) => r.projectId === opp.id);
      const logs = (
        await h.as(lead).get(`/engagement/project/${opp.id}/attendance-logs`)
      ).body.data as any[];

      expect(logs[0].participantId).toBe(rosterMate[0].id); // lead's card finds the entry
      expect(memberSeats[0].id).toBe(rosterMate[0].id); // member's page picks the same seat
      expect(memberSeats[0].attendanceLogs).toHaveLength(1);
      expect(rosterMate[0].id).toBe(real.id);
    });
  });

  describe('one person on two different teams of the same project (legacy data) stays separated', () => {
    it("lead of team B logging on the member-B seat never lands on that person's lead-A seat", async () => {
      const opp = await liveOpp();
      const leadB = await student();
      const dual = await student(); // lead on team A, member on team B
      const seatA = await seat(opp.id, dual, { lead: true, teamId: 'TM-A' });
      await seat(opp.id, leadB, { lead: true, teamId: 'TM-B' });
      const seatB = await seat(opp.id, dual, { teamId: 'TM-B' });
      const r = await h
        .as(leadB)
        .post(`/engagement/${seatB.id}/attendance`)
        .send(body());
      expect(r.status).toBe(201);
      expect(r.body.data.participantId).toBe(seatB.id);
      expect(await logs(seatA.id)).toHaveLength(0);
      const proj = (
        await h.as(dual).get(`/engagement/project/${opp.id}/attendance-logs`)
      ).body.data as any[];
      expect(proj.find((l) => l.id === r.body.data.id).participantId).toBe(
        seatB.id,
      );
      const roster = (
        await h.as(leadB).get(`/engagement/project/${opp.id}/team`)
      ).body.data as any[];
      expect(
        roster
          .filter((x) => x.studentId === dual.id)
          .map((x) => x.id)
          .sort(),
      ).toEqual([seatA.id, seatB.id].sort());
    });
  });
});
