import { Opportunity } from './entities/opportunity.entity';
import { WORKFLOW_STAGE } from './opportunity-workflow.service';

/** Same set `OpportunitiesService.normalizeOpportunityStatus` treats as "active". */
export const PUBLIC_LIVE_STATUSES = ['active', 'live', 'open', 'recruiting'];

export function isApprovedLiveStudentOpportunity(opp: Opportunity): boolean {
  if (opp.admin_approved !== true) return false;
  const status = String(opp.status || '').toLowerCase();
  if (status === 'draft' || status === 'rejected' || status === 'closed') {
    return false;
  }
  if (opp.workflowStage === WORKFLOW_STAGE.LIVE) return true;
  return PUBLIC_LIVE_STATUSES.includes(status);
}

/**
 * Single source of truth for "does this opportunity show on the public directory/Browse".
 * Admin list payloads must use this (not a simplified re-derivation) so `directory_visible`
 * never disagrees with what students actually see.
 */
export function isPubliclyVisibleOpportunity(opp: Opportunity): boolean {
  if (opp.admin_hidden === true) return false;
  if (String(opp.status || '').toLowerCase() === 'draft') return false;
  if (opp.isStudentCreated) {
    return isApprovedLiveStudentOpportunity(opp);
  }
  const linkage = opp.visibility_and_academic_linkage;
  const explicitType =
    linkage && typeof linkage.visibility_type === 'string'
      ? linkage.visibility_type.trim().toLowerCase()
      : '';

  const scopeRule =
    opp.participation_scope && typeof opp.participation_scope === 'object'
      ? String((opp.participation_scope as { rule?: string }).rule || '').trim()
      : '';

  if (explicitType) {
    const restrictive = [
      'own_university_only',
      'restricted_specific_universities',
      'restricted',
    ].includes(explicitType);
    if (!restrictive) return true;
    // Same leniency as the legacy `visibility` fallback below: a restrictive
    // visibility_and_academic_linkage type only hides the directory card when there's no real
    // participation_scope backing it (nothing to gate Apply Now with). When a scope rule does
    // exist, Apply Now eligibility is what enforces the restriction — the card itself still
    // shows publicly. "Public card + scoped Apply Now" is the product rule everywhere else.
    return Boolean(scopeRule);
  }

  // Student flow defaults top-level `visibility` to "restricted" while scope lives in
  // participation_scope; treat that default as public listing. Faculty/org "restricted"
  // without a participation rule still suppresses the directory (previous hide-the-card behavior).
  const legacy = String(opp.visibility || '')
    .trim()
    .toLowerCase();
  if (
    ['own_university_only', 'restricted_specific_universities'].includes(legacy)
  ) {
    return false;
  }
  if (legacy === 'restricted') {
    // Apply Now targeting is not a directory hide. Public card + scoped Apply Now is the product rule.
    if (scopeRule) return true;
    return false;
  }
  return true;
}
