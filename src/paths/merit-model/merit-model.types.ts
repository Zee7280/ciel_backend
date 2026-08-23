/** Course Project Merit Model — shared types for the scoring engine (merit-model.util.ts). */

/** The flat scoring-formula inputs, extracted from a CourseProjectEntry by extractMeritInputs(). */
export interface MeritInputs {
    // display passthrough
    format: string;
    projectTitle: string | null;
    university: string | null;
    discipline: string | null;
    department: string | null;
    semester: string | null;
    year: number;
    teacherName: string | null;
    teacherEmail: string | null;
    teamMode: string | null;

    // purpose (idea)
    aim: 0 | 1 | 2;
    objs: number;
    issue: 0 | 1;

    // rigor
    fit: 0 | 1 | 2;
    scale: 0 | 1;

    // results
    output: 0 | 1;
    insight: 0 | 1 | 2;
    evs: string;
    num: string;
    numOk: 0 | 1;

    // sdg
    sdg: { p: number | undefined; target: 0 | 1; how: 0 | 1 };
    orig: string;
    integ: string;

    // honesty
    lim: 0 | 1 | 2;

    // reflection
    learn: 0 | 1 | 2;
    advice: 0 | 1;
    next: 0 | 1;
    skills: number;

    // verifiability
    att: 0 | 1;
    evf: 0 | 1;
}

export interface MeritCriterionScore {
    pts: number;
    max: number;
    note: string;
    flag?: string;
}

export interface MeritScorecard {
    sdg: MeritCriterionScore;
    results: MeritCriterionScore;
    purpose: MeritCriterionScore;
    rigor: MeritCriterionScore;
    honesty: MeritCriterionScore;
    refl: MeritCriterionScore;
    ver: MeritCriterionScore;
    total: number;
}

export interface MeritGrade {
    label: string;
    color: string;
}

export interface MeritQualityBadge {
    icon: string;
    label: string;
    color: string;
    background: string;
    description: string;
}

export interface MeritQualityProfile {
    completenessPercent: number;
    credibilityPercent: number;
    badge: MeritQualityBadge;
}

export interface MeritCard {
    id: string;
    projectTitle: string | null;
    format: string;
    university: string | null;
    discipline: string | null;
    department: string | null;
    semester: string | null;
    year: number;
    teacherName: string | null;
    teamMode: string | null;
    sdg: {
        goalNumber: number | undefined;
        color: string | undefined;
        hasTarget: boolean;
        hasExplainedLink: boolean;
        origin: string;
        integrationLevel: string;
    };
    scorecard: MeritScorecard;
    grade: MeritGrade;
    qualityProfile: MeritQualityProfile;
    reason: string;
    potential: string;
}

export interface RankedMeritCard extends MeritCard {
    rank: number;
    isTopPick: boolean;
    student: { id: string; name: string; email: string; institution?: string; department?: string } | null;
}
