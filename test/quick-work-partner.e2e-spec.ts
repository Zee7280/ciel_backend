/**
 * Quick Community Impact → host / partner organisations, end to end (real Nest app + scratch Postgres):
 * on CIEL PK's final approval the host and each partner are emailed the flashcard, an organisation with a
 * partner account is notified, and the approved activity appears on that account's My Impact Wall.
 */
import { bootHarness, E2eUser, Harness } from './e2e/harness';
import { UserRole } from '../src/users/enums/user-role.enum';
import { S3Service } from '../src/common/s3.service';
import { Notification } from '../src/notifications/entities/notification.entity';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

type Body<T> = { data: T; message?: string | string[] };
type LogView = { id: string; status: string; peopleTarget: number | null };
type WallRow = {
  id: string;
  title: string;
  hours: number;
  students: number;
  peopleTarget: number | null;
  host: string | null;
  partners: string[];
};
type FlashcardMail = {
  to: string;
  contactName?: string;
  opportunity: string;
  existingAccount?: boolean;
  pdf: Buffer;
};

const pastDay = (d: number) =>
  new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
const uniq = () => Math.random().toString(36).slice(2, 8);

describe('Quick Impact partner flashcard (real app + real Postgres)', () => {
  let h: Harness;
  let admin: E2eUser;
  let evidenceUrl: (owner: E2eUser) => string;
  let notes: Repository<Notification>;

  beforeAll(async () => {
    h = await bootHarness({ bodyLimit: '50mb' });
    admin = await h.makeUser(UserRole.SUPER_ADMIN);
    const s3 = h.app.get<unknown, { bucket: string; region: string }>(
      S3Service,
    );
    evidenceUrl = (owner) =>
      `https://${s3.bucket}.s3.${s3.region}.amazonaws.com/quick-work/${owner.id}/photo.jpg`;
    notes = h.app.get<Repository<Notification>>(
      getRepositoryToken(Notification),
    );
  });
  afterAll(async () => {
    delete process.env.QCI_PARTNER_EMAIL;
    await h.app.close();
  });

  const university = async () => {
    const org = await h.makeOrg('E2E University', 'university');
    return org;
  };

  /** A complete solo log naming a host and one partner (by email), submitted and faculty-approved. */
  const logAtFinalApproval = async (
    lead: E2eUser,
    over: Record<string, unknown> = {},
  ) => {
    const org = await university();
    const faculty = await h.makeUser(UserRole.FACULTY);
    await h
      .as(admin)
      .post('/admin/faculty-university-scope')
      .send({ facultyUserId: faculty.id, universityOrganizationId: org.id })
      .expect(201);
    const s = uniq();
    const created = await h
      .as(lead)
      .post('/quick-work/logs')
      .send({
        mode: 'solo',
        leadStudentId: `SID-${lead.id.slice(0, 6)}`,
        university: 'E2E University',
        department: 'Computer Science',
        facultyName: 'Dr Reviewer',
        facultyEmail: faculty.email,
        title: `Pinktober ${s}`,
        activityType: 'Pinktober event',
        activityDate: pastDay(3),
        startTime: '10:00',
        endTime: '11:30',
        location: 'Campus courtyard, Lahore',
        sdg: 3,
        host: 'Host NGO',
        hostEmail: `host.${s}@ngo.test`,
        partnerDetails: [
          {
            name: 'Partner Org',
            email: `partner.${s}@ngo.test`,
            contact: null,
          },
          { name: 'No Email Org', email: null, contact: null },
        ],
        attendance: [
          {
            email: lead.email,
            present: true,
            startTime: '10:00',
            endTime: '11:30',
            breakMinutes: 0,
          },
        ],
        summary: 'We ran an awareness desk and shared leaflets.',
        peopleReached: 40,
        peopleTarget: 35,
        visibility: 'Faculty, University & CIEL PK only',
        evidence: [
          {
            url: evidenceUrl(lead),
            name: 'photo.jpg',
            type: 'image/jpeg',
            size: 1000,
            caption: 'Awareness desk',
          },
        ],
        consent: true,
        honest: true,
        ...over,
      });
    expect(created.status).toBe(201);
    const log = (created.body as Body<LogView>).data;
    await h.as(lead).post(`/quick-work/logs/${log.id}/submit`).expect(201);
    await h
      .as(faculty)
      .post(`/faculty/quick-work/${log.id}/review`)
      .send({ action: 'approve', verified: true })
      .expect(201);
    return {
      log,
      hostEmail: `host.${s}@ngo.test`,
      partnerEmail: `partner.${s}@ngo.test`,
    };
  };

  const finalApprove = (id: string) =>
    h
      .as(admin)
      .post(`/admin/quick-work/${id}/review`)
      .send({ action: 'approve', verified: true })
      .expect(201);

  const flashcardMails = () =>
    h.mail
      .of('sendQuickImpactPartnerFlashcard')
      .map((c) => c.args[0] as FlashcardMail);

  it('saves, returns and validates the optional people target', async () => {
    const lead = await h.makeUser(UserRole.STUDENT);
    const { log } = await logAtFinalApproval(lead);
    expect(log.peopleTarget).toBe(35);
    // Not a whole number of 1 or more.
    const bad = await h
      .as(lead)
      .post('/quick-work/logs')
      .send({ mode: 'solo', peopleTarget: 0 });
    expect(bad.status).toBe(400);
    // Optional: omitting it, or sending null, is fine.
    const none = await h
      .as(lead)
      .post('/quick-work/logs')
      .send({ mode: 'solo', peopleTarget: null });
    expect(none.status).toBe(201);
    expect((none.body as Body<LogView>).data.peopleTarget).toBeNull();
  });

  it('final approval emails the host and each partner with an email: PDF attached, no student details', async () => {
    const lead = await h.makeUser(UserRole.STUDENT);
    const { log, hostEmail, partnerEmail } = await logAtFinalApproval(lead);

    h.mail.reset();
    await finalApprove(log.id);
    const mails = flashcardMails();
    expect(mails.map((m) => m.to).sort()).toEqual(
      [hostEmail, partnerEmail].sort(),
    );
    for (const m of mails) {
      expect(m.pdf.subarray(0, 5).toString()).toBe('%PDF-');
      expect(m.existingAccount).toBe(false);
      expect(m.opportunity).toContain('Pinktober');
      expect(JSON.stringify({ ...m, pdf: undefined })).not.toContain(
        lead.email,
      );
    }
    // The student heard about it as before.
    expect(h.mail.of('sendQuickImpactPartnerFlashcard')).toHaveLength(2);
  });

  it('nothing is sent before final approval, and never to a participant or the faculty reviewer', async () => {
    const lead = await h.makeUser(UserRole.STUDENT);
    h.mail.reset();
    const { log } = await logAtFinalApproval(lead, {
      hostEmail: lead.email, // a student typing their own address as host
      partnerDetails: [],
    });
    expect(flashcardMails()).toHaveLength(0); // faculty approval alone sends nothing
    await finalApprove(log.id);
    expect(flashcardMails()).toHaveLength(0); // the only address is the student's own
  });

  it('an organisation that already has a partner account is notified, linked to sign in, and sees the activity on its wall', async () => {
    const lead = await h.makeUser(UserRole.STUDENT);
    const hostEmail = `known.${uniq()}@ngo.test`;
    const org = await h.makeOrg('Known NGO', 'NGO');
    const partner = await h.makeUser(UserRole.NGO, { email: hostEmail, org });
    const { log } = await logAtFinalApproval(lead, { hostEmail });

    // Not approved yet: nothing on the wall.
    let wall = await h.as(partner).get('/partner/quick-impact');
    expect(wall.status).toBe(200);
    expect((wall.body as Body<WallRow[]>).data).toEqual([]);

    h.mail.reset();
    await finalApprove(log.id);
    const mail = flashcardMails().find((m) => m.to === hostEmail);
    expect(mail?.existingAccount).toBe(true);

    let rows: Notification[] = [];
    for (let i = 0; i < 50 && !rows.length; i++) {
      rows = await notes.find({
        where: {
          userId: partner.id,
          title: 'Quick Community Impact flashcard ready',
        },
      });
      if (!rows.length) await new Promise((r) => setTimeout(r, 20));
    }
    expect(rows).toHaveLength(1);

    wall = await h.as(partner).get('/partner/quick-impact');
    const data = (wall.body as Body<WallRow[]>).data;
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      id: log.id,
      hours: 1.5,
      students: 1,
      peopleTarget: 35,
      host: 'Host NGO',
      partners: ['Partner Org', 'No Email Org'],
    });
    // Counts and the activity only: no student name, email or contact.
    const text = JSON.stringify(wall.body);
    expect(text).not.toContain(lead.email);
    expect(text).not.toContain('+923001234567');
  });

  it('a partner registering later (same address as a partner on the log) finds it on their wall', async () => {
    const lead = await h.makeUser(UserRole.STUDENT);
    const { log, partnerEmail } = await logAtFinalApproval(lead);
    await finalApprove(log.id);
    const later = await h.makeUser(UserRole.CORPORATE, {
      email: partnerEmail.toUpperCase(),
    });
    const res = await h.as(later).get('/partner/quick-impact');
    expect(res.status).toBe(200);
    expect((res.body as Body<WallRow[]>).data.map((r) => r.id)).toContain(
      log.id,
    );
  });

  it('the wall is private to the organisation named, and closed to students and anonymous callers', async () => {
    const lead = await h.makeUser(UserRole.STUDENT);
    const { log } = await logAtFinalApproval(lead);
    await finalApprove(log.id);
    const stranger = await h.makeUser(UserRole.NGO);
    const res = await h.as(stranger).get('/partner/quick-impact');
    expect(res.status).toBe(200);
    expect((res.body as Body<WallRow[]>).data).toEqual([]);
    expect((await h.as(lead).get('/partner/quick-impact')).status).toBe(403);
    expect((await h.as(null).get('/partner/quick-impact')).status).toBe(401);
  });

  it('QCI_PARTNER_EMAIL=off switches the emails off without affecting the approval', async () => {
    const lead = await h.makeUser(UserRole.STUDENT);
    const { log } = await logAtFinalApproval(lead);
    process.env.QCI_PARTNER_EMAIL = 'off';
    try {
      h.mail.reset();
      await finalApprove(log.id);
      expect(flashcardMails()).toHaveLength(0);
      const view = await h.as(admin).get(`/admin/quick-work/${log.id}`);
      expect((view.body as Body<LogView>).data.status).toBe('approved');
    } finally {
      delete process.env.QCI_PARTNER_EMAIL;
    }
  });
});
