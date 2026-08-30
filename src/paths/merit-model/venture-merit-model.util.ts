import { VentureEntry } from '../entities/venture-entry.entity';
import { grade as sharedGrade } from './merit-model.util';
import { VentureMeritCard, VentureMeritScorecard } from './venture-merit-model.types';

const nonEmpty = (text?: string | null) => !!text?.trim();

/** 100-pt rubric built only from fields the 8-step venture wizard actually captures — no invented
 * signals. Mirrors the bucket-scoring style of the Coursework/FYP rubrics: each criterion is a
 * deterministic function of already-stored data, never a fabricated number. */
export function scoreVenture(entry: VentureEntry): VentureMeritScorecard {
    const traction = entry.tractionRows ?? [];
    const evidence = entry.evidenceInfo;
    const idea = entry.ideaInfo;
    const solution = entry.solutionInfo;
    const team = entry.team ?? [];
    const sdg = entry.sdgMapping;
    const documents = entry.documents ?? [];
    const consent = entry.teamConsent ?? [];
    const pipeline = entry.reviewPipeline;
    const academic = entry.academicSetup;

    // Traction & evidence of demand — 25pts: row-count bucket (0-20) + breadth of demand signals (0-5).
    const rowCount = traction.length;
    const rowPts = rowCount >= 6 ? 20 : rowCount >= 3 ? 15 : rowCount >= 1 ? 8 : 0;
    const demandSignals = [
        evidence?.customers,
        evidence?.revenueToDate,
        evidence?.pilotPartners,
        evidence?.testers,
        evidence?.lettersOfIntent,
        evidence?.preOrders,
    ].filter((v) => typeof v === 'number' && v > 0).length;
    const tractionPts = Math.min(25, rowPts + Math.min(5, demandSignals));
    const tractionNote = rowCount
        ? `${rowCount} traction entr${rowCount === 1 ? 'y' : 'ies'} · ${demandSignals} demand signal${demandSignals === 1 ? '' : 's'}`
        : 'No traction recorded yet';

    // Market understanding & sizing rigor — 15pts: same 3 signals venture-gates.util.ts's marketOk checks.
    const marketPts =
        (nonEmpty(solution?.marketWho) ? 5 : 0) +
        (nonEmpty(solution?.marketSize) ? 5 : 0) +
        (solution?.marketSource && solution.marketSource !== 'Educated guess — needs checking' ? 5 : 0);
    const marketNote = marketPts >= 15 ? 'Market sized with a credible source' : marketPts > 0 ? 'Market sizing partially evidenced' : 'Market sizing not yet provided';

    // Problem/solution clarity & advantage — 15pts.
    const problemPts =
        (nonEmpty(idea?.problem) ? 3 : 0) +
        (nonEmpty(idea?.proofFact) ? 3 : 0) +
        (nonEmpty(idea?.payerWho) ? 2 : 0) +
        (nonEmpty(idea?.userWho) ? 2 : 0) +
        (nonEmpty(solution?.advantage) ? 3 : 0) +
        (nonEmpty(solution?.alternative) ? 2 : 0);
    const problemNote = problemPts >= 12 ? 'Problem, proof and advantage all clearly stated' : problemPts > 0 ? 'Problem/solution partially articulated' : 'Problem/solution not yet described';

    // Team strength — 10pts: headcount bucket (0-8) + accepted-invite fraction bonus (0-2).
    const teamSize = team.length;
    const teamBasePts = teamSize >= 4 ? 8 : teamSize >= 2 ? 6 : teamSize >= 1 ? 3 : 0;
    const acceptedFraction = teamSize ? team.filter((m) => m.inviteStatus === 'accepted').length / teamSize : 0;
    const teamPts = Math.min(10, teamBasePts + Math.round(acceptedFraction * 2));
    const teamNote = teamSize ? `${teamSize} team member${teamSize === 1 ? '' : 's'}` : 'No team members added';

    // SDG / impact rigor — 15pts.
    const sdgEntries = sdg?.entries ?? [];
    const indicators = sdg?.indicators ?? [];
    const filledIndicators = indicators.filter((i) => i.indicator && i.forGoal && i.target12mo && i.verifiedBy).length;
    const sdgPts = (sdgEntries.length ? 5 : 0) + Math.min(5, filledIndicators * 3) + (nonEmpty(sdg?.howImpact) ? 5 : 0);
    const sdgNote = sdgEntries.length ? `${sdgEntries.length} SDG${sdgEntries.length === 1 ? '' : 's'} mapped · ${filledIndicators} verifiable indicator${filledIndicators === 1 ? '' : 's'}` : 'No SDG mapping yet';

    // Evidence & documentation completeness — 10pts.
    const hasBusinessPlan = documents.some((d) => d.type === 'Full business plan');
    const evidencePts = (documents.length ? 5 : 0) + (hasBusinessPlan ? 5 : 0);
    const evidenceNote = hasBusinessPlan ? 'Full business plan on file' : documents.length ? 'Some supporting documents, no full business plan' : 'No supporting documents yet';

    // Governance / consent completeness — 10pts.
    const consentOk = !consent.length || consent.every((c) => c.consented);
    const governancePts =
        (consentOk ? 4 : 0) +
        (pipeline?.declarationWork && pipeline?.declarationConsent ? 3 : 0) +
        (nonEmpty(academic?.ethicsApproval) && nonEmpty(academic?.ipOwnership) ? 3 : 0);
    const governanceNote = governancePts >= 7 ? 'Declarations and consent complete' : governancePts > 0 ? 'Governance partially complete' : 'Declarations/consent not yet complete';

    const total = tractionPts + marketPts + problemPts + teamPts + sdgPts + evidencePts + governancePts;

    return {
        traction: { pts: tractionPts, max: 25, note: tractionNote },
        market: { pts: marketPts, max: 15, note: marketNote },
        problem: { pts: problemPts, max: 15, note: problemNote },
        team: { pts: teamPts, max: 10, note: teamNote },
        sdg: { pts: sdgPts, max: 15, note: sdgNote },
        evidence: { pts: evidencePts, max: 10, note: evidenceNote },
        governance: { pts: governancePts, max: 10, note: governanceNote },
        total,
    };
}

export function computeVentureMeritCard(entry: VentureEntry): VentureMeritCard {
    const scorecard = scoreVenture(entry);
    return {
        id: entry.id,
        ventureName: entry.ventureName,
        stage: entry.stage,
        scorecard,
        grade: sharedGrade(scorecard.total),
    };
}

export function byVentureMerit(a: VentureMeritCard, b: VentureMeritCard): number {
    return b.scorecard.total - a.scorecard.total;
}
