import {
  applyEvidenceAccess,
  canDownloadEvidence,
  canViewEvidence,
  effectiveEvidenceVisibility,
} from './evidence-access.util';

const restricted = { media_visible: 'restricted' };
const publicOk = { media_visible: 'public', public_share_permission: true };
const publicNoConsent = { media_visible: 'public' };

describe('evidence access matrix', () => {
  it('defaults to restricted and demotes public without permission', () => {
    expect(effectiveEvidenceVisibility(undefined)).toBe('restricted');
    expect(effectiveEvidenceVisibility(publicNoConsent)).toBe('restricted');
    expect(effectiveEvidenceVisibility({ media_visible: 'internal' })).toBe('private');
    expect(effectiveEvidenceVisibility(publicOk)).toBe('public');
  });

  it.each(['restricted', 'private'])('%s: role/approval matrix', (v) => {
    const pending = { section8: { media_visible: v }, admin_status: 'pending' };
    const approved = { ...pending, admin_status: 'approved' };
    expect(canViewEvidence(pending, 'student')).toBe(true);
    expect(canViewEvidence(pending, 'admin')).toBe(true);
    expect(canViewEvidence(pending, 'faculty')).toBe(false);
    expect(canViewEvidence(pending, 'university')).toBe(false);
    expect(canViewEvidence(approved, 'faculty')).toBe(true);
    expect(canViewEvidence(approved, 'university')).toBe(true);
    expect(canViewEvidence(approved, 'partner')).toBe(false);
    expect(canViewEvidence(approved, 'public')).toBe(false);
    expect(canDownloadEvidence(approved)).toBe(false);
  });

  it('public: everyone views and downloads', () => {
    const r = { section8: publicOk, admin_status: 'pending' };
    expect(canViewEvidence(r, 'public')).toBe(true);
    expect(canViewEvidence(r, 'partner')).toBe(true);
    expect(canDownloadEvidence(r)).toBe(true);
  });

  it('strips file URLs for a locked viewer but leaves other data', () => {
    const resp = {
      data: {
        admin_status: 'pending',
        section8: { ...restricted, evidence_files: ['https://x/a.pdf'], description: 'd' },
        section1: { attendance_logs: [{ evidence_url: 'https://x/b.jpg', hours: 2 }], media_urls: ['https://x/c.jpg'] },
        evidence_urls: ['https://x/a.pdf'],
        review_package: { documents: { evidence: { count: 1, files: [{ url: 'u' }] } } },
      },
    };
    const out = applyEvidenceAccess(resp, 'partner').data as any;
    expect(JSON.stringify(out)).not.toContain('https://x/');
    expect(out.section8.description).toBe('d');
    expect(out.section1.attendance_logs[0].hours).toBe(2);
    expect(out.review_package.documents.evidence.count).toBe(0);
    expect(out.evidence_access.can_view).toBe(false);
    expect(resp.data.evidence_urls).toHaveLength(1); // input not mutated
  });

  it('keeps URLs for admin and approved faculty, with message for pending faculty', () => {
    const resp = { data: { admin_status: 'pending', section8: { ...restricted, evidence_files: ['https://x/a'] } } };
    expect((applyEvidenceAccess(resp, 'admin').data as any).section8.evidence_files).toHaveLength(1);
    const f = applyEvidenceAccess(resp, 'faculty').data as any;
    expect(f.section8.evidence_files).toEqual([]);
    expect(f.evidence_access.message).toMatch(/Awaiting super-admin approval/);
    const approved = { data: { ...resp.data, admin_status: 'approved' } };
    expect((applyEvidenceAccess(approved, 'faculty').data as any).section8.evidence_files).toHaveLength(1);
  });
});
