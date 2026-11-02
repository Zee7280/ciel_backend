/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/**
 * FYP / thesis and Startup / venture, end to end on a real database, through every login:
 * student (lead + teammate), faculty (named supervisor + a stranger), university operator (own
 * university + another), CIEL PK super admin and investor. Checks that each role sees exactly the
 * records it should, that decisions flow student → faculty → university / admin / investor, and
 * that the student-facing responses never leak reviewer-only data.
 */
import { UserRole } from '../src/users/enums/user-role.enum';
import { Organization } from '../src/organizations/entities/organization.entity';
import { bootHarness, Harness, E2eUser, uniq } from './e2e/harness';

type Body = { success?: boolean; data?: unknown; kycStatus?: string };
const data = <T = Record<string, unknown>>(res: { body: unknown }): T =>
  (res.body as Body).data as T;
const ids = (res: { body: unknown }): string[] =>
  (data<{ id: string }[]>(res) ?? []).map((r) => r.id);

const BNU = 'Beaconhouse National University (BNU)';
const LUMS = 'Lahore University of Management Sciences (LUMS)';

describe('FYP + Venture flow across every login (e2e)', () => {
  let h: Harness;
  let admin: E2eUser;
  let bnu: Organization;
  let lums: Organization;
  let bnuOperator: E2eUser;
  let lumsOperator: E2eUser;
  let faculty: E2eUser;
  let otherFaculty: E2eUser;
  let student: E2eUser;
  let mate: E2eUser;
  let outsider: E2eUser;
  let investor: E2eUser;
  let feePendingInvestor: E2eUser;

  beforeAll(async () => {
    h = await bootHarness();
    admin = await h.makeUser(UserRole.SUPER_ADMIN);
    bnu = await h.makeOrg(BNU, 'UNIVERSITY');
    lums = await h.makeOrg(LUMS, 'UNIVERSITY');
    bnuOperator = await h.makeUser(UserRole.UNIVERSITY, { org: bnu });
    lumsOperator = await h.makeUser(UserRole.UNIVERSITY, { org: lums });
    faculty = await h.makeUser(UserRole.FACULTY, {
      overrides: { university: BNU },
    });
    otherFaculty = await h.makeUser(UserRole.FACULTY, {
      overrides: { university: BNU },
    });
    student = await h.makeUser(UserRole.STUDENT, {
      overrides: { university: BNU },
    });
    mate = await h.makeUser(UserRole.STUDENT, {
      overrides: { university: BNU },
    });
    outsider = await h.makeUser(UserRole.STUDENT, {
      overrides: { university: LUMS },
    });
    investor = await h.makeUser(UserRole.INVESTOR);
    feePendingInvestor = await h.makeUser(UserRole.INVESTOR, {
      overrides: { status: 'pending_membership_payment' },
    });
  }, 120_000);

  afterAll(async () => {
    await h?.app.close();
  });

  // ------------------------------------------------------------------ FYP

  describe('FYP / thesis', () => {
    let fypId: string;

    it('student creates a record; the response is the student view (no reviewer-only fields)', async () => {
      const r = await h.as(student).post('/paths/fyp-theses').send({});
      expect(r.status).toBe(201);
      const d = data(r);
      fypId = String(d.id);
      expect(d.isOwner).toBe(true);
      expect(d.status).toBe('draft');
      expect(d.aiAnalysis ?? null).toBeNull();
      expect(d.aiAnalysisLock ?? null).toBeNull();
    });

    it('submit is refused until a title and a supervisor are on the record', async () => {
      const r = await h
        .as(student)
        .patch(`/paths/fyp-theses/${fypId}`)
        .send({ status: 'submitted' });
      expect(r.status).toBe(400);
      expect(String((r.body as { message?: unknown }).message)).toMatch(
        /isn't ready to submit/i,
      );
    });

    it('draft with a named supervisor + teammate: faculty sees it in-progress, teammate auto-joins, emails go out', async () => {
      h.mail.reset();
      const r = await h
        .as(student)
        .patch(`/paths/fyp-theses/${fypId}`)
        .send({
          projectTitle: `Solar irrigation ${uniq()}`,
          projectInfo: {
            title: 'Solar irrigation',
            university: BNU,
            supervisorEmail: faculty.email,
            supervisorName: 'Dr Ayesha',
            teamMembers: [{ name: 'Mate', email: mate.email, role: 'member' }],
          },
          status: 'draft',
        });
      expect(r.status).toBe(200);
      // faculty: in-progress yes, supervised no; a faculty not named sees nothing
      expect(
        ids(await h.as(faculty).get('/paths/fyp-thesis/in-progress')),
      ).toContain(fypId);
      expect(
        ids(await h.as(faculty).get('/paths/fyp-thesis/supervised')),
      ).not.toContain(fypId);
      expect(
        ids(await h.as(otherFaculty).get('/paths/fyp-thesis/in-progress')),
      ).not.toContain(fypId);
      // teammate (existing student account): auto-connected, read-only owner flag
      const mine = data<{ id: string; isOwner: boolean }[]>(
        await h.as(mate).get('/paths/fyp-theses'),
      );
      const shared = mine.find((e) => e.id === fypId);
      expect(shared?.isOwner).toBe(false);
      expect(
        data<{ id: string }[]>(
          await h.as(outsider).get('/paths/fyp-theses'),
        ).map((e) => e.id),
      ).not.toContain(fypId);
      // emails: team invite + "connected to faculty"
      expect(h.mail.of('sendPathTeamInvite').length).toBeGreaterThanOrEqual(1);
      expect(h.mail.of('sendPathProjectConnectedToFaculty').length).toBe(1);
    });

    it('student submits: faculty, own university and admin see it; other university does not; roles are enforced', async () => {
      const r = await h
        .as(student)
        .patch(`/paths/fyp-theses/${fypId}`)
        .send({ status: 'submitted' });
      expect(r.status).toBe(200);
      expect(data(r).supervisorApprovalStatus).toBe('pending');

      expect(
        ids(await h.as(faculty).get('/paths/fyp-thesis/supervised')),
      ).toContain(fypId);
      expect(
        ids(await h.as(faculty).get('/paths/fyp-thesis/in-progress')),
      ).not.toContain(fypId);
      expect(
        ids(await h.as(otherFaculty).get('/paths/fyp-thesis/supervised')),
      ).not.toContain(fypId);

      const uni = await h.as(bnuOperator).get('/paths/fyp-thesis/university');
      expect(uni.status).toBe(200);
      expect(ids(uni)).toContain(fypId);
      expect(
        ids(
          await h
            .as(bnuOperator)
            .get('/paths/fyp-thesis/university?approvalStatus=approved'),
        ),
      ).not.toContain(fypId);
      expect(
        ids(await h.as(lumsOperator).get('/paths/fyp-thesis/university')),
      ).not.toContain(fypId);

      const adm = await h.as(admin).get('/admin/paths/fyp-thesis');
      expect(adm.status).toBe(200);
      expect(ids(adm)).toContain(fypId);

      // role guards
      expect(
        (await h.as(student).get('/paths/fyp-thesis/supervised')).status,
      ).toBe(403);
      expect((await h.as(student).get('/admin/paths/fyp-thesis')).status).toBe(
        403,
      );
      expect(
        (await h.as(faculty).get('/paths/fyp-thesis/university')).status,
      ).toBe(403);
      expect(
        (
          await h
            .as(student)
            .patch(`/paths/fyp-thesis/${fypId}/supervisor-review`)
            .send({ action: 'approve' })
        ).status,
      ).toBe(403);
    });

    it('once submitted the supervisor cannot be re-pointed; a stranger faculty cannot decide', async () => {
      const r = await h
        .as(student)
        .patch(`/paths/fyp-theses/${fypId}`)
        .send({
          projectInfo: {
            title: 'Solar irrigation',
            university: BNU,
            supervisorEmail: otherFaculty.email,
            supervisorName: 'Someone else',
            teamMembers: [{ name: 'Mate', email: mate.email, role: 'member' }],
          },
        });
      expect(r.status).toBe(200);
      expect(
        (data(r).projectInfo as { supervisorEmail: string }).supervisorEmail,
      ).toBe(faculty.email);
      const stranger = await h
        .as(otherFaculty)
        .patch(`/paths/fyp-thesis/${fypId}/supervisor-review`)
        .send({ action: 'approve' });
      expect(stranger.status).toBeGreaterThanOrEqual(400);
    });

    it('revision → student edit → pending → approve; the student sees each state', async () => {
      const rev = await h
        .as(faculty)
        .patch(`/paths/fyp-thesis/${fypId}/supervisor-review`)
        .send({ action: 'revision', note: 'Add the evaluation plan' });
      expect(rev.status).toBe(200);
      let mine = data(await h.as(student).get(`/paths/fyp-theses/${fypId}`));
      expect(mine.supervisorApprovalStatus).toBe('revision_requested');
      expect(mine.supervisorApprovalNote).toBe('Add the evaluation plan');

      await h
        .as(student)
        .patch(`/paths/fyp-theses/${fypId}`)
        .send({ overview: 'Evaluation plan added' });
      mine = data(await h.as(student).get(`/paths/fyp-theses/${fypId}`));
      expect(mine.supervisorApprovalStatus).toBe('pending');

      const ok = await h
        .as(faculty)
        .patch(`/paths/fyp-thesis/${fypId}/supervisor-review`)
        .send({ action: 'approve' });
      expect(ok.status).toBe(200);
      mine = data(await h.as(student).get(`/paths/fyp-theses/${fypId}`));
      expect(mine.supervisorApprovalStatus).toBe('approved');
      expect(
        ids(
          await h
            .as(bnuOperator)
            .get('/paths/fyp-thesis/university?approvalStatus=approved'),
        ),
      ).toContain(fypId);
      expect(
        ids(
          await h
            .as(admin)
            .get('/admin/paths/fyp-thesis?approvalStatus=approved'),
        ),
      ).toContain(fypId);
    });

    it('merit model: faculty, university and admin pools all rank the approved record', async () => {
      for (const who of [faculty, bnuOperator, admin]) {
        const r = await h.as(who).get('/paths/fyp-thesis/merit-model');
        expect(r.status).toBe(200);
        const d = data<{ entries: { id: string }[]; graderRuns: unknown }>(r);
        expect(d.entries.map((e) => e.id)).toContain(fypId);
        expect(d.graderRuns).toBeDefined();
      }
      const lumsPool = data<{ entries: { id: string }[] }>(
        await h.as(lumsOperator).get('/paths/fyp-thesis/merit-model'),
      );
      expect(lumsPool.entries.map((e) => e.id)).not.toContain(fypId);
    });

    it('pulling an approved record back to draft withdraws the approval', async () => {
      const r = await h
        .as(student)
        .patch(`/paths/fyp-theses/${fypId}`)
        .send({ status: 'draft' });
      expect(r.status).toBe(200);
      expect(data(r).supervisorApprovalStatus).toBe('pending');
      expect(
        ids(await h.as(faculty).get('/paths/fyp-thesis/supervised')),
      ).not.toContain(fypId);
      // resubmit + approve again so the record ends approved
      await h
        .as(student)
        .patch(`/paths/fyp-theses/${fypId}`)
        .send({ status: 'submitted' });
      const ok = await h
        .as(faculty)
        .patch(`/paths/fyp-thesis/${fypId}/supervisor-review`)
        .send({ action: 'approve' });
      expect(ok.status).toBe(200);
    });

    it('deliverable upload returns the student view, not the raw row', async () => {
      const r = await h
        .as(student)
        .post(`/paths/fyp-theses/${fypId}/deliverables`)
        .send({
          label: 'Final report',
          fileUrl: 'https://files.example/report.pdf',
        });
      expect(r.status).toBe(201);
      const d = data<{
        deliverables: unknown[];
        aiAnalysisLock?: unknown;
        isOwner: boolean;
      }>(r);
      expect(d.deliverables).toHaveLength(1);
      expect(d.isOwner).toBe(true);
      expect(d.aiAnalysisLock ?? null).toBeNull();
    });
  });

  // -------------------------------------------------------------- Venture

  describe('Startup / venture', () => {
    let ventureId: string;

    it('submit is refused without a name and supervisor', async () => {
      const r = await h
        .as(outsider)
        .patch('/paths/startup-business')
        .send({ status: 'submitted' });
      expect(r.status).toBe(400);
      expect(String((r.body as { message?: unknown }).message)).toMatch(
        /isn't ready to submit/i,
      );
    });

    it('student saves a draft; the spotlight flag it sends is ignored', async () => {
      const r = await h
        .as(student)
        .patch('/paths/startup-business')
        .send({
          ventureName: `AgriSense ${uniq()}`,
          description: 'Soil sensors for small farms',
          stage: 'prototype',
          academicSetup: {
            university: BNU,
            faculty: 'Engineering',
            department: 'Computer Science',
            program: 'BSCS',
            supervisorName: 'Dr Ayesha',
            supervisorEmail: faculty.email,
            founderName: 'Lead Founder',
            founderEmail: student.email,
            founderWhatsappCode: '+92',
            founderWhatsappNumber: '3001234567',
          },
          publishSettings: {
            audience: 'investors',
            acceptIntros: true,
            featured: true,
          },
          status: 'draft',
        });
      expect(r.status).toBe(200);
      const d = data(r);
      ventureId = String(d.id);
      expect(
        (d.publishSettings as { featured?: boolean }).featured ?? false,
      ).toBe(false);
      expect(
        ids(await h.as(faculty).get('/paths/startup-business/in-progress')),
      ).toContain(ventureId);
      expect(
        ids(await h.as(faculty).get('/paths/startup-business/supervised')),
      ).not.toContain(ventureId);
    });

    it('submit lands as pending for faculty, university and admin; investors do not see it yet', async () => {
      const r = await h
        .as(student)
        .patch('/paths/startup-business')
        .send({ status: 'submitted' });
      expect(r.status).toBe(200);
      expect(
        (data(r).reviewPipeline as { supervisorStatus: string })
          .supervisorStatus,
      ).toBe('pending');

      expect(
        ids(await h.as(faculty).get('/paths/startup-business/supervised')),
      ).toContain(ventureId);
      expect(
        ids(await h.as(otherFaculty).get('/paths/startup-business/supervised')),
      ).not.toContain(ventureId);
      expect(
        ids(await h.as(bnuOperator).get('/paths/startup-business/university')),
      ).toContain(ventureId);
      expect(
        ids(
          await h
            .as(bnuOperator)
            .get('/paths/startup-business/university?approvalStatus=pending'),
        ),
      ).toContain(ventureId);
      expect(
        ids(await h.as(lumsOperator).get('/paths/startup-business/university')),
      ).not.toContain(ventureId);
      expect(
        ids(await h.as(admin).get('/admin/paths/startup-business')),
      ).toContain(ventureId);
      expect(
        ids(
          await h
            .as(admin)
            .get('/admin/paths/startup-business?approvalStatus=pending'),
        ),
      ).toContain(ventureId);
      expect(
        ids(await h.as(investor).get('/paths/startup-business/investor-hub')),
      ).not.toContain(ventureId);

      expect(
        (await h.as(student).get('/paths/startup-business/investor-hub'))
          .status,
      ).toBe(403);
      expect((await h.as(investor).get('/paths/startup-business')).status).toBe(
        403,
      );
    });

    it('faculty approves: the investor hub shows it, masked unless the investor account is verified', async () => {
      const ok = await h
        .as(faculty)
        .patch(`/paths/startup-business/${ventureId}/supervisor-review`)
        .send({ action: 'approve' });
      expect(ok.status).toBe(200);

      const verified = await h
        .as(investor)
        .get('/paths/startup-business/investor-hub');
      expect(verified.status).toBe(200);
      expect((verified.body as Body).kycStatus).toBe('verified');
      const row = data<Record<string, any>[]>(verified).find(
        (e) => e.id === ventureId,
      );
      expect(row).toBeDefined();
      expect(row!.student.name).not.toBe('Founding team');
      expect(row!.academicSetup.founderEmail).toBe(student.email);
      expect(row!.academicSetup.supervisorEmail).toBeUndefined();
      expect(row!.documents).toBeUndefined();

      const pending = await h
        .as(feePendingInvestor)
        .get('/paths/startup-business/investor-hub');
      expect(pending.status).toBe(200);
      expect((pending.body as Body).kycStatus).toBe('pending');
      const masked = data<Record<string, any>[]>(pending).find(
        (e) => e.id === ventureId,
      );
      expect(masked!.student.name).toBe('Founding team');
      expect(masked!.academicSetup.founderEmail).toBeUndefined();
      expect(masked!.academicSetup.founderWhatsappNumber).toBeUndefined();
      expect(JSON.stringify(masked)).not.toContain(student.email);

      expect(
        ids(
          await h
            .as(bnuOperator)
            .get('/paths/startup-business/university?approvalStatus=approved'),
        ),
      ).toContain(ventureId);
      expect(
        ids(
          await h
            .as(admin)
            .get('/admin/paths/startup-business?approvalStatus=approved'),
        ),
      ).toContain(ventureId);
    });

    it('founder opt-out (audience private) hides it from investors without touching the approval', async () => {
      const r = await h
        .as(student)
        .patch('/paths/startup-business')
        .send({ publishSettings: { audience: 'private', acceptIntros: true } });
      expect(r.status).toBe(200);
      expect(
        (data(r).reviewPipeline as { supervisorStatus: string })
          .supervisorStatus,
      ).toBe('approved');
      expect(
        ids(await h.as(investor).get('/paths/startup-business/investor-hub')),
      ).not.toContain(ventureId);
      // opt back in
      await h
        .as(student)
        .patch('/paths/startup-business')
        .send({
          publishSettings: { audience: 'investors', acceptIntros: true },
        });
      expect(
        ids(await h.as(investor).get('/paths/startup-business/investor-hub')),
      ).toContain(ventureId);
    });

    it('admin spotlight sticks even when the student re-saves publish settings', async () => {
      const spot = await h
        .as(admin)
        .patch(`/admin/paths/startup-business/${ventureId}/spotlight`)
        .send({ featured: true });
      expect(spot.status).toBe(200);
      expect(
        (data(spot).publishSettings as { featured: boolean }).featured,
      ).toBe(true);
      const r = await h
        .as(student)
        .patch('/paths/startup-business')
        .send({
          publishSettings: {
            audience: 'investors',
            acceptIntros: true,
            featured: false,
          },
        });
      expect((data(r).publishSettings as { featured: boolean }).featured).toBe(
        true,
      );
      const hub = data<Record<string, any>[]>(
        await h.as(investor).get('/paths/startup-business/investor-hub'),
      );
      expect(
        hub.find((e) => e.id === ventureId)?.publishSettings.featured,
      ).toBe(true);
      expect(
        (
          await h
            .as(student)
            .patch(`/admin/paths/startup-business/${ventureId}/spotlight`)
            .send({ featured: false })
        ).status,
      ).toBe(403);
    });

    it('merit model: faculty, university and admin pools rank it; a draft never does', async () => {
      for (const who of [faculty, bnuOperator, admin]) {
        const r = await h.as(who).get('/paths/startup-business/merit-model');
        expect(r.status).toBe(200);
        expect(
          data<{ entries: { id: string }[] }>(r).entries.map((e) => e.id),
        ).toContain(ventureId);
      }
      // back to draft withdraws approval and drops it from every pool
      const r = await h
        .as(student)
        .patch('/paths/startup-business')
        .send({ status: 'draft' });
      expect(
        (data(r).reviewPipeline as { supervisorStatus: string })
          .supervisorStatus,
      ).toBe('pending');
      expect(
        data<{ entries: { id: string }[] }>(
          await h.as(admin).get('/paths/startup-business/merit-model'),
        ).entries.map((e) => e.id),
      ).not.toContain(ventureId);
      expect(
        ids(await h.as(investor).get('/paths/startup-business/investor-hub')),
      ).not.toContain(ventureId);
    });

    it('faculty-owned venture: self-certify lands it approved + submitted for university and admin', async () => {
      const save = await h
        .as(faculty)
        .patch('/paths/startup-business')
        .send({
          ventureName: `FacultyVenture ${uniq()}`,
          academicSetup: {
            university: BNU,
            supervisorName: 'Self',
            supervisorEmail: faculty.email,
          },
        });
      expect(save.status).toBe(200);
      const id = String(data(save).id);
      const cert = await h
        .as(faculty)
        .post('/paths/startup-business/self-certify')
        .send({});
      expect(cert.status).toBe(201);
      const d = data(cert);
      expect(d.status).toBe('submitted');
      expect(
        (d.reviewPipeline as { supervisorStatus: string }).supervisorStatus,
      ).toBe('approved');
      expect(
        ids(
          await h
            .as(bnuOperator)
            .get('/paths/startup-business/university?approvalStatus=approved'),
        ),
      ).toContain(id);
      expect(
        ids(
          await h
            .as(admin)
            .get('/admin/paths/startup-business?approvalStatus=approved'),
        ),
      ).toContain(id);
      expect(
        (
          await h
            .as(student)
            .post('/paths/startup-business/self-certify')
            .send({})
        ).status,
      ).toBe(403);
    });
  });
});
