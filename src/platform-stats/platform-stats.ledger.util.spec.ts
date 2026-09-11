import {
    DIVIDEND_HOURLY_RATE_PKR,
    beneficiariesFromSection4,
    communityDividendPkr,
    creditPairOnce,
    hoursFromReportSection1,
    membersFromReportSection1,
    pkrFromResources,
    isPlaceholderPartnerOrg,
    partnerNamesFromSection7,
    normalizePartnerKey,
    parseSdgGoalNumber,
    sdgsFromVerifiedReport,
    servingMemberKey,
    sumPeopleServing,
    mergeProjectLevelImpact,
    sumProjectLevelImpact,
} from './platform-stats.ledger.util';

describe('platform-stats ledger math', () => {
    it('reads hours and team size from the report, not from a student-count', () => {
        expect(
            hoursFromReportSection1({
                metrics: { total_verified_hours: 16 },
                attendance_logs: [{ hours: 4 }],
            }),
        ).toBe(16);
        expect(
            hoursFromReportSection1({
                metrics: { total_verified_hours: 0 },
                attendance_logs: [{ hours: 3 }, { hours: 5 }],
            }),
        ).toBe(8);
        expect(
            membersFromReportSection1(
                {
                    team_lead: { email: 'lead@bnu.edu.pk', name: 'Lead' },
                    team_members: [
                        { email: 'a@bnu.edu.pk', name: 'A' },
                        { email: 'b@bnu.edu.pk', name: 'B' },
                    ],
                },
                'stu-lead',
            ),
        ).toBe(3);
        expect(membersFromReportSection1({ team_member_count: 8 }, 'stu-1')).toBe(8);
    });

    it('sums unique team members per submitted project, not unique report authors', () => {
        expect(sumPeopleServing([8, 3, 1])).toBe(12);
        expect(sumPeopleServing([0, 0])).toBe(2);
        expect(servingMemberKey({ studentId: 'stu-1', email: 'a@x.com' })).toBe('sid:stu-1');
        expect(servingMemberKey({ studentId: '', email: 'A@x.com' })).toBe('email:a@x.com');
    });

    it('does not let a second teammate on the same project inflate people served or PKR', () => {
        const byProject = new Map<string, ReturnType<typeof mergeProjectLevelImpact>>();
        const reports = [
            { project: 'opp-1', people: 200, deployed: 50000, oop: 0 },
            { project: 'opp-1', people: 200, deployed: 50000, oop: 0 },
            { project: 'opp-2', people: 40, deployed: 1000, oop: 200 },
        ];
        for (const r of reports) {
            byProject.set(
                r.project,
                mergeProjectLevelImpact(byProject.get(r.project), {
                    beneficiaries: r.people,
                    deployed: r.deployed,
                    outOfPocket: r.oop,
                }),
            );
        }
        expect(sumProjectLevelImpact(byProject.values())).toEqual({
            beneficiaries: 240,
            deployed: 51000,
            outOfPocket: 200,
        });
    });

    it('credits a project+student pair only once', () => {
        const seen = new Set<string>();
        expect(creditPairOnce('opp-1:stu-1', seen)).toBe(true);
        expect(creditPairOnce('opp-1:stu-1', seen)).toBe(false);
        expect(creditPairOnce('opp-1:stu-2', seen)).toBe(true);
        expect(creditPairOnce('', seen)).toBe(false);
    });

    it('community dividend is hours × 192 + out-of-pocket, using the same rounded hours the caption shows', () => {
        expect(communityDividendPkr(994, 0)).toBe(994 * DIVIDEND_HOURLY_RATE_PKR);
        expect(communityDividendPkr(192.4, 10.6)).toBe(192 * DIVIDEND_HOURLY_RATE_PKR + 11);
        expect(communityDividendPkr(0, 2500)).toBe(2500);
    });

    it('does not let a second verified report on the same pair inflate hours, PKR, or people served', () => {
        const seen = new Set<string>();
        let hours = 0;
        let people = 0;
        let oop = 0;
        const reports = [
            { key: 'p:s', hrs: 192, people: 40, oop: 0 },
            { key: 'p:s', hrs: 192, people: 40, oop: 0 },
            { key: 'p:other', hrs: 8, people: 5, oop: 200 },
        ];
        for (const r of reports) {
            if (!creditPairOnce(r.key, seen)) continue;
            hours += r.hrs;
            people += r.people;
            oop += r.oop;
        }
        expect(hours).toBe(200);
        expect(people).toBe(45);
        expect(communityDividendPkr(hours, oop)).toBe(200 * DIVIDEND_HOURLY_RATE_PKR + 200);
    });

    it('reads distinct beneficiaries and splits self-funded PKR from partner-deployed PKR', () => {
        expect(
            beneficiariesFromSection4({
                project_summary: { distinct_total_beneficiaries: 12 },
                my_beneficiaries: 99,
            }),
        ).toBe(12);
        expect(
            pkrFromResources([
                { type: 'Financial (Cash Funding)', unit: 'PKR', amount: 3000, source: 'Partner' },
                { type: 'Financial (Cash Funding)', unit: 'PKR', amount: 500, source: 'Out-of-pocket' },
                { type: 'In-kind Materials (Food / Books / Supplies / Kits)', unit: 'Kits', amount: 20, source: 'Partner' },
                { type: 'In-kind Materials (Food / Books / Supplies / Kits)', unit: 'PKR', amount: 8000, source: 'Partner' },
                { type: 'Human Resources (Trainers / Experts / Volunteers)', unit: 'Hours', amount: 10, source: 'Student' },
            ]),
        ).toEqual({ deployed: 3000, outOfPocket: 500 });
    });

    it('counts real report partners and skips student-opportunity placeholders', () => {
        expect(
            isPlaceholderPartnerOrg({
                name: 'Student opportunity — Test — abc',
                orgType: 'OTHER',
                verificationStatus: 'unclaimed_student_initiated',
            }),
        ).toBe(true);
        expect(
            isPlaceholderPartnerOrg({
                name: "SOS Children's Villages Pakistan",
                orgType: 'NGO',
                verificationStatus: 'APPROVED',
            }),
        ).toBe(false);
        expect(
            partnerNamesFromSection7({
                partners: [
                    { name: '  WaterAid  ' },
                    { name: '' },
                    { name: 'Student opportunity — skip' },
                ],
            }),
        ).toEqual(['WaterAid']);
        expect(normalizePartnerKey('SOS  Children')).toBe('sos children');
    });
});

describe('platform-stats SDG parsing from verified reports', () => {
    it('parses numeric, padded, and "SDG N" goal numbers and ignores junk', () => {
        expect(parseSdgGoalNumber(4)).toBe(4);
        expect(parseSdgGoalNumber('04')).toBe(4);
        expect(parseSdgGoalNumber('SDG 6')).toBe(6);
        expect(parseSdgGoalNumber({ goal_number: '13' })).toBe(13);
        expect(parseSdgGoalNumber({ sdg_id: 'SDG 3' })).toBe(3);
        expect(parseSdgGoalNumber('SDG')).toBeNull();
        expect(parseSdgGoalNumber(0)).toBeNull();
        expect(parseSdgGoalNumber(18)).toBeNull();
        expect(parseSdgGoalNumber({ id: 'a1b2c3d4-e5f6' })).toBeNull();
    });

    it('counts the primary goal even when stored as a string on section 3', () => {
        expect(
            sdgsFromVerifiedReport({
                primary_sdg_goal: null,
                section3: { primary_sdg: { goal_number: 'SDG 6' } },
            }),
        ).toEqual([6]);
        expect(
            sdgsFromVerifiedReport({
                primary_sdg_goal: 4,
                section3: { primary_sdg: { goal_number: 4 } },
            }),
        ).toEqual([4]);
    });

    it('does not let empty secondary ticks inflate the public SDG list', () => {
        expect(
            sdgsFromVerifiedReport({
                primary_sdg_goal: 4,
                section3: {
                    primary_sdg: { goal_number: 4 },
                    secondary_sdgs: [
                        { goal_number: 1, status: 'provisional', justification_text: '' },
                        { goal_number: 2, status: 'rejected', justification_text: 'x'.repeat(40) },
                        {
                            goal_number: '03',
                            status: 'provisional',
                            justification_text: 'Hygiene kits and menstrual-health sessions for schoolgirls.',
                        },
                    ],
                },
            }),
        ).toEqual([3, 4]);
    });

    it('counts a validated secondary even without a long justification', () => {
        expect(
            sdgsFromVerifiedReport({
                primary_sdg_goal: 4,
                section3: {
                    secondary_sdgs: [{ goal_number: 5, status: 'validated' }],
                },
            }),
        ).toEqual([4, 5]);
    });

    it('caps secondaries at two and falls back to the opportunity primary only when the report stored none', () => {
        expect(
            sdgsFromVerifiedReport({
                primary_sdg_goal: 4,
                section3: {
                    secondary_sdgs: [
                        { goal_number: 1, status: 'validated' },
                        { goal_number: 2, status: 'validated' },
                        { goal_number: 3, status: 'validated' },
                    ],
                },
            }),
        ).toEqual([1, 2, 4]);
        expect(
            sdgsFromVerifiedReport({
                primary_sdg_goal: null,
                section3: {},
                opportunity: { sdg: 'SDG 6', sdg_info: { sdg_id: '06' } },
            }),
        ).toEqual([6]);
        expect(
            sdgsFromVerifiedReport({
                primary_sdg_goal: 4,
                section3: { primary_sdg: { goal_number: 4 } },
                opportunity: { sdg: '1', sdg_info: { sdg_id: '2' } },
            }),
        ).toEqual([4]);
    });
});
