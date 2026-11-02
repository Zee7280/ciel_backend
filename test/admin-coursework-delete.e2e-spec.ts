/**
 * Command Monitor clean-up: CIEL PK admin may delete a coursework record of any status; the
 * student loses it, and no other role may call the route.
 */
import { UserRole } from '../src/users/enums/user-role.enum';
import { bootHarness, Harness, E2eUser } from './e2e/harness';

const data = (res: { body: unknown }) =>
  (res.body as { data?: Record<string, unknown> }).data ?? {};

describe('Admin deletes coursework (e2e)', () => {
  let h: Harness;
  let admin: E2eUser;
  let student: E2eUser;
  let faculty: E2eUser;

  beforeAll(async () => {
    h = await bootHarness();
    admin = await h.makeUser(UserRole.SUPER_ADMIN);
    student = await h.makeUser(UserRole.STUDENT);
    faculty = await h.makeUser(UserRole.FACULTY);
  }, 120_000);

  afterAll(async () => {
    await h?.app.close();
  });

  it('admin deletes a draft; the student no longer sees it; others are refused', async () => {
    const created = await h.as(student).post('/paths/course-projects').send({});
    expect(created.status).toBe(201);
    const id = String(data(created).id);
    expect(
      (await h.as(student).get('/paths/course-projects')).body,
    ).toMatchObject({ success: true });

    expect(
      (await h.as(student).del(`/admin/paths/course-projects/${id}`)).status,
    ).toBe(403);
    expect(
      (await h.as(faculty).del(`/admin/paths/course-projects/${id}`)).status,
    ).toBe(403);

    const del = await h.as(admin).del(`/admin/paths/course-projects/${id}`);
    expect(del.status).toBe(200);
    expect(data(del)).toMatchObject({ id, status: 'draft' });

    const mine = (await h.as(student).get('/paths/course-projects')).body as {
      data: { id: string }[];
    };
    expect(mine.data.map((r) => r.id)).not.toContain(id);
    expect(
      (await h.as(admin).del(`/admin/paths/course-projects/${id}`)).status,
    ).toBe(404);
    expect(
      (await h.as(admin).del('/admin/paths/course-projects/not-a-uuid')).status,
    ).toBe(400);
  });
});
