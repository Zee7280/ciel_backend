/**
 * Display-only Community Service approval tracker.
 * Does not change faculty → partner → CIEL gates. Existing statuses stay canonical.
 */

export type OpportunityApprovalTracker = {
  public_code: string;
  linked_draft: boolean;
  currently_with: string;
  currently_with_role: 'student' | 'faculty' | 'partner' | 'admin' | 'none';
  next_step: string;
  waiting_since: string | null;
  route: {
    faculty: string;
    partner: string;
    admin: string;
    student: string;
    university: string;
  };
  checklist: {
    student: boolean;
    faculty: boolean;
    partner: boolean;
    partner_required: boolean;
    admin: boolean;
  };
};

type TrackerOpp = {
  id?: string | null;
  title?: string | null;
  status?: string | null;
  workflowStage?: string | null;
  facultyApprovalStatus?: string | null;
  partnerApprovalStatus?: string | null;
  adminApprovalStatus?: string | null;
  requiresPartnerApproval?: boolean | null;
  isStudentCreated?: boolean | null;
  faculty_verified?: boolean | null;
  partnerVerified?: boolean | null;
  admin_approved?: boolean | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
  approvalHistory?: Array<{ at?: string | null }> | null;
  supervision?: Record<string, unknown> | null;
  partner_organization?: Record<string, unknown> | null;
};

function lower(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

function txt(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Stable public label. No DB migration — derived from id + year so old rows stay unique. */
export function communityServicePublicCode(
  id: string | null | undefined,
  createdAt?: Date | string | null,
): string {
  const yearDate = createdAt ? new Date(createdAt) : new Date();
  const year = Number.isNaN(yearDate.getTime())
    ? new Date().getFullYear()
    : yearDate.getFullYear();
  const compact = String(id || '')
    .replace(/-/g, '')
    .slice(-4)
    .toUpperCase();
  const token = (compact || '0000').padStart(4, '0');
  return `CS-${year}-${token}`;
}

export function isLinkedDraftOpportunity(opp: TrackerOpp): boolean {
  return lower(opp.status) === 'draft';
}

function facultyCleared(opp: TrackerOpp): boolean {
  return (
    opp.faculty_verified === true ||
    lower(opp.facultyApprovalStatus) === 'approved' ||
    lower(opp.facultyApprovalStatus) === 'not_applicable' ||
    lower(opp.facultyApprovalStatus) === 'not_required'
  );
}

function partnerCleared(opp: TrackerOpp): boolean {
  if (!opp.requiresPartnerApproval) return true;
  return (
    opp.partnerVerified === true ||
    lower(opp.partnerApprovalStatus) === 'approved' ||
    lower(opp.partnerApprovalStatus) === 'not_applicable'
  );
}

function facultyLabel(opp: TrackerOpp): string {
  const s = opp.supervision && typeof opp.supervision === 'object' ? opp.supervision : {};
  return (
    txt(s.supervisor_name) ||
    txt(s.faculty_name) ||
    txt(s.name) ||
    txt(s.contact_name) ||
    txt(s.contact) ||
    'Faculty supervisor'
  );
}

function partnerLabel(opp: TrackerOpp): string {
  const p =
    opp.partner_organization && typeof opp.partner_organization === 'object'
      ? opp.partner_organization
      : {};
  return txt(p.organization_name) || txt(p.name) || 'Partner / NGO';
}

function waitingSince(opp: TrackerOpp): string | null {
  const hist = Array.isArray(opp.approvalHistory) ? opp.approvalHistory : [];
  for (let i = hist.length - 1; i >= 0; i -= 1) {
    const at = iso(hist[i]?.at ?? null);
    if (at) return at;
  }
  return iso(opp.updatedAt) || iso(opp.createdAt);
}

export function buildOpportunityApprovalTracker(opp: TrackerOpp): OpportunityApprovalTracker {
  const id = String(opp.id || '').trim();
  const stage = lower(opp.workflowStage);
  const status = lower(opp.status);
  const partnerRequired = Boolean(opp.requiresPartnerApproval);
  const draft = isLinkedDraftOpportunity(opp);
  const public_code = communityServicePublicCode(id, opp.createdAt);
  const route = {
    faculty: `/dashboard/faculty/approvals?opportunity=${encodeURIComponent(id)}&tab=pending`,
    partner: `/dashboard/partner/verify?opportunity=${encodeURIComponent(id)}&tab=pending`,
    admin: `/dashboard/admin/approvals?opportunity=${encodeURIComponent(id)}&tab=pending`,
    student: `/dashboard/student/paths/community-service?view=create&filter=review&opportunity=${encodeURIComponent(id)}`,
    university: `/dashboard/partner/community-service?opportunity=${encodeURIComponent(id)}`,
  };

  const checklist = {
    student: !draft && status !== '' && status !== 'draft',
    faculty: facultyCleared(opp) && !draft,
    partner: partnerCleared(opp) && !draft,
    partner_required: partnerRequired,
    admin: opp.admin_approved === true || lower(opp.adminApprovalStatus) === 'approved',
  };

  if (draft) {
    return {
      public_code,
      linked_draft: true,
      currently_with: 'Student — preparing (no approval requested yet)',
      currently_with_role: 'student',
      next_step: 'Student submits → Faculty approval',
      waiting_since: iso(opp.updatedAt) || iso(opp.createdAt),
      route,
      checklist: {
        student: false,
        faculty: false,
        partner: false,
        partner_required: partnerRequired,
        admin: false,
      },
    };
  }

  if (status === 'rejected' || stage === 'rejected') {
    return {
      public_code,
      linked_draft: false,
      currently_with: 'Closed — rejected',
      currently_with_role: 'none',
      next_step: 'No further approval',
      waiting_since: waitingSince(opp),
      route,
      checklist,
    };
  }

  if (status === 'revision' || stage === 'revision') {
    return {
      public_code,
      linked_draft: false,
      currently_with: 'Student — revision requested',
      currently_with_role: 'student',
      next_step: 'Student updates and resubmits',
      waiting_since: waitingSince(opp),
      route,
      checklist,
    };
  }

  // Only mark Published when the opportunity is actually live — admin line alone is not enough
  // (stale admin_approval_status was showing "Published" + Email CIEL PK at the same time).
  if (stage === 'live' || status === 'live' || (status === 'active' && checklist.admin)) {
    return {
      public_code,
      linked_draft: false,
      currently_with: 'Published',
      currently_with_role: 'none',
      next_step: 'Browse Opportunities / Community Service Workspace',
      waiting_since: null,
      route,
      checklist: { ...checklist, student: true, faculty: true, partner: true, admin: true },
    };
  }

  if (stage === 'pending_faculty' || status === 'pending_faculty' || status === 'pending_verification') {
    return {
      public_code,
      linked_draft: false,
      currently_with: facultyLabel(opp),
      currently_with_role: 'faculty',
      next_step: partnerRequired
        ? 'Faculty approval → Partner/NGO → CIEL PK Final Approval'
        : 'Faculty approval → CIEL PK Final Approval',
      waiting_since: waitingSince(opp),
      route,
      checklist,
    };
  }

  if (stage === 'pending_partner' || status === 'pending_partner') {
    return {
      public_code,
      linked_draft: false,
      currently_with: partnerLabel(opp),
      currently_with_role: 'partner',
      next_step: 'CIEL PK Final Approval',
      waiting_since: waitingSince(opp),
      route,
      checklist,
    };
  }

  if (stage === 'pending_admin' || status === 'pending_approval') {
    return {
      public_code,
      linked_draft: false,
      currently_with: 'CIEL PK Final Approval',
      currently_with_role: 'admin',
      next_step: 'Published → Browse Opportunities / Workspace',
      waiting_since: waitingSince(opp),
      route,
      checklist,
    };
  }

  return {
    public_code,
    linked_draft: false,
    currently_with: status ? status.replace(/_/g, ' ') : 'In review',
    currently_with_role: 'none',
    next_step: partnerRequired && !partnerCleared(opp) ? 'Partner/NGO acknowledgement' : 'CIEL PK review',
    waiting_since: waitingSince(opp),
    route,
    checklist,
  };
}

export function buildApprovalReminderCopy(
  opp: TrackerOpp,
  frontendOrigin: string,
): {
  subject: string;
  email_body: string;
  whatsapp_text: string;
  open_url: string;
} {
  const tracker = buildOpportunityApprovalTracker(opp);
  const origin = String(frontendOrigin || '').replace(/\/$/, '');
  const path =
    tracker.currently_with_role === 'faculty'
      ? tracker.route.faculty
      : tracker.currently_with_role === 'partner'
        ? tracker.route.partner
        : tracker.currently_with_role === 'admin'
          ? tracker.route.admin
          : tracker.route.student;
  const open_url = origin ? `${origin}${path}` : path;
  const title = txt(opp.title) || 'Community Service opportunity';
  const subject = `CIEL PK Community Service Approval · ${tracker.public_code}`;
  const email_body = [
    'CIEL PK · Approval Reminder',
    `Opportunity: ${title}`,
    `ID: ${tracker.public_code}`,
    `Current Status: ${tracker.currently_with}`,
    `Next: ${tracker.next_step}`,
    '',
    'Please review the opportunity when convenient.',
    `Open Approval: ${open_url}`,
  ].join('\n');
  const whatsapp_text = `Hi, ${tracker.public_code} — ${title} is awaiting your approval on CIEL PK.\nPlease review here: ${open_url}`;
  return { subject, email_body, whatsapp_text, open_url };
}
