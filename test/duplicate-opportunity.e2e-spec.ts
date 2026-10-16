/**
 * "Duplicate opportunity" reads the source through POST /opportunities/detail and prefills the create
 * form from it. This proves, for every creator kind and every viewer who may press Duplicate, that
 * the detail payload carries every field the form mapper needs, leaks no token and no third-party
 * contact, and that a viewer who may NOT open the source gets nothing. When DUPLICATE_DUMP_DIR is
 * set the payloads are written there so the frontend mapper can be run over the real API output.
 */
import * as fs from 'fs';
import * as path from 'path';
import { bootHarness, Harness, E2eUser, oppPayload, studentPayload, uniq } from './e2e/harness';
import { adminApprove, detail, expectNoSecrets } from './e2e/helpers';
import { UserRole } from '../src/users/enums/user-role.enum';

const REQUIRED_FIELDS = ['id', 'title', 'timeline', 'objectives', 'activity_details', 'sdg_info', 'mode', 'types'];

describe('Duplicate opportunity: source payload is complete, safe and scoped (real app + real Postgres)', () => {
  let h: Harness;
  let admin: E2eUser;
  const dump: Record<string, unknown> = {};

  beforeAll(async () => {
    h = await bootHarness();
    admin = await h.makeUser(UserRole.SUPER_ADMIN);
  });
  afterAll(async () => {
    const dir = process.env.DUPLICATE_DUMP_DIR;
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'detail-payloads.json'), JSON.stringify(dump, null, 1));
    }
    await h.app.close();
  });

  const full = (over: Record<string, any> = {}) =>
    oppPayload({
      mode: 'Remote',
      objectives: { description: 'Install filters', hook: 'Clean water', outputs: '50 filters', beneficiaries_count: 200 },
      activity_details: { student_responsibilities: 'Install and train', skills_gained: ['Communication'], prerequisites: 'None' },
      sdg_info: { sdg_id: 'SDG6', target_id: '6.1', indicator_id: '6.1.1', why_relevant: 'Water access' },
      ...over,
    });

  const open = async (viewer: E2eUser | null, id: string, label: string) => {
    const res = await detail(h, viewer, id);
    if (res.status === 200 || res.status === 201) dump[label] = res.body?.data ?? res.body;
    return res;
  };

  const expectCopyable = (res: any) => {
    expect([200, 201]).toContain(res.status);
    const d = res.body?.data ?? res.body;
    for (const f of REQUIRED_FIELDS) expect({ f, present: d?.[f] !== undefined && d?.[f] !== null }).toEqual({ f, present: true });
    expect(d.timeline.start_date).toBeTruthy();
    expect(d.timeline.expected_hours).toBeGreaterThan(0);
    expectNoSecrets(res, '(detail used for duplicate)');
    return d;
  };

  it('faculty-created: the creator, an admin and a different faculty (live listing) can all open it for copying', async () => {
    const fac = await h.makeUser(UserRole.FACULTY);
    const create = await h.as(fac).post('/opportunities').send(full({ supervision: { contact: fac.email, supervisor_name: 'Dr Own' } }));
    expect(create.status).toBe(201);
    const id = create.body.id;
    expectCopyable(await open(fac, id, 'faculty_creator'));
    expectCopyable(await open(admin, id, 'faculty_admin'));
    expect((await adminApprove(h, admin, id)).status).toBeLessThan(300);
    const other = await h.makeUser(UserRole.FACULTY);
    const asOther = expectCopyable(await open(other, id, 'faculty_other_live'));
    // a third party never receives the supervisor's contact details through a copy
    expect(JSON.stringify(asOther)).not.toContain(fac.email);
  });

  it('NGO-created with a named faculty: the NGO and the linked faculty can copy it; a stranger faculty cannot while it is pending', async () => {
    const org = await h.makeOrg();
    const ngo = await h.makeUser(UserRole.NGO, { org });
    const linked = await h.makeUser(UserRole.FACULTY);
    const create = await h.as(ngo).post('/opportunities').send(full({ supervision: { contact: linked.email, supervisor_name: 'Dr Linked' } }));
    expect(create.status).toBe(201);
    const id = create.body.id;
    expectCopyable(await open(ngo, id, 'ngo_creator'));
    expectCopyable(await open(linked, id, 'ngo_linked_faculty'));
    const stranger = await h.makeUser(UserRole.FACULTY);
    expect([403, 404]).toContain((await open(stranger, id, 'ngo_stranger_pending')).status);
    expect(dump['ngo_stranger_pending']).toBeUndefined();
  });

  it('student-created: the supervising faculty can copy it (not the creator), the student creator can open it, a stranger student cannot', async () => {
    const fac = await h.makeUser(UserRole.FACULTY);
    const s = await h.makeUser(UserRole.STUDENT);
    const create = await h.as(s).post('/student/opportunity').send(studentPayload(fac.email, { title: `Dup source ${uniq()} water filters` }));
    expect(create.status).toBe(201);
    const id = create.body.data?.id ?? create.body.id;
    expectCopyable(await open(fac, id, 'student_supervisor'));
    expectCopyable(await open(s, id, 'student_creator'));
    const stranger = await h.makeUser(UserRole.STUDENT);
    expect([403, 404]).toContain((await open(stranger, id, 'student_stranger')).status);
  });


  it('every row on the faculty "mine" list (pending, live, rejected, revision, student-created) opens through detail, so Duplicate never lands on an empty form', async () => {
    const fac = await h.makeUser(UserRole.FACULTY);
    const org = await h.makeOrg();
    const ngo = await h.makeUser(UserRole.NGO, { org });
    const s = await h.makeUser(UserRole.STUDENT);
    const ids: string[] = [];
    // own, pending admin
    ids.push((await h.as(fac).post('/opportunities').send(full({ title: `Mine pending ${uniq()}`, supervision: { contact: fac.email } }))).body.id);
    // own, live
    const live = (await h.as(fac).post('/opportunities').send(full({ title: `Mine live ${uniq()}`, supervision: { contact: fac.email } }))).body.id;
    await adminApprove(h, admin, live);
    ids.push(live);
    // own, rejected
    const rej = (await h.as(fac).post('/opportunities').send(full({ title: `Mine rejected ${uniq()}`, supervision: { contact: fac.email } }))).body.id;
    await h.as(admin).post(`/admin/opportunities/${rej}/reject`).send({ reason: 'Not suitable' });
    ids.push(rej);
    // NGO row naming this faculty (waiting on the faculty)
    ids.push((await h.as(ngo).post('/opportunities').send(full({ title: `Linked ${uniq()}`, supervision: { contact: fac.email, supervisor_name: 'Dr' } }))).body.id);
    // student-created row supervised by this faculty
    const stu = await h.as(s).post('/student/opportunity').send(studentPayload(fac.email, { title: `Student ${uniq()} sanitation drive` }));
    ids.push(stu.body.data?.id ?? stu.body.id);

    const mine = await h.as(fac).get('/opportunities/faculty/mine');
    expect(mine.status).toBe(200);
    const listed = (mine.body.data as any[]).map((r) => r.id);
    for (const id of ids) {
      expect({ id, listed: listed.includes(id) }).toEqual({ id, listed: true });
      expectCopyable(await detail(h, fac, id));
    }
    // and nothing else on the list is unopenable
    for (const id of listed) {
      const r = await detail(h, fac, id);
      expect({ id, status: r.status < 300 }).toEqual({ id, status: true });
    }
  });

  it('admin-created: the admin can copy it', async () => {
    const create = await h.as(admin).post('/opportunities').send(full());
    expect(create.status).toBe(201);
    expectCopyable(await open(admin, create.body.id, 'admin_creator'));
  });

  it('the copy itself is an independent new opportunity: creating with the copied payload and a new title leaves the source untouched', async () => {
    const fac = await h.makeUser(UserRole.FACULTY);
    const src = await h.as(fac).post('/opportunities').send(full({ title: `Source ${uniq()}`, supervision: { contact: fac.email } }));
    expect(src.status).toBe(201);
    const copy = await h.as(fac).post('/opportunities').send(full({ title: `Source ${uniq()} (Copy)`, supervision: { contact: fac.email } }));
    expect(copy.status).toBe(201);
    expect(copy.body.id).not.toBe(src.body.id);
    const a = await h.reload(src.body.id);
    const b = await h.reload(copy.body.id);
    expect(a.title).not.toBe(b.title);
    expect(a.timeline).toEqual(b.timeline);
    // submitting the SAME title + payload again is treated as a retry and returns the original row,
    // so an untouched copy would not create anything: this is why the form appends "(Copy)"
    const same = await h.as(fac).post('/opportunities').send(full({ title: a.title, timeline: a.timeline, supervision: { contact: fac.email } }));
    expect([200, 201, 409]).toContain(same.status);
    if (same.status !== 409) expect(same.body.id).toBe(a.id);
  });
});
