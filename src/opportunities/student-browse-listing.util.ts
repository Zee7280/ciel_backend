import { isDisplayableOrgName } from '../reports/tracking-org-name.util';

/** Shared browse-listing shape for student marketplace cards. Keep FE `browseOpportunityPath.ts` aligned. */

export type BrowsePathKey =
  | 'community_service'
  | 'coursework'
  | 'fyp'
  | 'startup';

export const BROWSE_PATH_LABEL: Record<BrowsePathKey, string> = {
  community_service: 'Community Service',
  coursework: 'Coursework',
  fyp: 'FYP / Research',
  startup: 'Startups',
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function typesBlob(types: unknown): string {
  if (!Array.isArray(types)) return '';
  return types.map((entry) => String(entry || '').toLowerCase()).join(' ');
}

export function classifyBrowsePath(types: unknown): BrowsePathKey {
  const blob = typesBlob(types);
  if (/(course.?work|course.?project|sustainability-linked)/.test(blob)) {
    return 'coursework';
  }
  if (/\b(fyp|thesis|research)\b/.test(blob)) return 'fyp';
  if (/(startup|venture|enterprise)/.test(blob)) return 'startup';
  return 'community_service';
}

export function countBrowsePaths(
  rows: Array<{ types?: unknown; path_key?: unknown }>,
): Record<BrowsePathKey | 'all', number> {
  const counts: Record<BrowsePathKey | 'all', number> = {
    all: rows.length,
    community_service: 0,
    coursework: 0,
    fyp: 0,
    startup: 0,
  };
  for (const row of rows) {
    const key =
      row.path_key === 'community_service' ||
      row.path_key === 'coursework' ||
      row.path_key === 'fyp' ||
      row.path_key === 'startup'
        ? row.path_key
        : classifyBrowsePath(row.types);
    counts[key] += 1;
  }
  return counts;
}

export function classifyBrowseCreator(opportunity: {
  isStudentCreated?: unknown;
  facultyId?: unknown;
  organizationId?: unknown;
  created_by_role?: unknown;
  creator_role?: unknown;
  creator_type?: unknown;
}): 'student' | 'faculty' | 'partner' | 'admin' | null {
  const raw = str(
    opportunity.created_by_role ||
      opportunity.creator_role ||
      opportunity.creator_type,
  ).toLowerCase();
  if (raw.includes('student')) return 'student';
  if (raw.includes('faculty')) return 'faculty';
  if (raw.includes('admin') || raw.includes('ciel')) return 'admin';
  if (raw.includes('ngo') || raw.includes('partner')) return 'partner';
  if (opportunity.isStudentCreated === true) return 'student';
  if (opportunity.facultyId && !opportunity.organizationId) return 'faculty';
  if (opportunity.organizationId) return 'partner';
  return null;
}

export function buildPublicExploreStats(
  rows: Array<{
    organization_name?: unknown;
    partner_name?: unknown;
    participant_count?: unknown;
    faculty_verified?: unknown;
    execution_verified?: unknown;
    admin_approved?: unknown;
    path_key?: unknown;
    types?: unknown;
  }>,
) {
  const partners = new Set<string>();
  let studentsImpacted = 0;
  let verified = 0;
  for (const row of rows) {
    const org = str(row.partner_name || row.organization_name);
    if (isDisplayableOrgName(org)) partners.add(org);
    const occupied = Number(row.participant_count);
    if (Number.isFinite(occupied) && occupied > 0) studentsImpacted += occupied;
    if (
      row.faculty_verified === true ||
      row.execution_verified === true ||
      row.admin_approved === true
    ) {
      verified += 1;
    }
  }
  return {
    total: rows.length,
    verified: verified || rows.length,
    partners: partners.size,
    students_impacted: studentsImpacted,
  };
}

function firstHttpsUrl(value: unknown): string | null {
  if (typeof value === 'string' && /^https?:\/\//i.test(value.trim())) {
    return value.trim();
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstHttpsUrl(item);
      if (found) return found;
    }
  }
  const rec = asRecord(value);
  if (!rec) return null;
  for (const key of ['url', 'src', 'href', 'image', 'image_url', 'cover_url']) {
    const found = firstHttpsUrl(rec[key]);
    if (found) return found;
  }
  return null;
}

export function pickBrowseCoverUrl(opportunity: {
  cover_url?: unknown;
  banner_url?: unknown;
  image_url?: unknown;
  activity_details?: unknown;
  objectives?: unknown;
}): string | null {
  return (
    firstHttpsUrl(opportunity.cover_url) ||
    firstHttpsUrl(opportunity.banner_url) ||
    firstHttpsUrl(opportunity.image_url) ||
    firstHttpsUrl(asRecord(opportunity.activity_details)?.cover_url) ||
    firstHttpsUrl(asRecord(opportunity.activity_details)?.images) ||
    firstHttpsUrl(asRecord(opportunity.objectives)?.image_url) ||
    null
  );
}

function pickDepartment(opportunity: {
  supervision?: unknown;
  academic_linkage?: unknown;
  visibility_and_academic_linkage?: unknown;
  participation_scope?: unknown;
}): string | null {
  const supervision = asRecord(opportunity.supervision);
  const fromSupervisor = str(supervision?.faculty_department);
  if (fromSupervisor) return fromSupervisor;

  const academic = asRecord(opportunity.academic_linkage);
  const fromAcademic = str(academic?.department || academic?.department_name);
  if (fromAcademic) return fromAcademic;

  const linkage = asRecord(opportunity.visibility_and_academic_linkage);
  const fromLinkage = str(linkage?.department || linkage?.department_name);
  if (fromLinkage) return fromLinkage;

  const scope = asRecord(opportunity.participation_scope);
  const restriction = asRecord(scope?.department_restriction);
  const depts = restriction?.departments;
  if (Array.isArray(depts)) {
    const names = depts.map((d) => str(d)).filter(Boolean);
    if (names.length) return names.join(', ');
  }
  return null;
}

function pickPartnerName(
  opportunity: {
    partner_organization?: unknown;
    executing_organization?: unknown;
  },
  organizationName: string,
): string {
  const partner = asRecord(opportunity.partner_organization);
  const fromPartner = str(
    partner?.organization_name || partner?.name || partner?.partner_name,
  );
  if (isDisplayableOrgName(fromPartner)) return fromPartner;
  const executing = asRecord(opportunity.executing_organization);
  const fromExec = str(executing?.name || executing?.organization_name);
  if (isDisplayableOrgName(fromExec)) return fromExec;
  return isDisplayableOrgName(organizationName) ? organizationName : '';
}

function collectSdgIds(opportunity: {
  sdg?: unknown;
  sdg_info?: unknown;
  secondary_sdgs?: unknown;
}): string[] {
  const ids: string[] = [];
  const push = (value: unknown) => {
    const rec = asRecord(value);
    const raw = rec
      ? rec.sdg_id ?? rec.id ?? rec.goal_number ?? rec.number
      : value;
    const key = String(raw ?? '').trim();
    if (key && !ids.includes(key)) ids.push(key);
  };
  push(opportunity.sdg_info);
  push(opportunity.sdg);
  if (Array.isArray(opportunity.secondary_sdgs)) {
    opportunity.secondary_sdgs.forEach(push);
  }
  return ids.slice(0, 4);
}

function isRemoteMode(mode: unknown): boolean {
  return /remote|virtual|online/.test(String(mode || '').toLowerCase());
}

function isUrgentEndDate(endDate: string | null, now = new Date()): boolean {
  if (!endDate) return false;
  const iso = String(endDate).match(/^(\d{4})-(\d{2})-(\d{2})/);
  const end = iso
    ? new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]))
    : new Date(endDate);
  if (Number.isNaN(end.getTime())) return false;
  const inTwoWeeks = new Date(now);
  inTwoWeeks.setDate(inTwoWeeks.getDate() + 14);
  return end.getTime() >= now.getTime() && end.getTime() <= inTwoWeeks.getTime();
}

export function buildStudentBrowseListingFields(
  opportunity: {
    types?: unknown;
    mode?: unknown;
    timeline?: unknown;
    requiredHours?: unknown;
    sdg?: unknown;
    sdg_info?: unknown;
    secondary_sdgs?: unknown;
    supervision?: unknown;
    academic_linkage?: unknown;
    visibility_and_academic_linkage?: unknown;
    participation_scope?: unknown;
    partner_organization?: unknown;
    executing_organization?: unknown;
    cover_url?: unknown;
    banner_url?: unknown;
    image_url?: unknown;
    activity_details?: unknown;
    objectives?: unknown;
  },
  extras: { remaining_seats: number; organization_name: string },
) {
  const timeline = asRecord(opportunity.timeline) ?? {};
  const path_key = classifyBrowsePath(opportunity.types);
  const hoursRaw = Number(timeline.expected_hours ?? opportunity.requiredHours);
  const start_date = str(timeline.start_date) || null;
  const end_date =
    str(timeline.end_date) || str(timeline.application_deadline) || null;
  const volunteersRequired = Number(timeline.volunteers_required);
  const hasSeatCap = Number.isFinite(volunteersRequired) && volunteersRequired > 0;

  return {
    path_key,
    path_label: BROWSE_PATH_LABEL[path_key],
    start_date,
    end_date,
    hours: Number.isFinite(hoursRaw) && hoursRaw > 0 ? hoursRaw : null,
    department: pickDepartment(opportunity),
    partner_name: pickPartnerName(opportunity, extras.organization_name),
    sdg_ids: collectSdgIds(opportunity),
    is_full: hasSeatCap && extras.remaining_seats <= 0,
    is_virtual: isRemoteMode(opportunity.mode),
    is_urgent: isUrgentEndDate(end_date),
    cover_url: pickBrowseCoverUrl(opportunity),
    category: Array.isArray(opportunity.types)
      ? str(opportunity.types[0]) || BROWSE_PATH_LABEL[path_key]
      : BROWSE_PATH_LABEL[path_key],
  };
}
