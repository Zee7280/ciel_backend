/**
 * University SSO, end to end (real Nest app + scratch Postgres + a mock OpenID Connect provider on
 * 127.0.0.1): off by default, configured and activated per university by a CIEL admin, students
 * signed in through the provider are matched to their existing account or complete a short
 * profile, and every refusal (domain, role, affiliation, duplicate identity) is enforced.
 */
import { bootHarness, E2eUser, Harness } from './e2e/harness';
import { MockIdpUser, MockOidcProvider } from './e2e/mock-oidc-provider';
import { UserRole } from '../src/users/enums/user-role.enum';
import { User } from '../src/users/entities/user.entity';
import { Organization } from '../src/organizations/entities/organization.entity';
import { Setting } from '../src/settings/entities/setting.entity';
import { PlatformSettingsService } from '../src/settings/platform-settings.service';

type Body<T> = { data: T; message?: string | string[] };
type Session = {
  access_token: string;
  user: { id: string; email: string; role: string; account_status: string };
};
type SsoView = {
  status: string;
  hasClientSecret: boolean;
  redirectUri: string;
  lastTestOk: boolean | null;
};

const GIFT = 'GIFT University';
const DOMAIN = 'gift.edu.pk';

describe('University SSO (real app + mock OpenID Connect provider)', () => {
  let h: Harness;
  let idp: MockOidcProvider;
  let admin: E2eUser;
  let uni: Organization;

  beforeAll(async () => {
    // A fixed callback origin: supertest opens an ephemeral port per request, and the mock
    // provider requires the redirect_uri at the token endpoint to match the one it was sent.
    process.env.SSO_REDIRECT_BASE_URL = 'http://127.0.0.1:65530/api/v1';
    idp = new MockOidcProvider();
    await idp.start();
    h = await bootHarness();
    admin = await h.makeUser(UserRole.SUPER_ADMIN);
    uni = await h.makeOrg(GIFT, 'university');
  });
  afterAll(async () => {
    await h.app.close();
    await idp.stop();
  });

  const setSwitch = async (on: boolean) => {
    const repo = h.ds.getRepository(Setting);
    const existing = await repo.findOne({
      where: { key: 'UNIVERSITY_SSO_ENABLED' },
    });
    await repo.save(
      existing
        ? { ...existing, value: on ? 'true' : 'false' }
        : repo.create({
            key: 'UNIVERSITY_SSO_ENABLED',
            value: on ? 'true' : 'false',
          }),
    );
    h.app.get(PlatformSettingsService).invalidate();
  };

  const messages = (body: Body<unknown>) =>
    ([] as string[]).concat(body.message ?? []).join(' | ');

  /** Student clicks "Sign in with your university": start → provider → callback → final redirect. */
  const runSso = async (user: MockIdpUser, next?: string): Promise<URL> => {
    const start = await h
      .as(null)
      .get(
        `/auth/sso/start?university=${uni.id}${next ? `&next=${encodeURIComponent(next)}` : ''}`,
      );
    expect(start.status).toBe(302);
    idp.setUser(user);
    const atProvider = await fetch(start.headers.location, {
      redirect: 'manual',
    });
    expect(atProvider.status).toBe(302);
    const back = new URL(atProvider.headers.get('location') ?? '');
    const cb = await h
      .as(null)
      .get(`${back.pathname.replace(/^\/api\/v1/, '')}${back.search}`);
    expect(cb.status).toBe(302);
    return new URL(cb.headers.location);
  };

  const exchange = async (ticket: string) =>
    h.as(null).post('/auth/sso/exchange').send({ ticket });

  it('is off by default: nothing listed, start refused, even with a configured university', async () => {
    const list = await h.as(null).get('/auth/sso/universities');
    expect(list.status).toBe(200);
    expect((list.body as Body<unknown[]>).data).toEqual([]);
    expect(
      (await h.as(null).get(`/auth/sso/start?university=${uni.id}`)).status,
    ).toBe(404);
  });

  it('admin configures a university, must test before activating, then students see it', async () => {
    await setSwitch(true);
    const config = {
      provider: 'oidc',
      issuer: idp.baseUrl,
      clientId: idp.clientId,
      clientSecret: idp.clientSecret,
      allowedDomains: [`@${DOMAIN.toUpperCase()}`, DOMAIN],
    };
    const student = await h.makeUser(UserRole.STUDENT);
    expect(
      (await h.as(student).put(`/admin/university-sso/${uni.id}`).send(config))
        .status,
    ).toBe(403);

    // Only university organizations; an NGO is refused.
    const ngo = await h.makeOrg('Some NGO');
    expect(
      (await h.as(admin).put(`/admin/university-sso/${ngo.id}`).send(config))
        .status,
    ).toBe(400);

    const saved = await h
      .as(admin)
      .put(`/admin/university-sso/${uni.id}`)
      .send(config);
    expect(saved.status).toBe(200);
    const view = (saved.body as Body<SsoView & { allowedDomains: string[] }>)
      .data;
    expect(view).toMatchObject({
      status: 'draft',
      hasClientSecret: true,
      allowedDomains: [DOMAIN],
      redirectUri: 'http://127.0.0.1:65530/api/v1/auth/sso/callback',
    });

    // Still invisible to students while draft.
    expect((await h.as(null).get('/auth/sso/universities')).body).toMatchObject(
      { data: [] },
    );

    const early = await h
      .as(admin)
      .post(`/admin/university-sso/${uni.id}/activate`)
      .send({});
    expect(early.status).toBe(400);
    expect(messages(early.body as Body<unknown>)).toMatch(/test sign-in/);

    // Test link: proves the provider works, issues no session.
    const link = await h
      .as(admin)
      .post(`/admin/university-sso/${uni.id}/test-link`)
      .send({});
    expect(link.status).toBe(201);
    const testUrl = new URL((link.body as Body<{ url: string }>).data.url);
    const toProvider = await h
      .as(null)
      .get(`${testUrl.pathname.replace(/^\/api\/v1/, '')}${testUrl.search}`);
    expect(toProvider.status).toBe(302);
    idp.setUser({
      sub: 'it-admin',
      email: `it@${DOMAIN}`,
      email_verified: true,
    });
    const atProvider = await fetch(toProvider.headers.location, {
      redirect: 'manual',
    });
    const back = new URL(atProvider.headers.get('location') ?? '');
    const cb = await h
      .as(null)
      .get(`${back.pathname.replace(/^\/api\/v1/, '')}${back.search}`);
    expect(cb.status).toBe(302);
    const final = new URL(cb.headers.location);
    expect(final.pathname).toBe('/login/sso');
    expect(final.searchParams.get('test')).toBe('ok');
    expect(final.searchParams.get('ticket')).toBeNull();

    const detail = await h.as(admin).get(`/admin/university-sso/${uni.id}`);
    expect((detail.body as Body<{ sso: SsoView }>).data.sso.lastTestOk).toBe(
      true,
    );

    const activated = await h
      .as(admin)
      .post(`/admin/university-sso/${uni.id}/activate`)
      .send({});
    expect(activated.status).toBe(201);
    expect((activated.body as Body<SsoView>).data.status).toBe('active');

    const list = await h.as(null).get('/auth/sso/universities');
    expect(
      (list.body as Body<{ organizationId: string; name: string }[]>).data,
    ).toEqual([
      expect.objectContaining({ organizationId: uni.id, name: GIFT }),
    ]);
  });

  it('links an existing student by verified email, signs them in once per ticket, then by subject', async () => {
    const student = await h.makeUser(UserRole.STUDENT, {
      email: `stu.${Date.now()}@${DOMAIN}`,
      overrides: { university: GIFT },
    });
    const done = await runSso(
      {
        sub: 'sub-1',
        email: student.email,
        email_verified: true,
        name: 'Stu Dent',
      },
      '/dashboard/student/impact',
    );
    expect(done.pathname).toBe('/login/sso');
    expect(done.searchParams.get('next')).toBe('/dashboard/student/impact');
    const ticket = done.searchParams.get('ticket');
    expect(ticket).toBeTruthy();

    const session = await exchange(ticket!);
    expect(session.status).toBe(201);
    const data = (session.body as Body<Session>).data;
    expect(data.user).toMatchObject({
      id: student.id,
      email: student.email,
      role: 'student',
    });
    expect(
      (await h.as({ ...student, token: data.access_token }).get('/settings'))
        .status,
    ).toBe(200);

    // Single use.
    expect((await exchange(ticket!)).status).toBe(401);
    expect((await exchange('not-a-ticket')).status).toBe(401);

    const linked = await h.ds
      .getRepository(User)
      .findOne({ where: { id: student.id } });
    expect(linked).toMatchObject({
      ssoIssuer: idp.baseUrl,
      ssoSubject: 'sub-1',
    });

    // The provider's subject wins over a changed email address.
    const renamed = await runSso({
      sub: 'sub-1',
      email: `renamed.${Date.now()}@${DOMAIN}`,
      email_verified: true,
    });
    const again = await exchange(renamed.searchParams.get('ticket')!);
    expect((again.body as Body<Session>).data.user.id).toBe(student.id);

    // A second provider identity cannot take over the linked account.
    const conflict = await runSso({
      sub: 'sub-2',
      email: student.email,
      email_verified: true,
    });
    expect(conflict.searchParams.get('error')).toBe('identity_conflict');
  });

  it('refuses the wrong domain, unverified emails, non-students and students of another university', async () => {
    const other = await runSso({
      sub: 's9',
      email: 'x@other.edu.pk',
      email_verified: true,
    });
    expect(other.searchParams.get('error')).toBe('domain_not_allowed');

    const unverified = await runSso({
      sub: 's10',
      email: `u@${DOMAIN}`,
      email_verified: false,
    });
    expect(unverified.searchParams.get('error')).toBe('email_not_verified');

    const faculty = await h.makeUser(UserRole.FACULTY, {
      email: `prof.${Date.now()}@${DOMAIN}`,
    });
    const notStudent = await runSso({
      sub: 's11',
      email: faculty.email,
      email_verified: true,
    });
    expect(notStudent.searchParams.get('error')).toBe('not_student');

    const elsewhere = await h.makeUser(UserRole.STUDENT, {
      email: `aku.${Date.now()}@${DOMAIN}`,
      overrides: { university: 'Aga Khan University' },
    });
    const notAffiliated = await runSso({
      sub: 's12',
      email: elsewhere.email,
      email_verified: true,
    });
    expect(notAffiliated.searchParams.get('error')).toBe('not_affiliated');
    const untouched = await h.ds
      .getRepository(User)
      .findOne({ where: { id: elsewhere.id } });
    expect(untouched?.ssoSubject).toBeNull();
  });

  it('a first-time student completes a short profile and gets an account linked to the identity', async () => {
    const email = `fresh.${Date.now()}@${DOMAIN}`;
    const done = await runSso({
      sub: 'new-1',
      email,
      email_verified: true,
      name: 'Fresh Student',
    });
    expect(done.searchParams.get('ticket')).toBeNull();
    const token = done.searchParams.get('signup');
    expect(token).toBeTruthy();
    expect(done.searchParams.get('email')).toBe(email);
    expect(done.searchParams.get('university')).toBe(GIFT);

    const missing = await h
      .as(null)
      .post('/auth/sso/complete')
      .send({ token, phone: '0300', department: '', acceptedTerms: false });
    expect(missing.status).toBe(400);

    const created = await h.as(null).post('/auth/sso/complete').send({
      token,
      phone: '03001234567',
      countryCode: '+92',
      department: 'Computer Science',
      registrationNumber: 'GIFT-2026-001',
      acceptedTerms: true,
    });
    expect(created.status).toBe(201);
    const session = (created.body as Body<Session>).data;
    expect(session.access_token).toBeTruthy();
    expect(session.user).toMatchObject({ email, role: 'student' });
    const row = await h.ds.getRepository(User).findOne({ where: { email } });
    expect(row).toMatchObject({
      name: 'Fresh Student',
      university: GIFT,
      institution: GIFT,
      department: 'Computer Science',
      registrationNumber: 'GIFT-2026-001',
      phone: '+923001234567',
      ssoIssuer: idp.baseUrl,
      ssoSubject: 'new-1',
    });
    expect(row?.termsAcceptedAt).toBeTruthy();
    expect(['active', 'pending_subscription_payment']).toContain(row?.status);

    // The same identity cannot be completed twice; signing in again just issues a ticket.
    expect(
      (
        await h.as(null).post('/auth/sso/complete').send({
          token,
          phone: '03001234567',
          department: 'CS',
          acceptedTerms: true,
        })
      ).status,
    ).toBe(409);
    const back = await runSso({ sub: 'new-1', email, email_verified: true });
    expect(back.searchParams.get('ticket')).toBeTruthy();
  });

  it('tampered state is refused; disabling the university or the platform switch stops sign-in', async () => {
    const bad = await h.as(null).get('/auth/sso/callback?code=x&state=forged');
    expect(bad.status).toBe(302);
    expect(new URL(bad.headers.location).searchParams.get('error')).toBe(
      'invalid_state',
    );

    const student = await h.makeUser(UserRole.STUDENT, {
      email: `late.${Date.now()}@${DOMAIN}`,
      overrides: { university: GIFT },
    });
    const done = await runSso({
      sub: 'late-1',
      email: student.email,
      email_verified: true,
    });
    const ticket = done.searchParams.get('ticket')!;

    const disabled = await h
      .as(admin)
      .post(`/admin/university-sso/${uni.id}/disable`)
      .send({});
    expect((disabled.body as Body<SsoView>).data.status).toBe('disabled');
    expect(
      (await h.as(null).get(`/auth/sso/start?university=${uni.id}`)).status,
    ).toBe(404);
    expect((await h.as(null).get('/auth/sso/universities')).body).toMatchObject(
      { data: [] },
    );
    // An already-issued ticket still exchanges (the student finished the flow before the switch).
    expect((await exchange(ticket)).status).toBe(201);

    await h.as(admin).post(`/admin/university-sso/${uni.id}/activate`).send({});
    expect(
      (await h.as(null).get(`/auth/sso/start?university=${uni.id}`)).status,
    ).toBe(302);
    await setSwitch(false);
    expect(
      (await h.as(null).get(`/auth/sso/start?university=${uni.id}`)).status,
    ).toBe(404);
    expect((await h.as(null).get('/auth/sso/universities')).body).toMatchObject(
      { data: [] },
    );

    // Removing the configuration needs it disabled first.
    expect(
      (await h.as(admin).del(`/admin/university-sso/${uni.id}`)).status,
    ).toBe(400);
    await h.as(admin).post(`/admin/university-sso/${uni.id}/disable`).send({});
    expect(
      (await h.as(admin).del(`/admin/university-sso/${uni.id}`)).status,
    ).toBe(200);
  });
});
