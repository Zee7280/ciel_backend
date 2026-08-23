/** FYP Merit Model — shared types for the scoring engine (fyp-merit-model.util.ts). */

export interface FypMeritInputs {
    // display passthrough
    route: string;
    projectTitle: string | null;
    school: string | null;
    supervisorName: string | null;
    supervisorEmail: string | null;
    span: string | null;
    completionMonth: string;

    // purpose & originality
    aim: 0 | 1 | 2;
    objs: number;
    nov: 0 | 1 | 2;

    // rigor
    fit: 0 | 1 | 2;
    scn: number;
    dur: number;

    // outcome
    fnd: number;
    evs: string;
    mm: number;
    me: number;
    mt: number;

    // honesty
    lim: 0 | 1 | 2;
    scope: 0 | 1;
    wrong: 0 | 1;
    blk: 0 | 1 | 2;

    // sdg
    sdg: 'linked' | 'none' | 'forced';
    tgt: 0 | 1;
    how: 0 | 1;

    // potential & continuation
    fwd: 0 | 1;
    ext: 0 | 1;

    // completeness & connection
    repo: 0 | 1;
    linked: 0 | 1;
    conf: 0 | 1;
}

export interface FypMeritCriterionScore {
    pts: number;
    max: number;
    note: string;
    flag?: string;
}

export interface FypMeritScorecard {
    purpose: FypMeritCriterionScore;
    rigor: FypMeritCriterionScore;
    outcome: FypMeritCriterionScore;
    honesty: FypMeritCriterionScore;
    sdg: FypMeritCriterionScore;
    pot: FypMeritCriterionScore;
    conn: FypMeritCriterionScore;
    total: number;
}

export interface FypMeritGrade {
    label: string;
    color: string;
}

export interface FypMeritQualityBadge {
    icon: string;
    label: string;
    color: string;
    background: string;
    description: string;
}

export interface FypMeritQualityProfile {
    completenessPercent: number;
    credibilityPercent: number;
    badge: FypMeritQualityBadge;
}

export interface FypMeritCard {
    id: string;
    projectTitle: string | null;
    route: string;
    routeColor: [string, string, string];
    school: string | null;
    supervisorName: string | null;
    span: string | null;
    completionMonth: string;
    scorecard: FypMeritScorecard;
    grade: FypMeritGrade;
    qualityProfile: FypMeritQualityProfile;
    reason: string;
    potential: string;
}

export interface RankedFypMeritCard extends FypMeritCard {
    rank: number;
    isTopPick: boolean;
    student: { id: string; name: string; email: string; institution?: string; department?: string } | null;
}
