/**
 * Opportunity workflow fixes found in the audit, each proven through the real routes
 * (real Nest app + scratch Postgres).
 */
import {
  bootHarness,
  Harness,
  E2eUser,
  oppPayload,
  studentPayload,
  uniq,
} from './e2e/harness';
import { adminApprove, detail, verifyToken } from './e2e/helpers';
import { UserRole } from '../src/users/enums/user-role.enum';
import { MailService } from '../src/mail/mail.service';
import {
  isPrivateCandidateOpportunity,
  reviewRouteForOpportunity,
} from '../src/opportunities/private-candidate.util';

describe('Opportunity workflow fixes (real app + real Postgres)', () => {
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

  const ngoWithOrg = async () => {
    const org = await h.makeOrg();
    return { org, user: await h.makeUser(UserRole.NGO, { org }) };
  };
  const createOrgOpp = async (ngo: E2eUser, body: Record<string, any> = {}) => {
    const res = await h.as(ngo).post('/opportunities').send(oppPayload(body));
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  // ---------------------------------------------------------------- legacy mirror on org listings
  it('an NGO listing with no faculty link has no faculty gate and is NOT treated as a private candidate (no reporting fee, faculty report route)', async () => {
    const { user: ngo } = await ngoWithOrg();
    const id = await createOrgOpp(ngo);
    const o = await h.reload(id);
    expect(o.facultyApprovalStatus).toBe('not_applicable');
    expect(o.status).toBe('pending_approval');
    // the legacy field must keep NOT saying "not_required": that value means "private / independent candidate"
    expect(isPrivateCandidateOpportunity(o as any)).toBe(false);
    expect(reviewRouteForOpportunity(o as any)).toBe('faculty');
  });

  it('"Remind reviewer" on such a listing reminds CIEL PK instead of failing on a faculty that does not exist', async () => {
    const { user: ngo } = await ngoWithOrg();
    const id = await createOrgOpp(ngo);
    const res = await h
      .as(ngo)
      .post(`/student/opportunity/${id}/remind-reviewer`)
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.sent_to).toBe('admin');
    expect(res.body.message).not.toMatch(/faculty/i);
  });

  it('an admin editing only a partner contact on such a listing does not push it back to a faculty step with no reviewer', async () => {
    const { user: ngo } = await ngoWithOrg();
    const id = await createOrgOpp(ngo);
    const res = await h
      .as(admin)
      .patch(`/admin/opportunities/${id}/contacts`)
      .send({ partner_organization_name: 'Host Trust' });
    expect(res.status).toBe(200);
    const o = await h.reload(id);
    expect(o.status).toBe('pending_approval');
    expect(o.workflowStage).toBe('pending_admin');
    expect(o.facultyApprovalStatus).toBe('not_applicable');
    expect((await adminApprove(h, admin, id)).status).toBe(201); // still approvable: nothing is stuck
  });

  // ---------------------------------------------------------------- admin reject
  it('rejecting a listing clears its legacy approved flag so no consumer still treats it as approved', async () => {
    const { user: ngo } = await ngoWithOrg();
    const id = await createOrgOpp(ngo);
    expect((await adminApprove(h, admin, id)).status).toBe(201);
    expect((await h.reload(id)).admin_approved).toBe(true);
    const rej = await h
      .as(admin)
      .post(`/admin/opportunities/${id}/reject`)
      .send({ reason: 'Not suitable' });
    expect(rej.status).toBe(201);
    const o = await h.reload(id);
    expect(o.status).toBe('rejected');
    expect(o.adminApprovalStatus).toBe('rejected');
    expect(o.admin_approved).toBe(false);
  });

  // ---------------------------------------------------------------- partner_id junk
  it('a malformed partner_id is a clean 404 / empty list, never a database error', async () => {
    const { user: ngo } = await ngoWithOrg();
    const authed = await h.as(ngo).get('/opportunities?partner_id=not-a-uuid');
    expect(authed.status).toBe(404);
    const anon = await h
      .as(null)
      .get('/public/opportunities?partner_id=not-a-uuid');
    expect(anon.status).toBe(200);
    expect(anon.body.data ?? anon.body).toEqual([]);
    const sql = await h.as(admin).get("/opportunities?partner_id=' OR 1=1 --");
    expect(sql.status).toBeLessThan(500);
  });

  // ---------------------------------------------------------------- expired reviewer links
  describe('reviewer links that expired are replaced before they are emailed again', () => {
    it('a reminder to the faculty carries a working link even when the original expired', async () => {
      const s = await h.makeUser(UserRole.STUDENT);
      const fac = await h.makeUser(UserRole.FACULTY);
      const sub = await h
        .as(s)
        .post('/student/opportunity')
        .send(studentPayload(fac.email));
      expect(sub.status).toBe(201);
      const id = sub.body.data.id;
      const original = (await h.reload(id)).faculty_verification_token!;
      await h.ds.query(
        `UPDATE opportunities SET "facultyTokenExpiresAt" = now() - interval '1 day' WHERE id = $1`,
        [id],
      );
      expect((await verifyToken(h, original)).status).toBeGreaterThanOrEqual(
        400,
      ); // the old link is dead

      h.mail.reset();
      const remind = await h
        .as(s)
        .post(`/student/opportunity/${id}/remind-reviewer`)
        .send({});
      expect(remind.status).toBe(201);
      const sent = h.mail.of('sendFacultyStudentOpportunityVerification');
      expect(sent).toHaveLength(1);
      const fresh = sent[0].args[2] as string;
      expect(fresh).not.toBe(original);
      const row = await h.reload(id);
      expect(row.facultyTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now());
      expect((await verifyToken(h, fresh)).status).toBe(201); // the emailed link actually works
    });

    it('a still-valid link is kept: reminding does not invalidate the mail the reviewer already has', async () => {
      const s = await h.makeUser(UserRole.STUDENT);
      const fac = await h.makeUser(UserRole.FACULTY);
      const id = (
        await h
          .as(s)
          .post('/student/opportunity')
          .send(studentPayload(fac.email))
      ).body.data.id;
      const original = (await h.reload(id)).faculty_verification_token!;
      h.mail.reset();
      await h.as(s).post(`/student/opportunity/${id}/remind-reviewer`).send({});
      expect(
        h.mail.of('sendFacultyStudentOpportunityVerification')[0].args[2],
      ).toBe(original);
    });

    it('the partner mail sent after a LATE faculty approval carries a working link', async () => {
      const s = await h.makeUser(UserRole.STUDENT);
      const fac = await h.makeUser(UserRole.FACULTY);
      const partnerEmail = `host.${uniq()}@e2e.test`;
      const sub = await h
        .as(s)
        .post('/student/opportunity')
        .send(
          studentPayload(fac.email, {
            executing_context: {
              type: 'partner',
              partner: {
                official_email: partnerEmail,
                organization_name: 'Host Org',
              },
            },
          }),
        );
      expect(sub.status).toBe(201);
      const id = sub.body.data.id;
      const o0 = await h.reload(id);
      const stalePartner = o0.partnerToken!;
      // the partner token was issued at creation; by the time the faculty acts it has expired
      await h.ds.query(
        `UPDATE opportunities SET "partnerTokenExpiresAt" = now() - interval '1 day' WHERE id = $1`,
        [id],
      );
      expect(
        (await verifyToken(h, o0.faculty_verification_token!)).status,
      ).toBe(201);
      const mails = h.mail.of('sendPartnerVerification');
      expect(mails).toHaveLength(1);
      const emailed = mails[0].args[2] as string;
      expect(emailed).not.toBe(stalePartner);
      expect((await verifyToken(h, emailed)).status).toBe(201); // dead-on-arrival before the fix
      expect((await h.reload(id)).status).toBe('pending_approval');
    });
  });

  it('an unrelated partial update does not turn expiring reviewer links into permanent ones', async () => {
    const s = await h.makeUser(UserRole.STUDENT);
    const fac = await h.makeUser(UserRole.FACULTY);
    const id = (
      await h.as(s).post('/student/opportunity').send(studentPayload(fac.email))
    ).body.data.id;
    const before = (await h.reload(id)).facultyTokenExpiresAt;
    expect(before).toBeTruthy();
    await h.opps.update(id, { admin_hidden: true } as any); // any partial column update
    expect((await h.reload(id)).facultyTokenExpiresAt?.getTime()).toBe(
      before!.getTime(),
    );
  });

  // ---------------------------------------------------------------- admin contacts edit
  describe('admin correcting a reviewer contact', () => {
    it('the NEW reviewer is emailed a working link and the old link stops working', async () => {
      const s = await h.makeUser(UserRole.STUDENT);
      const oldFac = await h.makeUser(UserRole.FACULTY);
      const newFac = await h.makeUser(UserRole.FACULTY);
      const id = (
        await h
          .as(s)
          .post('/student/opportunity')
          .send(studentPayload(oldFac.email))
      ).body.data.id;
      const oldToken = (await h.reload(id)).faculty_verification_token!;
      h.mail.reset();

      const res = await h
        .as(admin)
        .patch(`/admin/opportunities/${id}/contacts`)
        .send({ faculty_supervisor_email: newFac.email });
      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 150)); // the mail is sent best-effort, off the request
      const sent = h.mail.of('sendFacultyStudentOpportunityVerification');
      expect(sent).toHaveLength(1);
      expect(sent[0].args[0]).toBe(newFac.email);
      const fresh = sent[0].args[2] as string;
      expect(fresh).not.toBe(oldToken);
      expect((await verifyToken(h, oldToken)).status).toBeGreaterThanOrEqual(
        400,
      );
      expect((await verifyToken(h, fresh)).status).toBe(201);
    });

    it('a mail failure never undoes the contact change', async () => {
      const s = await h.makeUser(UserRole.STUDENT);
      const oldFac = await h.makeUser(UserRole.FACULTY);
      const newFac = await h.makeUser(UserRole.FACULTY);
      const id = (
        await h
          .as(s)
          .post('/student/opportunity')
          .send(studentPayload(oldFac.email))
      ).body.data.id;
      const mailer = h.app.get(MailService) as any;
      const original = mailer.sendFacultyStudentOpportunityVerification;
      mailer.sendFacultyStudentOpportunityVerification = async () => {
        throw new Error('smtp down');
      };
      try {
        const res = await h
          .as(admin)
          .patch(`/admin/opportunities/${id}/contacts`)
          .send({ faculty_supervisor_email: newFac.email });
        expect(res.status).toBe(200);
        expect(((await h.reload(id)).supervision as any).contact).toBe(
          newFac.email,
        );
      } finally {
        mailer.sendFacultyStudentOpportunityVerification = original;
      }
    });
  });

  // ---------------------------------------------------------------- partner gate with nobody to ask
  it('a partner gate with no partner email is dropped consistently, so the row cannot get stuck after faculty approval', async () => {
    const s = await h.makeUser(UserRole.STUDENT);
    const fac = await h.makeUser(UserRole.FACULTY);
    const sub = await h
      .as(s)
      .post('/student/opportunity')
      .send(
        studentPayload(fac.email, {
          executing_context: {
            type: 'partner',
            partner: {
              official_email: `host.${uniq()}@e2e.test`,
              organization_name: 'Host Org',
            },
          },
        }),
      );
    const id = sub.body.data.id;
    const o0 = await h.reload(id);
    expect(o0.requiresPartnerApproval).toBe(true);
    // the admin removes the partner contact: nobody is left to ask
    const res = await h
      .as(admin)
      .patch(`/admin/opportunities/${id}/contacts`)
      .send({ partner_contact_email: '' });
    expect(res.status).toBe(200);
    const o1 = await h.reload(id);
    expect(o1.requiresPartnerApproval).toBe(
      o1.partnerApprovalStatus !== 'not_applicable',
    );
    // faculty approves with the (fresh) link: the row moves to CIEL PK, not to a partner stage with no reviewer
    expect((await verifyToken(h, o1.faculty_verification_token!)).status).toBe(
      201,
    );
    const o2 = await h.reload(id);
    if (!o1.requiresPartnerApproval) {
      expect(o2.status).toBe('pending_approval');
      expect((await adminApprove(h, admin, id)).status).toBe(201);
    }
  });

  // ---------------------------------------------------------------- contact redaction
  it('phone / WhatsApp keys of any spelling are removed for viewers who may not see contacts, and kept for the owner', async () => {
    const { user: ngo } = await ngoWithOrg();
    const id = await createOrgOpp(ngo, { supervision: undefined });
    expect((await adminApprove(h, admin, id)).status).toBe(201);
    await h.opps.update(id, {
      supervision: {
        partner_whatsapp_e164: '+923001110001',
        faculty_whatsapp: '+923001110002',
        partner_phone: '+923001110003',
        supervisor_name: 'Dr Name',
      },
    } as any);
    const stranger = await h.makeUser(UserRole.STUDENT);
    const pub = JSON.stringify(
      (await h.as(null).get('/public/opportunities')).body,
    );
    const seen = JSON.stringify((await detail(h, stranger, id)).body);
    for (const phone of ['+923001110001', '+923001110002', '+923001110003']) {
      expect({
        phone,
        public: pub.includes(phone),
        stranger: seen.includes(phone),
      }).toEqual({ phone, public: false, stranger: false });
    }
    expect(seen).toContain('Dr Name'); // non-contact fields stay visible
    const mine = JSON.stringify((await detail(h, ngo, id)).body);
    expect(mine).toContain('+923001110001'); // the owner still sees their own contacts
  });
});
