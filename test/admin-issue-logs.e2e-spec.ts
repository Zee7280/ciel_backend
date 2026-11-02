/**
 * Admin Issue Logs list stays small no matter how heavy the stored rows are: metadata and stack
 * are only returned by the detail route. (A 20-row page carrying full payloads exceeded the
 * serverless response limit in production and the screen showed "could not load".)
 */
import { UserRole } from '../src/users/enums/user-role.enum';
import { IssueLog } from '../src/issue-logs/entities/issue-log.entity';
import { bootHarness, Harness, E2eUser, uniq } from './e2e/harness';

describe('Admin issue logs (e2e)', () => {
  let h: Harness;
  let admin: E2eUser;
  let student: E2eUser;
  const MODULE = `e2e-reports-${uniq()}`;

  beforeAll(async () => {
    h = await bootHarness();
    admin = await h.makeUser(UserRole.SUPER_ADMIN);
    student = await h.makeUser(UserRole.STUDENT);
    const repo = h.ds.getRepository(IssueLog);
    const blob = 'x'.repeat(300 * 1024);
    for (let i = 0; i < 5; i += 1) {
      await repo.save(
        repo.create({
          eventType: 'exception',
          severity: 'error',
          module: MODULE,
          method: 'POST',
          path: `/api/v1/reports/${i}`,
          statusCode: 500,
          message: `heavy failure ${i}`,
          stack: 'Error: heavy\n    at x'.repeat(500),
          metadata: { payload: blob, i },
        } as Partial<IssueLog>),
      );
    }
  }, 120_000);

  afterAll(async () => {
    await h?.app.close();
  });

  it('list is a summary (no metadata / stack), detail carries them; students are refused', async () => {
    const res = await h
      .as(admin)
      .get('/admin/issue-logs?page=1&limit=20&resolved=open');
    expect(res.status).toBe(200);
    const body = res.body as {
      data: Record<string, unknown>[];
      meta: { total: number };
    };
    expect(body.meta.total).toBeGreaterThanOrEqual(5);
    const heavy = body.data.filter(
      (r) =>
        typeof r.message === 'string' && r.message.startsWith('heavy failure'),
    );
    expect(heavy.length).toBeGreaterThanOrEqual(5);
    for (const row of heavy) {
      expect(row).not.toHaveProperty('metadata');
      expect(row).not.toHaveProperty('stack');
      expect(row.hasMetadata).toBe(true);
      expect(row.hasStack).toBe(true);
    }
    expect(JSON.stringify(body).length).toBeLessThan(200 * 1024);

    const detail = await h
      .as(admin)
      .get(`/admin/issue-logs/${String(heavy[0].id)}`);
    expect(detail.status).toBe(200);
    const d = (detail.body as { data: Record<string, unknown> }).data;
    expect((d.metadata as { i: number }).i).toBeDefined();
    expect(String(d.stack)).toContain('Error: heavy');

    expect((await h.as(student).get('/admin/issue-logs')).status).toBe(403);
  });

  it('summary, CSV export, resolve + delete (single, resolved, older-than)', async () => {
    const sum = await h.as(admin).get('/admin/issue-logs/summary');
    expect(sum.status).toBe(200);
    const s = (sum.body as { data: Record<string, any> }).data;
    expect(s.open_total).toBeGreaterThanOrEqual(5);
    expect(
      (s.open_by_module as { key: string }[]).some((x) => x.key === MODULE),
    ).toBe(true);

    const csv = await h
      .as(admin)
      .get(`/admin/issue-logs/export?module=${MODULE}`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text.split('\n')[0]).toContain(
      'created_at,severity,status_code',
    );
    expect(csv.text).toContain('heavy failure 0');

    const list = (
      await h.as(admin).get(`/admin/issue-logs?module=${MODULE}&limit=50`)
    ).body as { data: { id: string }[] };
    const [a, b, ...rest] = list.data.map((r) => r.id);
    expect((await h.as(admin).del(`/admin/issue-logs/${a}`)).status).toBe(200);
    expect(
      (await h.as(admin).get(`/admin/issue-logs/${a}`)).body,
    ).toMatchObject({ success: false });
    expect(
      (
        await h
          .as(admin)
          .post('/admin/issue-logs/resolve')
          .send({ ids: [b] })
      ).status,
    ).toBe(201);
    const delResolved = await h
      .as(admin)
      .del('/admin/issue-logs')
      .send({ resolvedOnly: true });
    expect(
      (delResolved.body as { deleted: number }).deleted,
    ).toBeGreaterThanOrEqual(1);
    const delIds = await h
      .as(admin)
      .del('/admin/issue-logs')
      .send({ ids: rest });
    expect((delIds.body as { deleted: number }).deleted).toBe(rest.length);
    expect(
      (await h.as(admin).del('/admin/issue-logs').send({})).body,
    ).toMatchObject({ deleted: 0 });
    expect((await h.as(student).del(`/admin/issue-logs/${b}`)).status).toBe(
      403,
    );
  });
});
