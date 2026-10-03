/** Hide form-helper / placeholder strings that were saved as an organization name. */
export function isDisplayableOrgName(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const name = value.trim();
  if (name.length < 2 || name.length > 80) return false;
  if (/^n\/?a$/i.test(name)) return false;
  if (/^unknown$/i.test(name)) return false;
  if (/^student opportunity\b/i.test(name)) return false;
  if (/add only if/i.test(name)) return false;
  if (/another organization connected/i.test(name)) return false;
  if (/\beg\.?\s*sos\b/i.test(name) && /add only if|connected/i.test(name)) {
    return false;
  }
  return true;
}

function pickOrgField(record: unknown, ...keys: string[]): string | null {
  if (!record || typeof record !== 'object') return null;
  const rec = record as Record<string, unknown>;
  for (const key of keys) {
    const value = rec[key];
    if (isDisplayableOrgName(value)) return value.trim();
  }
  return null;
}

/**
 * Real host/partner name for faculty project tracking cards.
 * Prefer named partner / executing org; never leak create-form helper copy or "N/A".
 */
export function trackingOrganizationName(
  opp:
    | {
        organization?: { name?: string | null } | null;
        partner_organization?: unknown;
        executing_organization?: unknown;
        external_partner_collaboration?: unknown;
        executing_context?: unknown;
        supervision?: unknown;
      }
    | null
    | undefined,
): string | null {
  if (!opp) return null;
  const ctx =
    opp.executing_context && typeof opp.executing_context === 'object'
      ? (opp.executing_context as Record<string, unknown>)
      : {};
  return (
    pickOrgField(opp.partner_organization, 'organization_name', 'name') ||
    pickOrgField(opp.external_partner_collaboration, 'organization_name', 'name') ||
    pickOrgField(ctx.partner, 'organization_name', 'name') ||
    pickOrgField(opp.executing_organization, 'organization_name', 'name') ||
    pickOrgField(opp.supervision, 'partner_org_name', 'external_partner_org_name') ||
    (isDisplayableOrgName(opp.organization?.name)
      ? String(opp.organization?.name).trim()
      : null)
  );
}
