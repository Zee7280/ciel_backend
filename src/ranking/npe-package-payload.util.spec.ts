import { buildNpeAiPayload, redactSensitiveDeep, scrubPersonalText } from './npe-package-payload.util';
import { buildNpePackageRecord } from './npe-ranking-eligibility';
import { collectReportEvidenceFiles } from '../reports/collect-report-evidence.util';

const report: any = {
  id: 'rep-1',
  studentId: 'stu-1',
  project_id: 'opp-1',
  status: 'verified',
  faculty_status: 'approved',
  admin_status: 'approved',
  reportSubmittedAt: new Date('2026-03-15T10:00:00Z'),
  updatedAt: new Date('2026-03-16T10:00:00Z'),
  primary_sdg_goal: 4,
  problem_category: 'Education',
  student: { university: 'Uni A', department: 'CS' },
  opportunity: { title: 'Reading Corner', types: ['Teaching'], location: { city: 'Lahore' } },
  section1: {
    participation_type: 'team',
    team_lead: { name: 'Lead', cnic: '35202-1234567-1', mobile: '0300-1234567', email: 'lead@x.pk', university: 'Uni A', degree: 'CS', hours: 20 },
    team_members: [{ name: 'Mate', cnic: '35202-7654321-9', phone: '03211234567', email: 'mate@x.pk', hours: 18, nested: { whatsapp: '+923001112233', note: 'call 0301-7654321 or mail a@b.com' } }],
    attendance_logs: [{ id: 'l1', date: '2026-02-01', hours: 3, description: 'Taught class', evidence_url: 'https://bkt.s3.amazonaws.com/a.jpg' }],
    metrics: { total_verified_hours: 38 },
    media_urls: ['https://bkt.s3.amazonaws.com/s1.jpg'],
  },
  section2: { problem_statement: 'Children cannot read. Contact principal@school.pk', baseline_evidence: ['Survey'] },
  section3: { primary_sdg: { goal_number: 4 } },
  section4: { activity_blocks: [{ title: 'Tutoring' }], project_summary: { distinct_total_beneficiaries: 120 } },
  section5: { observed_change: 'Reading scores up', measurable_outcomes: [{ baseline: 10, endline: 40 }] },
  section6: { use_resources: 'yes', resources: [{ amount: 5000, unit: 'PKR' }] },
  section7: { has_partners: 'yes', partners: [{ name: 'Trust', official_email: 'trust@ngo.org' }] },
  section8: { media_visible: 'public', evidence_files: [{ url: 'https://bkt.s3.amazonaws.com/receipt.pdf', name: 'receipt.pdf' }] },
  section9: { skills_grown: ['🎯 Leadership'], personal_learning: 'I learned a lot' },
  section10: { continuation_status: 'yes', continuation_details: 'School continues' },
  section11: { final_declaration: [true], signature_name: 'Lead', ai_generated_impact_score: 91, cii_index: { totalScore: 91 } },
  review_package: { packet_integrity: { ok: true } },
  ciiV45: {
    finalCII: 88,
    analysisSummary: 'Strong, well documented project.',
    strengths: ['Clear baseline', 'Partner verified'],
    developmentPriorities: ['Add follow-up survey'],
    evidenceSummary: 'Receipts and photos consistent.',
    adminReviewReasons: ['Check hours'],
    qualityGates: { L4: true, L5: true, L6: false },
    finalBadge: { name: 'Advanced' },
  },
  ciiV45Lock: { locked: true, adminApprovedScore: 88, lockedAt: '2026-04-01T00:00:00Z', hash: 'abcdef1234567890', adminNote: 'Approved after review by admin@ciel.pk', finalBadge: { name: 'Advanced' } },
};

const build = () => {
  const pkg = buildNpePackageRecord(report);
  return { pkg, payload: buildNpeAiPayload(report, pkg, collectReportEvidenceFiles(report)) as any };
};

describe('NPE AI payload: the complete package goes to the model', () => {
  it('carries all four parts: flashcard, all nine report sections, system analysis, evidence manifest', () => {
    const { payload } = build();
    // 1 flashcard
    expect(payload.flashcard).toMatchObject({
      title: 'Reading Corner', university: 'Uni A', sdg: 'SDG 4', city: 'Lahore', activity: 'Teaching', theme: 'Education',
      teamSize: 2, verifiedServiceHours: 38, beneficiariesReported: 120, resourcesMobilizedPkr: 5000,
      evidenceClassification: 'Public', approvedCii: 88, ciiBadge: 'Advanced',
    });
    expect(payload.flashcard.period).toMatchObject({ year: '2026', semester: 'Spring' });
    // 2 detailed report: nine content sections, S4 holds section4 + section5, none dropped
    expect(Object.keys(payload.sections)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
    expect(payload.sections['4'].content).toHaveLength(2);
    const text = JSON.stringify(payload.sections);
    for (const must of ['Children cannot read', 'Tutoring', 'Reading scores up', 'PKR', 'Trust', 'receipt.pdf', 'Leadership', 'I learned a lot', 'School continues', 'Taught class']) {
      expect({ must, present: text.includes(must) }).toEqual({ must, present: true });
    }
    // 3 system analysis (the approved CII record)
    expect(payload.systemAnalysis).toMatchObject({
      locked: true, approvedScore: 88, badge: 'Advanced', summary: 'Strong, well documented project.',
      strengths: ['Clear baseline', 'Partner verified'], developmentPriorities: ['Add follow-up survey'],
      evidenceSummary: 'Receipts and photos consistent.', reviewReasons: ['Check hours'], approvalRef: 'abcdef123456',
    });
    expect(payload.priorCii.summary).toBe('Strong, well documented project.');
    // 4 evidence manifest: every attached file, with the section it came from
    const names = payload.uploaded_evidence_files.map((f: any) => f.file_name).sort();
    expect(names).toEqual(['a.jpg', 'receipt.pdf', 's1.jpg']);
    expect(payload.uploaded_evidence_files.map((f: any) => f.file_id)).toEqual(['E1', 'E2', 'E3']);
    expect(payload.uploaded_evidence_files.every((f: any) => f.source)).toBe(true);
  });

  it('never sends section 11 or any stored AI score', () => {
    const { payload } = build();
    const all = JSON.stringify(payload);
    expect(all).not.toContain('ai_generated_impact_score');
    expect(all).not.toContain('signature_name');
    expect(all).not.toContain('final_declaration');
    expect(all).not.toContain('cii_index');
  });

  it('strips CNIC, phone, mobile, WhatsApp and e-mail at ANY depth and scrubs them from free text', () => {
    const { payload } = build();
    const all = JSON.stringify(payload);
    for (const leaked of ['35202-1234567-1', '35202-7654321-9', '0300-1234567', '03211234567', '+923001112233', '0301-7654321', 'lead@x.pk', 'mate@x.pk', 'a@b.com', 'principal@school.pk', 'trust@ngo.org', 'admin@ciel.pk']) {
      expect({ leaked, found: all.includes(leaked) }).toEqual({ leaked, found: false });
    }
    // the people and their hours are still there: only the identifiers go
    expect(all).toContain('Lead');
    expect(all).toContain('Mate');
    expect(payload.sections['1'].content[0].team_lead.hours).toBe(20);
    expect(payload.sections['1'].content[0].team_members[0].hours).toBe(18);
  });

  it('does not mutate the stored report', () => {
    const before = JSON.stringify(report);
    build();
    expect(JSON.stringify(report)).toBe(before);
  });

  it('survives a thin report without throwing', () => {
    const thin: any = { id: 'x', status: 'verified', updatedAt: new Date(), opportunity: {}, student: {} };
    const pkg = buildNpePackageRecord(thin);
    expect(() => buildNpeAiPayload(thin, pkg, [])).not.toThrow();
    const out: any = buildNpeAiPayload(thin, pkg, []);
    expect(out.uploaded_evidence_files).toEqual([]);
    expect(Object.keys(out.sections)).toHaveLength(9);
  });

  it('scrubber and deep redactor handle odd input', () => {
    expect(scrubPersonalText('Mail me at a.b@c.org or 0300 1234567, id 3520212345671')).toBe('Mail me at [email removed] or [phone removed], id [id removed]');
    expect(redactSensitiveDeep(null)).toBeNull();
    expect(redactSensitiveDeep(5)).toBe(5);
    expect(redactSensitiveDeep([{ CNIC: 'x', Mobile_Number: 'y', keep: 'ok' }])).toEqual([{ keep: 'ok' }]);
    const cyc: any = { a: 1 }; cyc.self = cyc;
    expect(() => redactSensitiveDeep(cyc)).not.toThrow(); // depth-limited, never loops forever
  });
});
