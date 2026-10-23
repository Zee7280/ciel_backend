import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { FacultyUniversityScopeService } from './faculty-university-scope.service';
import { FacultyUniversityScopeAssignment } from './entities/faculty-university-scope-assignment.entity';
import { User } from '../users/entities/user.entity';
import { Organization } from '../organizations/entities/organization.entity';
import { UserRole } from '../users/enums/user-role.enum';
import { universityNameMatchSql } from '../opportunities/university-scope.util';

const BNU: Pick<Organization, 'id' | 'name' | 'orgType'> = {
  id: 'org-bnu',
  name: 'Beaconhouse National University (BNU)',
  orgType: 'UNIVERSITY',
};
const LUMS: Pick<Organization, 'id' | 'name' | 'orgType'> = {
  id: 'org-lums',
  name: 'Lahore University of Management Sciences (LUMS)',
  orgType: 'UNIVERSITY',
};

function student(fields: Partial<User>): User {
  return { id: 's1', role: UserRole.STUDENT, ...fields } as User;
}

function build(opts: {
  assignment?: Partial<FacultyUniversityScopeAssignment> | null;
  users?: Record<string, Partial<User>>;
  orgs?: Record<string, Pick<Organization, 'id' | 'name' | 'orgType'>>;
  linkedCount?: number;
  seats?: Array<{ universityName?: string; universityId?: string }>;
}) {
  const users = opts.users ?? {};
  const orgs = opts.orgs ?? { [BNU.id]: BNU, [LUMS.id]: LUMS };
  const assignmentRepo = {
    findOne: jest.fn(() => Promise.resolve(opts.assignment ?? null)),
    save: jest.fn((row: unknown) => Promise.resolve(row)),
    create: jest.fn((row: unknown) => row),
  };
  const usersRepo = {
    findOne: jest.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve(users[where.id] ?? null),
    ),
    count: jest.fn(() => Promise.resolve(opts.linkedCount ?? 0)),
    createQueryBuilder: jest.fn(() => {
      let email = '';
      const qb = {
        where: (_sql: string, p: { email: string }) => {
          email = p.email;
          return qb;
        },
        getOne: () =>
          Promise.resolve(
            Object.values(users).find(
              (u) => (u.email || '').toLowerCase() === email,
            ) ?? null,
          ),
      };
      return qb;
    }),
  };
  const orgRepo = {
    findOne: jest.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve(orgs[where.id] ?? null),
    ),
  };
  const participationRepo = {
    find: jest.fn(() => Promise.resolve(opts.seats ?? [])),
  };
  const service = new FacultyUniversityScopeService(
    assignmentRepo as never,
    usersRepo as never,
    orgRepo as never,
    participationRepo as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, assignmentRepo, usersRepo, participationRepo };
}

describe('FacultyUniversityScopeService — student ↔ university matching', () => {
  const { service } = build({});

  it.each([
    'Beaconhouse National University (BNU)',
    'beaconhouse national university (bnu) ',
    'BNU',
    ' bnu ',
    'Beaconhouse  National University (BNU)',
    'Beaconhouse-National-University (BNU)',
  ])('matches a BNU student whose profile says %j', (university) => {
    expect(
      service.studentProfileMatchesOrganization(
        student({ university }),
        BNU.name,
      ),
    ).toBe(true);
  });

  it('also matches on the institution field', () => {
    expect(
      service.studentProfileMatchesOrganization(
        student({ university: '', institution: 'BNU' }),
        BNU.name,
      ),
    ).toBe(true);
  });

  it.each(['LUMS', 'Beaconhouse National University, Lahore', 'UET', ''])(
    'does not match %j',
    (university) => {
      expect(
        service.studentProfileMatchesOrganization(
          student({ university }),
          BNU.name,
        ),
      ).toBe(false);
    },
  );

  it('never matches a non-student account', () => {
    expect(
      service.studentProfileMatchesOrganization(
        student({ role: UserRole.FACULTY, university: 'BNU' }),
        BNU.name,
      ),
    ).toBe(false);
  });

  it('accepts the already-normalised name some callers pass (faculty-reports)', () => {
    expect(
      service.studentProfileMatchesOrganization(
        student({ university: 'BNU' }),
        service.normalizeOrgName(BNU.name),
      ),
    ).toBe(true);
  });
});

describe('FacultyUniversityScopeService — studentBelongsToOrganization', () => {
  it('profile match needs no DB lookup', async () => {
    const { service, usersRepo } = build({});
    await expect(
      service.studentBelongsToOrganization(student({ university: 'BNU' }), BNU),
    ).resolves.toBe(true);
    expect(usersRepo.count).not.toHaveBeenCalled();
  });

  it('a loaded organization link decides without a DB lookup', async () => {
    const { service, usersRepo } = build({});
    const linked = student({
      university: 'Something else',
      organization: { id: BNU.id } as Organization,
    });
    await expect(
      service.studentBelongsToOrganization(linked, BNU),
    ).resolves.toBe(true);
    await expect(
      service.studentBelongsToOrganization(linked, LUMS),
    ).resolves.toBe(false);
    expect(usersRepo.count).not.toHaveBeenCalled();
  });

  it('falls back to the stored organization link when it is not loaded', async () => {
    const yes = build({ linkedCount: 1 });
    await expect(
      yes.service.studentBelongsToOrganization(
        student({ university: '' }),
        BNU,
      ),
    ).resolves.toBe(true);
    expect(yes.usersRepo.count).toHaveBeenCalledWith({
      where: { id: 's1', organization: { id: BNU.id } },
    });
    const no = build({ linkedCount: 0 });
    await expect(
      no.service.studentBelongsToOrganization(student({ university: '' }), BNU),
    ).resolves.toBe(false);
  });

  it("a blank profile is completed by the university on the student's project seat", async () => {
    const { service } = build({
      seats: [{ universityName: 'Beaconhouse National University (BNU)' }],
    });
    await expect(
      service.studentBelongsToOrganization(student({ university: '' }), BNU),
    ).resolves.toBe(true);
  });

  it('a profile naming another listed university wins over a seat claim', async () => {
    const { service, participationRepo } = build({
      seats: [{ universityName: 'Beaconhouse National University (BNU)' }],
    });
    await expect(
      service.studentBelongsToOrganization(
        student({
          university: 'Lahore University of Management Sciences (LUMS)',
        }),
        BNU,
      ),
    ).resolves.toBe(false);
    expect(participationRepo.find).not.toHaveBeenCalled();
  });

  it('rejects missing students and non-students', async () => {
    const { service } = build({ linkedCount: 1 });
    await expect(service.studentBelongsToOrganization(null, BNU)).resolves.toBe(
      false,
    );
    await expect(
      service.studentBelongsToOrganization(
        student({ role: UserRole.FACULTY, university: 'BNU' }),
        BNU,
      ),
    ).resolves.toBe(false);
  });
});

describe('FacultyUniversityScopeService — delegate review uses the same identity as visibility', () => {
  it('no assignment → cannot review', async () => {
    const { service } = build({ assignment: null });
    await expect(
      service.canFacultyReviewApplicationAsUniversityDelegate(
        'f1',
        student({ university: 'BNU' }),
      ),
    ).resolves.toBe(false);
  });

  it('BNU delegate can review "BNU" and org-linked students, not LUMS students', async () => {
    const assignment = { universityOrganization: BNU as Organization };
    const { service } = build({ assignment, linkedCount: 0 });
    await expect(
      service.canFacultyReviewApplicationAsUniversityDelegate(
        'f1',
        student({ university: 'BNU' }),
      ),
    ).resolves.toBe(true);
    await expect(
      service.canFacultyReviewApplicationAsUniversityDelegate(
        'f1',
        student({
          university: '',
          organization: { id: BNU.id } as Organization,
        }),
      ),
    ).resolves.toBe(true);
    await expect(
      service.canFacultyReviewApplicationAsUniversityDelegate(
        'f1',
        student({ university: 'LUMS' }),
      ),
    ).resolves.toBe(false);
  });
});

describe('FacultyUniversityScopeService — university operator assignment', () => {
  const faculty = {
    id: 'fac1',
    email: 'dr.ali@bnu.edu.pk',
    role: UserRole.FACULTY,
  };
  const bnuOperator = {
    id: 'op-bnu',
    role: UserRole.UNIVERSITY,
    organization: BNU as Organization,
  };
  const lumsOperator = {
    id: 'op-lums',
    role: UserRole.UNIVERSITY,
    organization: LUMS as Organization,
  };
  const users = {
    [faculty.id]: faculty,
    [bnuOperator.id]: bnuOperator,
    [lumsOperator.id]: lumsOperator,
  };

  it('authorises an unassigned faculty for the operator university', async () => {
    const { service, assignmentRepo } = build({ users, assignment: null });
    const saved = await service.assignByUniversityOperator({
      facultyEmail: 'Dr.Ali@BNU.edu.pk',
      universityOrganizationId: BNU.id,
      operatorUserId: bnuOperator.id,
    });
    expect(saved.universityOrganization).toBe(BNU);
    expect(assignmentRepo.save).toHaveBeenCalledTimes(1);
  });

  it('refuses a faculty whose profile names another listed university', async () => {
    const lumsFaculty = {
      id: 'fac-lums',
      email: 'dr.sara@lums.edu.pk',
      role: UserRole.FACULTY,
      university: 'Lahore University of Management Sciences (LUMS)',
    };
    const { service, assignmentRepo } = build({
      users: { ...users, [lumsFaculty.id]: lumsFaculty },
      assignment: null,
    });
    await expect(
      service.assignByUniversityOperator({
        facultyEmail: lumsFaculty.email,
        universityOrganizationId: BNU.id,
        operatorUserId: bnuOperator.id,
      }),
    ).rejects.toThrow(BadRequestException);
    expect(assignmentRepo.save).not.toHaveBeenCalled();
  });

  it('re-confirming its own faculty changes nothing and keeps the original grantor', async () => {
    const admin = { id: 'adm', role: UserRole.SUPER_ADMIN } as User;
    const existing = {
      universityOrganization: BNU as Organization,
      assignedByAdmin: admin,
    };
    const { service, assignmentRepo } = build({ users, assignment: existing });
    const saved = await service.assignByUniversityOperator({
      facultyEmail: faculty.email,
      universityOrganizationId: BNU.id,
      operatorUserId: bnuOperator.id,
    });
    expect(saved.universityOrganization).toBe(BNU);
    expect(saved.assignedByAdmin).toBe(admin);
    expect(assignmentRepo.save).not.toHaveBeenCalled();
  });

  it('cannot take over a faculty already authorised for another university', async () => {
    const existing = {
      universityOrganization: BNU as Organization,
      assignedByAdmin: null,
    };
    const { service, assignmentRepo } = build({ users, assignment: existing });
    await expect(
      service.assignByUniversityOperator({
        facultyEmail: faculty.email,
        universityOrganizationId: LUMS.id,
        operatorUserId: lumsOperator.id,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(assignmentRepo.save).not.toHaveBeenCalled();
    expect(existing.universityOrganization).toBe(BNU);
  });

  it('an operator still cannot act for a university it does not belong to', async () => {
    const { service } = build({ users, assignment: null });
    await expect(
      service.assignByUniversityOperator({
        facultyEmail: faculty.email,
        universityOrganizationId: BNU.id,
        operatorUserId: lumsOperator.id,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a CIEL PK admin can still move a faculty between universities', async () => {
    const admin = { id: 'adm', role: UserRole.SUPER_ADMIN };
    const existing = {
      universityOrganization: BNU as Organization,
      assignedByAdmin: null,
    };
    const { service } = build({
      users: { ...users, [admin.id]: admin },
      assignment: existing,
    });
    const saved = await service.assign({
      facultyUserId: faculty.id,
      universityOrganizationId: LUMS.id,
      assignedByAdminId: admin.id,
    });
    expect(saved.universityOrganization).toBe(LUMS);
  });
});

describe('universityNameMatchSql', () => {
  it('an empty name matches nothing', () => {
    expect(universityNameMatchSql('u.university', '  ', 'p')).toEqual({
      sql: 'FALSE',
      params: {},
    });
  });

  it('binds the folded name and its bracketed abbreviation under unique names', () => {
    const m = universityNameMatchSql('u.university', BNU.name, 'scope');
    expect(m.params).toEqual({
      scopeKeys: ['beaconhouse national university bnu', 'bnu'],
      scopeFull: 'beaconhouse national university bnu',
    });
    expect(m.sql).toContain(':...scopeKeys');
    expect(m.sql).toContain(':scopeFull');
  });
});

describe('FacultyUniversityScopeService — university report scope', () => {
  const scope = {
    org: { id: BNU.id, name: BNU.name },
    studentIds: new Set(['bnu-student']),
    opportunityIds: new Set(['shared-opp', 'bnu-own-opp']),
    institutionalOpportunityIds: new Set(['bnu-own-opp']),
    affiliatedTeamKeys: new Set(['shared-opp|t:team-mixed']),
  };
  const build2 = (seats: Array<Record<string, string>>) => {
    const participationRepo = { find: jest.fn(() => Promise.resolve(seats)) };
    const service = new FacultyUniversityScopeService(
      {} as never,
      {} as never,
      {} as never,
      participationRepo as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return service;
  };

  it("keeps its own students' reports, institutional projects, and mixed teams — not other schools' students", async () => {
    const service = build2([
      {
        studentId: 'lums-lead',
        projectId: 'shared-opp',
        teamId: 'team-mixed',
      },
      { studentId: 'lums-solo', projectId: 'shared-opp', teamId: 'team-lums' },
    ]);
    const kept = await service.filterReportsToUniversityScope(scope, [
      { studentId: 'bnu-student', opportunityId: 'shared-opp' },
      { studentId: 'anyone', opportunityId: 'bnu-own-opp' },
      { studentId: 'lums-lead', opportunityId: 'shared-opp' },
      { studentId: 'lums-solo', opportunityId: 'shared-opp' },
      { studentId: 'bnu-student', opportunityId: 'not-in-scope' },
    ]);
    expect(kept.map((r) => `${r.studentId}@${r.opportunityId}`)).toEqual([
      'bnu-student@shared-opp',
      'anyone@bnu-own-opp',
      'lums-lead@shared-opp',
    ]);
  });
});
