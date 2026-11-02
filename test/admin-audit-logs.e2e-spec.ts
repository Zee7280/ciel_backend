/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
/**
 * Admin Audit Logs: every admin mutation leaves a summary row (no payload in the list), the
 * detail route carries the payload, summary / export / delete work, and deletion is itself audited.
 */
import { UserRole } from '../src/users/enums/user-role.enum';
import { bootHarness, Harness, E2eUser } from './e2e/harness';

type Row = Record<string, any>;

describe('Admin audit logs (e2e)', () => {
  let h: Harness;
  let admin: E2eUser;
  let student: E2eUser;

  beforeAll(async () => {
    h = await bootHarness();
    admin = await h.makeUser(UserRole.SUPER_ADMIN);
    student = await h.makeUser(UserRole.STUDENT);
  }, 120_000);

  afterAll(async () => {
    await h?.app.close();
  });

  it('records a mutation, lists it as a summary, serves details on demand, summarises, exports and deletes', async () => {
    // an audited admin mutation (user update) with a body
    const key = `Audit Test ${Date.now()}`;
    const write = await h
      .as(admin)
      .post(`/admin/users/${student.id}`)
      .send({ name: key, bio: 'x'.repeat(3000) });
    expect([200, 201]).toContain(write.status);

    const list = await h
      .as(admin)
      .get('/admin/audit-logs?limit=20&method=POST&path=/admin/users');
    expect(list.status).toBe(200);
    const rows = (list.body as { data: Row[] }).data;
    const mine = rows.find(
      (r) => r.user_email === admin.email && r.target === student.id,
    );
    expect(mine).toBeDefined();
    expect(mine).not.toHaveProperty('details');
    expect(mine!.has_details).toBe(true);
    expect(mine!.method).toBe('POST');
    expect(mine!.outcome).toBe('success');
    expect(mine!.target_label).toBe(key);

    const detail = await h
      .as(admin)
      .get(`/admin/audit-logs/${String(mine!.id)}`);
    expect(detail.status).toBe(200);
    const d = (detail.body as { data: Row }).data;
    expect(d.details.body.name).toBe(key);

    const search = await h
      .as(admin)
      .get(`/admin/audit-logs?search=${encodeURIComponent(key)}`);
    expect((search.body as { data: Row[] }).data.map((r) => r.id)).toContain(
      mine!.id,
    );
    const failures = await h.as(admin).get('/admin/audit-logs?outcome=failure');
    expect(
      (failures.body as { data: Row[] }).data.map((r) => r.id),
    ).not.toContain(mine!.id);

    const sum = await h.as(admin).get('/admin/audit-logs/summary');
    expect(sum.status).toBe(200);
    const s = (sum.body as { data: Row }).data;
    expect(s.total).toBeGreaterThanOrEqual(1);
    expect((s.by_method_7d as Row[]).some((x) => x.key === 'POST')).toBe(true);

    const csv = await h
      .as(admin)
      .get(`/admin/audit-logs/export?search=${encodeURIComponent(key)}`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text.split('\n')[0]).toContain('created_at,method,action');
    expect(csv.text).toContain(key);

    // purge by age refuses anything under the minimum window
    const purge = await h
      .as(admin)
      .del('/admin/audit-logs')
      .send({ olderThanDays: 1 });
    expect(purge.status).toBe(200);
    expect((purge.body as { deleted: number }).deleted).toBe(0);
    // delete one; the deletion itself is audited
    const del = await h.as(admin).del(`/admin/audit-logs/${String(mine!.id)}`);
    expect(del.status).toBe(200);
    expect(
      (await h.as(admin).get(`/admin/audit-logs/${String(mine!.id)}`)).status,
    ).toBe(404);
    const after = await h
      .as(admin)
      .get('/admin/audit-logs?method=DELETE&path=/admin/audit-logs');
    expect(
      (after.body as { data: Row[] }).data.some((r) => r.target === mine!.id),
    ).toBe(true);

    expect((await h.as(student).get('/admin/audit-logs')).status).toBe(403);
    expect(
      (await h.as(student).del(`/admin/audit-logs/${String(mine!.id)}`)).status,
    ).toBe(403);
  });
});
