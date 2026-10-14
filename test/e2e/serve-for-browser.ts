/**
 * Boots the real app on :3001 against the e2e scratch DB (never the dev DB), seeds a student +
 * two live opportunities, writes tokens/ids to OUT, and streams every OTP code to OTP_LOG so a
 * browser test can complete the teammate verification. Mail is captured, not sent.
 */
import './e2e-env';
import { writeFileSync, appendFileSync } from 'fs';
import { bootHarness, oppPayload } from './harness';
import { adminApprove } from './helpers';
import { UserRole } from '../../src/users/enums/user-role.enum';
import { Otp } from '../../src/students/entities/otp.entity';
import { Participation } from '../../src/engagement/entities/participant.entity';
import { Client } from 'pg';

const OUT = process.env.OUT || '/tmp/serve-for-browser.json';
const OTP_LOG = process.env.OTP_LOG || '/tmp/serve-for-browser-otps.log';
const BNU = 'Beaconhouse National University (BNU)';
const day = (d: number) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

async function freshScratchDb() {
  const c = new Client({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: 'postgres',
  });
  await c.connect();
  try {
    await c.query('DROP DATABASE IF EXISTS ciel_e2e_scratch WITH (FORCE)');
    await c.query('CREATE DATABASE ciel_e2e_scratch');
  } finally {
    await c.end();
  }
}

(async () => {
  await freshScratchDb();
  const h = await bootHarness();
  const admin = await h.makeUser(UserRole.SUPER_ADMIN);
  const org = await h.makeOrg('Browser NGO');
  const ngo = await h.makeUser(UserRole.NGO, { org });

  const liveOpp = async (title: string, scope: Record<string, unknown>) => {
    const res = await h.as(ngo).post('/opportunities').send(oppPayload({ title }));
    if (res.status !== 201) throw new Error(`create failed ${res.status} ${JSON.stringify(res.body)}`);
    await adminApprove(h, admin, res.body.id);
    await h.opps.update(res.body.id, {
      status: 'active',
      workflowStage: 'live',
      admin_approved: true,
      timeline: { type: 'fixed', start_date: day(-3), end_date: day(30), expected_hours: 20, volunteers_required: 4 },
      participation_scope: scope,
    } as any);
    return res.body.id as string;
  };

  const scopedId = await liveOpp('Browser Scoped (BNU only)', { rule: 'own_university_only', creator_university_name: BNU, university_names: [BNU] });
  const openId = await liveOpp('Browser Open', { rule: 'open_all_universities' });

  const lead = await h.makeUser(UserRole.STUDENT, {
    overrides: { name: 'Zubair Student', university: 'BNU', phone: '+923038444425', cnic: null } as any,
  });
  // Lead with an approved team seat on the open project (for the report Section 1 teammate flow).
  const reportLead = await h.makeUser(UserRole.STUDENT, {
    overrides: { name: 'Report Lead', university: 'BNU', phone: '+923031111111', cnic: null } as any,
  });
  const parts = h.ds.getRepository(Participation);
  const teamId = 'TM-2026-BROWSER-SEED';
  await parts.save(
    parts.create({
      projectId: scopedId,
      studentId: reportLead.id,
      email: reportLead.email,
      fullName: 'Report Lead',
      mobile: '+923031111111',
      cnic: 'enc',
      cnicHash: 'hash-report-lead',
      cnicLast4: '0000',
      universityId: 'bnu',
      universityName: BNU,
      academicProgram: 'BS CS',
      yearOfStudy: '3rd Year',
      department: 'Computer Science',
      academicIntegrationType: 'Voluntary',
      emailVerified: true,
      mobileVerified: true,
      status: 'approved',
      participationMode: 'team',
      isTeamLead: true,
      teamId,
    } as any),
  );

  const userJson = (u: { id: string; email: string }, name: string, phone: string) => ({
    id: u.id,
    userId: u.id,
    name,
    email: u.email,
    role: 'student',
    university: 'BNU',
    institution: 'BNU',
    department: 'Computer Science',
    phone,
    status: 'active',
  });

  writeFileSync(
    OUT,
    JSON.stringify(
      {
        lead: { token: lead.token, user: userJson(lead, 'Zubair Student', '+923038444425') },
        reportLead: { token: reportLead.token, user: userJson(reportLead, 'Report Lead', '+923031111111'), teamId },
        scopedId,
        openId,
      },
      null,
      2,
    ),
  );
  writeFileSync(OTP_LOG, '');
  await h.app.listen(3001);
  console.log(`READY :3001 → ${OUT}`);

  const seen = new Map<string, string>();
  const otps = h.ds.getRepository(Otp);
  setInterval(async () => {
    try {
      for (const r of await otps.find()) {
        if (r.otp && seen.get(r.email) !== r.otp) {
          seen.set(r.email, r.otp);
          appendFileSync(OTP_LOG, `${r.email} ${r.otp}\n`);
        }
      }
    } catch {}
  }, 700);
})().catch((e) => {
  console.error('serve-for-browser failed', e);
  process.exit(1);
});
