import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { getRepositoryToken } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { MailService } from '../../src/mail/mail.service';
import { User } from '../../src/users/entities/user.entity';
import { Organization } from '../../src/organizations/entities/organization.entity';
import { Opportunity } from '../../src/opportunities/entities/opportunity.entity';
import { UserRole } from '../../src/users/enums/user-role.enum';

export const API = '/api/v1';

/** Records every `send*` / `notify*` call the app would have made over SMTP. */
export class MailCapture {
  calls: { method: string; args: any[] }[] = [];
  reset() {
    this.calls = [];
  }
  of(method: string) {
    return this.calls.filter((c) => c.method === method);
  }
}

function makeMailMock(cap: MailCapture): MailService {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop === 'string' && /^(send|notify)/.test(prop)) {
          return async (...args: any[]) => {
            cap.calls.push({ method: prop, args });
            return true;
          };
        }
        return undefined;
      },
    },
  ) as unknown as MailService;
}

export type E2eUser = {
  id: string;
  email: string;
  role: UserRole;
  organizationId: string | null;
  token: string;
};

export type Harness = {
  app: INestApplication;
  ds: DataSource;
  mail: MailCapture;
  users: Repository<User>;
  orgs: Repository<Organization>;
  opps: Repository<Opportunity>;
  makeUser: (role: UserRole, opts?: MakeUserOpts) => Promise<E2eUser>;
  makeOrg: (name?: string, orgType?: string) => Promise<Organization>;
  sign: (u: { id: string; email: string; role: string; organizationId?: string | null }) => string;
  as: (u: E2eUser | null) => Api;
  reload: (id: string) => Promise<Opportunity>;
};

export type MakeUserOpts = {
  org?: Organization | null;
  email?: string;
  overrides?: Partial<User>;
};

export type Api = {
  get: (p: string) => request.Test;
  post: (p: string) => request.Test;
  patch: (p: string) => request.Test;
  put: (p: string) => request.Test;
  del: (p: string) => request.Test;
};

export const uniq = () => randomUUID().slice(0, 8);

export async function bootHarness(): Promise<Harness> {
  const mail = new MailCapture();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MailService)
    .useValue(makeMailMock(mail))
    .compile();
  const app = moduleRef.createNestApplication();
  // Same wiring as src/main.ts
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.setGlobalPrefix(API.replace(/^\//, ''));
  await app.init();

  const ds = app.get(DataSource);
  if (ds.options.database !== 'ciel_e2e_scratch') {
    await app.close();
    throw new Error(`e2e attached to unexpected DB "${String(ds.options.database)}"`);
  }
  const jwt = app.get(JwtService);
  const users = app.get<Repository<User>>(getRepositoryToken(User));
  const orgs = app.get<Repository<Organization>>(getRepositoryToken(Organization));
  const opps = app.get<Repository<Opportunity>>(getRepositoryToken(Opportunity));

  const sign: Harness['sign'] = (u) =>
    jwt.sign({
      sub: u.id,
      email: u.email,
      role: u.role,
      tokenVersion: 0,
      organizationId: u.organizationId ?? undefined,
    });

  const makeOrg: Harness['makeOrg'] = async (name, orgType = 'NGO') =>
    orgs.save(
      orgs.create({
        name: name ?? `Org ${uniq()}`,
        orgType,
        verificationStatus: 'APPROVED',
        contactName: 'Contact Person',
        contactPhone: '+923001112233',
      }),
    );

  const makeUser: Harness['makeUser'] = async (role, opts = {}) => {
    const s = uniq();
    const email = (opts.email ?? `${role}.${s}@e2e.test`).toLowerCase();
    const academic = [UserRole.STUDENT, UserRole.FACULTY, UserRole.UNIVERSITY].includes(role);
    const u = await users.save(
      users.create({
        name: `${role} ${s}`,
        email,
        password: 'x',
        role,
        status: 'active',
        phone: '+923001234567',
        city: academic ? 'Lahore' : undefined,
        university: academic ? 'E2E University' : undefined,
        department: role === UserRole.STUDENT ? 'Computer Science' : undefined,
        faculty_department: role === UserRole.FACULTY ? 'Computer Science' : undefined,
        organization: opts.org ?? undefined,
        ...(opts.overrides ?? {}),
      } as any) as unknown as User,
    );
    const organizationId = opts.org?.id ?? null;
    return {
      id: u.id,
      email,
      role,
      organizationId,
      token: sign({ id: u.id, email, role, organizationId }),
    };
  };

  const as: Harness['as'] = (u) => {
    const wrap = (fn: (p: string) => request.Test) => (p: string) => {
      const t = fn(p);
      return u ? t.set('Authorization', `Bearer ${u.token}`) : t;
    };
    const server = app.getHttpServer();
    return {
      get: wrap((p) => request(server).get(API + p)),
      post: wrap((p) => request(server).post(API + p)),
      patch: wrap((p) => request(server).patch(API + p)),
      put: wrap((p) => request(server).put(API + p)),
      del: wrap((p) => request(server).delete(API + p)),
    };
  };

  const reload = async (id: string) => {
    const o = await opps.findOne({ where: { id } });
    if (!o) throw new Error(`opportunity ${id} missing`);
    return o;
  };

  return { app, ds, mail, users, orgs, opps, makeUser, makeOrg, sign, as, reload };
}

const ALL_TRUE_SAFETY = {
  environment_safe_and_appropriate: true,
  students_guided_and_supervised: true,
  lawful_ethical_and_non_hazardous: true,
  precautions_and_basic_safety: true,
};
const ALL_TRUE_CONFIRM = {
  academically_valid_and_accurately_described: true,
  activity_properly_supervised: true,
  environment_safe_and_appropriate: true,
  information_correct_and_verifiable: true,
};

/** A payload that passes every create() gate for org / faculty / admin creators. */
export function oppPayload(over: Record<string, any> = {}): Record<string, any> {
  return {
    title: `E2E Opportunity ${uniq()}`,
    types: ['community_service'],
    mode: 'Remote',
    verification_method: ['attendance'],
    timeline: {
      type: 'fixed',
      start_date: '2027-01-10',
      end_date: '2027-02-10',
      expected_hours: 20,
      volunteers_required: 5,
    },
    sdg_info: { sdg_id: 'SDG4', target_id: '4.1', indicator_id: '4.1.1' },
    objectives: { description: 'E2E objective' },
    activity_details: { student_responsibilities: 'Help out' },
    visibility: 'public',
    safety_declaration: { ...ALL_TRUE_SAFETY },
    submission_confirmations: { ...ALL_TRUE_CONFIRM },
    ...over,
  };
}

/** Student wizard payload (faculty email in supervision.contact, own-university scope). */
export function studentPayload(facultyEmail: string, over: Record<string, any> = {}): Record<string, any> {
  return oppPayload({
    supervision: {
      contact: facultyEmail,
      supervisor_name: 'Dr Faculty',
      faculty_department: 'Computer Science',
      faculty_university_name: 'E2E University',
    },
    executing_context: {
      type: 'independent',
      independent_community_activity: { activity_site_description: 'Neighbourhood cleanup' },
    },
    participation_scope: { rule: 'own_university_only' },
    ...over,
  });
}
