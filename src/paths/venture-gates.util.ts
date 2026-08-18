import { VentureEntry } from './entities/venture-entry.entity';

/**
 * The three-tier gate system from the Enterprise Path wizard: Academic submission →
 * Showcase Ready → Investment Ready. Each gate only opens once the previous one does.
 * Kept in sync with the frontend's own copy in
 * `ciel_frontend/src/app/dashboard/student/paths/startup-business/ventureGates.ts`.
 */
export interface VentureGateStatus {
    academicOk: boolean;
    showcaseOk: boolean;
    investmentReadyOk: boolean;
}

const STAGE_NEEDS_OPS_EVIDENCE = ['Early Revenue', 'Growth'];
const STAGE_NEEDS_PROTO_EVIDENCE = ['Prototype / MVP', 'Pilot'];

export function computeVentureGates(v: Partial<VentureEntry>): VentureGateStatus {
    const academicOk = !!(
        v.academicSetup?.university?.trim() &&
        v.academicSetup?.faculty?.trim() &&
        v.academicSetup?.department?.trim() &&
        v.academicSetup?.program?.trim() &&
        v.academicSetup?.supervisorName?.trim() &&
        v.documents?.some((d) => d.type === 'Full business plan') &&
        v.reviewPipeline?.declarationWork &&
        v.reviewPipeline?.declarationConsent &&
        v.status === 'submitted'
    );

    const teamConsentOk = !v.teamConsent?.length || v.teamConsent.every((t) => t.consented);
    const sdgOk =
        v.sdgMapping?.mode === 'none' ||
        v.reviewPipeline?.sdgReviewStatus === 'approved' ||
        v.reviewPipeline?.sdgReviewStatus === 'pending';
    const showcaseOk = !!(
        academicOk &&
        v.reviewPipeline?.supervisorStatus === 'approved' &&
        v.reviewPipeline?.universityStatus === 'approved' &&
        sdgOk &&
        teamConsentOk
    );

    const raising = !!(v.evidenceInfo?.fundingSought && v.evidenceInfo?.useOfFunds?.trim());
    const stage = v.stage || '';
    const stageEvidenceOk = STAGE_NEEDS_OPS_EVIDENCE.includes(stage)
        ? !!(v.evidenceInfo?.customers && v.evidenceInfo?.revenueToDate)
        : STAGE_NEEDS_PROTO_EVIDENCE.includes(stage)
          ? !!(v.evidenceInfo?.testers || v.evidenceInfo?.pilotPartners)
          : false;
    const marketOk = !!(
        v.solutionInfo?.marketWho?.trim() &&
        v.solutionInfo?.marketSize?.trim() &&
        v.solutionInfo?.marketSource &&
        v.solutionInfo.marketSource !== 'Educated guess — needs checking'
    );
    const investmentReadyOk = !!(
        showcaseOk &&
        raising &&
        stageEvidenceOk &&
        marketOk &&
        v.solutionInfo?.advantage?.trim() &&
        v.publishSettings?.showAsk &&
        v.publishSettings?.acceptIntros
    );

    return { academicOk, showcaseOk, investmentReadyOk };
}

/** Visible only once genuinely earned (Showcase Ready) AND the student picked a non-private audience. */
export function deriveVentureIsVisible(v: Partial<VentureEntry>): boolean {
    const { showcaseOk } = computeVentureGates(v);
    return showcaseOk && !!v.publishSettings?.audience && v.publishSettings.audience !== 'private';
}
