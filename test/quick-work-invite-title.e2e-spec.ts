/**
 * Quick Community Impact teammate invitations name the activity (real Nest app + scratch Postgres):
 * the email carries the title, and a NEW teammate cannot be invited while the title is still empty.
 * A teammate who is already on the log never blocks a save.
 */
import { bootHarness, E2eUser, Harness } from './e2e/harness';
import { UserRole } from '../src/users/enums/user-role.enum';

type Body<T> = { data: T; message?: string | string[] };
type LogView = { id: string; participants: { email: string }[] };
type InviteMail = { to: string; title: string; leadName: string };

const uniq = () => Math.random().toString(36).slice(2, 8);

describe('Quick Impact teammate invitations name the activity (real app + real Postgres)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await bootHarness({ bodyLimit: '50mb' });
  });
  afterAll(async () => {
    await h.app.close();
  });

  const messages = (body: Body<unknown>) =>
    ([] as string[]).concat(body.message ?? []).join(' | ');

  const newDraft = async (lead: E2eUser, body: Record<string, unknown>) =>
    h
      .as(lead)
      .post('/quick-work/logs')
      .send({ mode: 'team', ...body });

  it('a teammate invited once the activity is named gets an email that carries the title', async () => {
    const lead = await h.makeUser(UserRole.STUDENT);
    const mate = await h.makeUser(UserRole.STUDENT);
    h.mail.reset();
    const res = await newDraft(lead, {
      title: 'Pinktober awareness circle',
      teammates: [{ email: mate.email, studentId: 'M-1', name: 'Mate' }],
    });
    expect(res.status).toBe(201);
    for (
      let i = 0;
      i < 50 && !h.mail.of('sendQuickWorkTeamInvite').length;
      i++
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const mails = h.mail.of('sendQuickWorkTeamInvite');
    expect(mails).toHaveLength(1);
    expect(mails[0].args[0] as InviteMail).toMatchObject({
      to: mate.email,
      title: 'Pinktober awareness circle',
    });
  });

  it('an email to someone without an account (sign-up invite) names the activity too', async () => {
    const lead = await h.makeUser(UserRole.STUDENT);
    const email = `newcomer.${uniq()}@e2e.test`;
    h.mail.reset();
    const res = await newDraft(lead, {
      title: 'Tree plantation drive',
      teammates: [{ email, studentId: 'N-1', name: 'Newcomer' }],
    });
    expect(res.status).toBe(201);
    for (
      let i = 0;
      i < 50 && !h.mail.of('sendQuickWorkSignupInvite').length;
      i++
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const mails = h.mail.of('sendQuickWorkSignupInvite');
    expect(mails).toHaveLength(1);
    expect(mails[0].args[0] as InviteMail).toMatchObject({
      to: email,
      title: 'Tree plantation drive',
    });
  });

  it('a NEW teammate is refused while the title is empty, and nothing is sent or saved', async () => {
    const lead = await h.makeUser(UserRole.STUDENT);
    const mate = await h.makeUser(UserRole.STUDENT);
    const stranger = `stranger.${uniq()}@e2e.test`;
    h.mail.reset();

    // On create (no title) with a teammate who has an account, and with one who does not.
    for (const email of [mate.email, stranger]) {
      const res = await newDraft(lead, {
        teammates: [{ email, studentId: 'X-1', name: 'X' }],
      });
      expect(res.status).toBe(400);
      expect(messages(res.body as Body<unknown>)).toMatch(/activity title/i);
    }
    // The same on an existing draft that has no title yet.
    const plain = await h
      .as(lead)
      .post('/quick-work/logs')
      .send({ mode: 'solo' });
    expect(plain.status).toBe(201);
    const id = (plain.body as Body<LogView>).data.id;
    const add = await h
      .as(lead)
      .patch(`/quick-work/logs/${id}`)
      .send({
        mode: 'team',
        teammates: [{ email: mate.email, studentId: 'X-2', name: 'X' }],
      });
    expect(add.status).toBe(400);
    const after = await h.as(lead).get(`/quick-work/logs/${id}`);
    expect(
      (after.body as Body<LogView>).data.participants.map((p) => p.email),
    ).toEqual([lead.email]);
    expect(h.mail.of('sendQuickWorkTeamInvite')).toHaveLength(0);
    expect(h.mail.of('sendQuickWorkSignupInvite')).toHaveLength(0);

    // Naming the activity unblocks it.
    const ok = await h
      .as(lead)
      .patch(`/quick-work/logs/${id}`)
      .send({
        title: 'Clean-up drive',
        mode: 'team',
        teammates: [{ email: mate.email, studentId: 'X-2', name: 'X' }],
      });
    expect(ok.status).toBe(200);
  });

  it('a teammate already invited never blocks a save, even if the title is later cleared', async () => {
    const lead = await h.makeUser(UserRole.STUDENT);
    const mate = await h.makeUser(UserRole.STUDENT);
    const stranger = `waiting.${uniq()}@e2e.test`;
    const created = await newDraft(lead, {
      title: 'Awareness desk',
      teammates: [
        { email: mate.email, studentId: 'M-3', name: 'Mate' },
        { email: stranger, studentId: 'W-3', name: 'Waiting' },
      ],
    });
    expect(created.status).toBe(201);
    const id = (created.body as Body<LogView>).data.id;
    h.mail.reset();
    // Autosave sends the whole form each time: same team, title now empty.
    const again = await h
      .as(lead)
      .patch(`/quick-work/logs/${id}`)
      .send({
        title: '',
        mode: 'team',
        teammates: [
          { email: mate.email, studentId: 'M-3', name: 'Mate' },
          { email: stranger, studentId: 'W-3', name: 'Waiting' },
        ],
      });
    expect(again.status).toBe(200);
    expect(h.mail.of('sendQuickWorkTeamInvite')).toHaveLength(0);
    expect(h.mail.of('sendQuickWorkSignupInvite')).toHaveLength(0);
  });
});
