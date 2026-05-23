import { randomUUID } from 'crypto';

/** Reserved domain for unit tests — not real inboxes. */
export const TEST_EMAIL_DOMAIN = 'test.invalid';

let sequence = 0;

function nextTag(label: string): string {
    sequence += 1;
    const slug = label.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'case';
    return `${slug}-${sequence}-${randomUUID().slice(0, 8)}`;
}

export function testEmail(localPart: string): string {
    return `${localPart}@${TEST_EMAIL_DOMAIN}`.toLowerCase();
}

export function normalizeTestEmail(value: string): string {
    return value.trim().toLowerCase();
}

/** Mixed-case faculty email for normalization assertions. */
export function testEmailMixedCase(localPart: string): string {
    const tag = localPart.replace(/[^a-z0-9-]/gi, '');
    const head = tag.slice(0, 1).toUpperCase() || 'F';
    const tail = tag.slice(1) || 'aculty';
    return `${head}${tail}@${TEST_EMAIL_DOMAIN}`;
}

export type EngagementSpecContext = ReturnType<typeof engagementSpecContext>;

/**
 * Per-test identities (emails + ids) so specs never hard-code production-like addresses.
 */
export function engagementSpecContext(label = 'case') {
    const tag = nextTag(label);

    const email = {
        faculty: testEmail(`faculty-${tag}`),
        cofaculty: testEmail(`cofaculty-${tag}`),
        facultyMixed: testEmailMixedCase(`faculty-${tag}`),
        student: testEmail(`student-${tag}`),
        partner: testEmail(`partner-${tag}`),
        partnerOrg: testEmail(`partner-org-${tag}`),
        orgHostContact: testEmail(`org-host-${tag}`),
        linkedFaculty: testEmail(`linked-faculty-${tag}`),
        victim: testEmail(`victim-${tag}`),
        attacker: testEmail(`attacker-${tag}`),
        evilFaculty: testEmail(`evil-faculty-${tag}`),
        supervisor: testEmail(`supervisor-${tag}`),
        member: testEmail(`member-${tag}`),
        rosterMember: testEmail(`roster-member-${tag}`),
        ngoOwner: testEmail(`ngo-owner-${tag}`),
        existing: testEmail(`existing-${tag}`),
        newParticipant: testEmail(`new-participant-${tag}`),
    };

    const id = {
        faculty: `faculty-${tag}`,
        facultyUser: `faculty-user-${tag}`,
        student: `student-${tag}`,
        partner: `partner-${tag}`,
        partnerUser: `partner-user-${tag}`,
        partnerActor: `partner-actor-${tag}`,
        project: `proj-${tag}`,
        org: `org-${tag}`,
        u1: `u1-${tag}`,
        u2: `u2-${tag}`,
        participation: `p1-${tag}`,
        app: `app1-${tag}`,
        linkedFaculty: `linked-faculty-${tag}`,
        lead: `lead-${tag}`,
        member: `member-${tag}`,
        participationMetrics: `participation-${tag}`,
        projectRoster: `proj-roster-${tag}`,
        teamId: `team-${tag}`,
    };

    return {
        tag,
        email,
        id,
        name: {
            faculty: `Faculty ${tag}`,
            student: `Student ${tag}`,
            partner: `Partner ${tag}`,
            studentDisplay: `Student Display ${tag}`,
            partnerContact: `Partner Contact ${tag}`,
            teamMember: `Team Member ${tag}`,
        },
        title: `Project ${tag}`,
        projectTitlePartner: `Partner Project ${tag}`,
        projectTitleStudent: `Student Project ${tag}`,
    };
}

export function buildFacultyUserQueryBuilder(fx: EngagementSpecContext) {
    return {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue({
            id: fx.id.faculty,
            email: fx.email.faculty,
            role: 'faculty',
            name: fx.name.faculty,
        }),
    };
}

type UserQueryBuilderMock = {
    createQueryBuilder: jest.Mock;
};

/** Partner email lookups first, then faculty user — avoids `mockReturnValueOnce` leaking across tests. */
export function mockSequentialPartnerThenFacultyQueryBuilders(
    mockUserRepository: UserQueryBuilderMock,
    options: {
        facultyUser: { id: string; email: string };
        partnerLookupCount?: number;
    },
) {
    mockUserRepository.createQueryBuilder.mockReset();

    const partnerQb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        leftJoin: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
    };
    const facultyQb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue({
            id: options.facultyUser.id,
            email: options.facultyUser.email,
            role: 'faculty',
        }),
    };

    let call = 0;
    const partnerCount = options.partnerLookupCount ?? 2;
    mockUserRepository.createQueryBuilder.mockImplementation(() => {
        call += 1;
        return (call <= partnerCount ? partnerQb : facultyQb) as never;
    });

    return { partnerQb, facultyQb };
}

/** Route TypeORM QB chains by whether the query targets faculty vs partner lookup. */
export function mockRoleAwareUserQueryBuilders(
    mockUserRepository: UserQueryBuilderMock,
    handlers: {
        faculty?: () => Record<string, unknown> | null;
        partner?: () => Record<string, unknown> | null;
    },
) {
    mockUserRepository.createQueryBuilder.mockReset();
    mockUserRepository.createQueryBuilder.mockImplementation(() => {
        const chain: {
            _mode: 'faculty' | 'partner';
            where: jest.Mock;
            andWhere: jest.Mock;
            leftJoin: jest.Mock;
            orderBy: jest.Mock;
            getOne: jest.Mock;
        } = {
            _mode: 'partner',
            where: jest.fn(),
            andWhere: jest.fn(),
            leftJoin: jest.fn(),
            orderBy: jest.fn(),
            getOne: jest.fn(),
        };
        chain.where.mockReturnValue(chain);
        chain.leftJoin.mockReturnValue(chain);
        chain.orderBy.mockReturnValue(chain);
        chain.andWhere.mockImplementation((...args: unknown[]) => {
            const serialized = JSON.stringify(args);
            if (serialized.includes('faculty')) {
                chain._mode = 'faculty';
            }
            return chain;
        });
        chain.getOne.mockImplementation(() => {
            if (chain._mode === 'faculty') {
                return Promise.resolve(handlers.faculty?.() ?? null);
            }
            return Promise.resolve(handlers.partner?.() ?? null);
        });
        return chain as never;
    });
}

export const standardAttendanceDto = {
    dateOfEngagement: '2023-10-01',
    startTime: '09:00',
    endTime: '12:00',
    description: 'Valid description with fewer than 40 words.',
    organizationName: 'Org',
    activityType: 'Activity',
};
