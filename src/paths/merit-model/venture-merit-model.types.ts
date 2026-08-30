/** Venture Merit Model — shared types for the scoring engine (venture-merit-model.util.ts). */

export interface VentureMeritCriterionScore {
    pts: number;
    max: number;
    note: string;
}

export interface VentureMeritScorecard {
    traction: VentureMeritCriterionScore;
    market: VentureMeritCriterionScore;
    problem: VentureMeritCriterionScore;
    team: VentureMeritCriterionScore;
    sdg: VentureMeritCriterionScore;
    evidence: VentureMeritCriterionScore;
    governance: VentureMeritCriterionScore;
    total: number;
}

export interface VentureMeritGrade {
    label: string;
    color: string;
}

export interface VentureMeritCard {
    id: string;
    ventureName: string | null;
    stage: string | null;
    scorecard: VentureMeritScorecard;
    grade: VentureMeritGrade;
}

export interface RankedVentureMeritCard extends VentureMeritCard {
    rank: number;
    isTopPick: boolean;
    student: { id: string; name: string; email: string; institution?: string; department?: string } | null;
}
