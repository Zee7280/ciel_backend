import {
  buildApprovalReminderCopy,
  buildOpportunityApprovalTracker,
  communityServicePublicCode,
  isLinkedDraftOpportunity,
} from './opportunity-approval-tracker.util';

describe('communityServicePublicCode', () => {
  it('is stable for the same uuid and year', () => {
    const id = 'cf890ae9-46a6-4de0-9f18-dabad608c19a';
    expect(communityServicePublicCode(id, '2026-09-27T00:00:00.000Z')).toBe(
      'CS-2026-C19A',
    );
    expect(communityServicePublicCode(id, '2026-01-01T00:00:00.000Z')).toBe(
      'CS-2026-C19A',
    );
  });
});

describe('buildOpportunityApprovalTracker', () => {
  const base = {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0001',
    title: 'SOS Classroom Transformation',
    createdAt: '2026-09-27T16:20:00.000Z',
    supervision: { contact: 'Dr Hina Malik', official_email: 'hina@uni.edu' },
    partner_organization: { organization_name: 'SOS Children’s Villages' },
  };

  it('marks drafts as linked-draft with no approval requested', () => {
    const t = buildOpportunityApprovalTracker({ ...base, status: 'draft' });
    expect(isLinkedDraftOpportunity({ status: 'draft' })).toBe(true);
    expect(t.linked_draft).toBe(true);
    expect(t.currently_with_role).toBe('student');
    expect(t.checklist.faculty).toBe(false);
  });

  it('keeps sequential faculty-then-partner-then-admin on a submitted student opportunity', () => {
    const faculty = buildOpportunityApprovalTracker({
      ...base,
      isStudentCreated: true,
      requiresPartnerApproval: true,
      status: 'pending_faculty',
      workflowStage: 'pending_faculty',
      facultyApprovalStatus: 'pending',
      partnerApprovalStatus: 'pending',
      adminApprovalStatus: 'pending',
    });
    expect(faculty.currently_with_role).toBe('faculty');
    expect(faculty.next_step).toContain('Partner/NGO');
    expect(faculty.next_step).toContain('CIEL PK');
    expect(
      buildOpportunityApprovalTracker({
        ...base,
        isStudentCreated: true,
        status: 'pending_faculty',
        workflowStage: 'pending_faculty',
        supervision: { supervisor_name: 'Dr Hina Malik' },
      }).currently_with,
    ).toBe('Dr Hina Malik');

    const partner = buildOpportunityApprovalTracker({
      ...base,
      isStudentCreated: true,
      requiresPartnerApproval: true,
      status: 'pending_partner',
      workflowStage: 'pending_partner',
      faculty_verified: true,
      facultyApprovalStatus: 'approved',
      partnerApprovalStatus: 'pending',
      adminApprovalStatus: 'pending',
    });
    expect(partner.currently_with_role).toBe('partner');
    expect(partner.currently_with).toContain('SOS');
    expect(partner.next_step).toBe('CIEL PK Final Approval');
    expect(partner.checklist.faculty).toBe(true);
    expect(partner.checklist.partner).toBe(false);

    const admin = buildOpportunityApprovalTracker({
      ...base,
      isStudentCreated: true,
      requiresPartnerApproval: true,
      status: 'pending_approval',
      workflowStage: 'pending_admin',
      faculty_verified: true,
      facultyApprovalStatus: 'approved',
      partnerVerified: true,
      partnerApprovalStatus: 'approved',
      adminApprovalStatus: 'pending',
    });
    expect(admin.currently_with_role).toBe('admin');
    expect(admin.checklist.partner).toBe(true);
    expect(admin.checklist.admin).toBe(false);
  });

  it('sends revision back to the student without adding a second NGO gate', () => {
    const t = buildOpportunityApprovalTracker({
      ...base,
      isStudentCreated: true,
      requiresPartnerApproval: true,
      status: 'revision',
      workflowStage: 'revision',
      facultyApprovalStatus: 'revision_requested',
      partnerApprovalStatus: 'pending',
      adminApprovalStatus: 'pending',
      updatedAt: '2026-09-27T16:20:00.000Z',
    });
    expect(t.currently_with_role).toBe('student');
    expect(t.currently_with).toContain('revision');
    expect(t.next_step).toContain('resubmit');
    expect(t.waiting_since).toBe('2026-09-27T16:20:00.000Z');
  });

  it('admin approved alone does not mark Published until live', () => {
    const row = buildOpportunityApprovalTracker({
      ...base,
      isStudentCreated: true,
      requiresPartnerApproval: true,
      status: 'pending_approval',
      workflowStage: 'pending_admin',
      faculty_verified: true,
      facultyApprovalStatus: 'approved',
      partnerVerified: true,
      partnerApprovalStatus: 'approved',
      adminApprovalStatus: 'approved',
      admin_approved: true,
    });
    expect(row.currently_with_role).toBe('admin');
    expect(row.currently_with).toContain('CIEL');
  });

  it('does not invent a second NGO gate when only the partner line exists', () => {
    const t = buildOpportunityApprovalTracker({
      ...base,
      requiresPartnerApproval: true,
      workflowStage: 'pending_partner',
      status: 'pending_partner',
      facultyApprovalStatus: 'approved',
      faculty_verified: true,
    });
    expect(t.currently_with_role).toBe('partner');
    expect(t.next_step).toBe('CIEL PK Final Approval');
  });
});

describe('buildApprovalReminderCopy', () => {
  it('includes title, public id, status and a deep link', () => {
    const copy = buildApprovalReminderCopy(
      {
        id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0001',
        title: 'SOS Classroom Transformation',
        createdAt: '2026-09-27T16:20:00.000Z',
        workflowStage: 'pending_faculty',
        status: 'pending_faculty',
        supervision: { contact: 'Dr Hina Malik' },
      },
      'https://app.cielpk.com',
    );
    expect(copy.subject).toContain('CS-2026-0001');
    expect(copy.email_body).toContain('SOS Classroom Transformation');
    expect(copy.email_body).toContain('Dr Hina Malik');
    expect(copy.open_url).toContain('/dashboard/faculty/approvals');
    expect(copy.whatsapp_text).toContain('https://app.cielpk.com/dashboard/faculty/approvals');
  });
});
