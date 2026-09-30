import { Harness, E2eUser } from './harness';

/** ids visible on the public directory */
export async function publicIds(h: Harness): Promise<string[]> {
  const res = await h.as(null).get('/public/opportunities');
  expect(res.status).toBe(200);
  return (res.body.data as any[]).map((o) => o.id);
}

/** ids on the student browse list (`GET /students/opportunities`) */
export async function studentBrowseIds(h: Harness, student: E2eUser): Promise<string[]> {
  const res = await h.as(student).get('/students/opportunities?limit=200');
  expect(res.status).toBe(200);
  const rows: any[] = res.body?.data?.opportunities ?? res.body?.data ?? res.body?.opportunities ?? [];
  return rows.map((o) => o.id);
}

export async function adminQueueIds(h: Harness, admin: E2eUser, queue = 'pending'): Promise<string[]> {
  const res = await h.as(admin).get(`/admin/opportunities/approval-queue?queue=${queue}`);
  expect(res.status).toBe(200);
  return (res.body.data as any[]).map((o) => o.id);
}

export async function adminApprove(h: Harness, admin: E2eUser, id: string) {
  return h.as(admin).post(`/admin/opportunities/${id}/approve`).send({});
}

export async function detail(h: Harness, u: E2eUser | null, id: string) {
  return h.as(u).post('/opportunities/detail').send({ id });
}

const SECRET_KEYS = [
  'faculty_verification_token',
  'partnerToken',
  'liaisonToken',
  'execution_verification_token',
];

/** Recursively collect any non-null verification/magic-link secret keys in a JSON body. */
export function findSecrets(body: unknown, path = '$', out: string[] = []): string[] {
  if (Array.isArray(body)) {
    body.forEach((b, i) => findSecrets(b, `${path}[${i}]`, out));
  } else if (body && typeof body === 'object') {
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (SECRET_KEYS.includes(k) && typeof v === 'string' && v.length > 0 && v !== '[redacted]') out.push(`${path}.${k}`);
      findSecrets(v, `${path}.${k}`, out);
    }
  }
  return out;
}

export function expectNoSecrets(res: { body: unknown }, label = '') {
  const found = findSecrets(res.body);
  if (found.length) throw new Error(`secret token(s) leaked ${label}: ${found.join(', ')}`);
}

export const tokens = (o: any) => ({
  faculty: o.faculty_verification_token as string | null,
  partner: o.partnerToken as string | null,
  exec: o.execution_verification_token as string | null,
});

export async function verifyToken(h: Harness, token: string, user: E2eUser | null = null) {
  return h.as(user).post('/verifications/verify').send({ token });
}
