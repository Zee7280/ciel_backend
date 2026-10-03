import { buildReportReviewPackage, classifyReviewPackageEvidenceKind } from './review-package.util';
import { StudentReport } from './entities/student-report.entity';

describe('review-package.util', () => {
  it('classifies images, pdfs and other files', () => {
    expect(classifyReviewPackageEvidenceKind('https://cdn.example/a.jpg', 'a.jpg')).toBe('image');
    expect(classifyReviewPackageEvidenceKind('https://cdn.example/b.PDF', 'notes.pdf')).toBe('pdf');
    expect(classifyReviewPackageEvidenceKind('https://cdn.example/c.mp4', 'clip.mp4')).toBe('video');
    expect(classifyReviewPackageEvidenceKind('https://cdn.example/d.docx', 'letter.docx')).toBe('file');
  });

  it('builds the 3-document Super Admin review package from stored evidence', () => {
    const report = {
      id: 'rep-1',
      opportunityId: 'opp-1',
      project_id: 'opp-1',
      section8: {
        evidence_files: [
          { url: 'https://cdn.example/photo.png', name: 'classroom.png' },
          { url: 'https://cdn.example/register.pdf', name: 'attendance.pdf' },
        ],
      },
    } as unknown as StudentReport;

    const pack = buildReportReviewPackage(report, 'https://app.cielpk.com');

    expect(pack.documents.flashcard.view).toBe('v17');
    expect(pack.documents.detailed_report.view).toBe('print');
    expect(pack.documents.evidence.count).toBe(2);
    expect(pack.documents.evidence.files[0]).toMatchObject({
      kind: 'image',
      previewable: true,
      name: 'classroom.png',
    });
    expect(pack.documents.evidence.files[1].kind).toBe('pdf');
    expect(pack.admin_review_href).toContain('/dashboard/admin/reports/verify/rep-1');
    expect(pack.ai_analyser_href).toContain('view=cii-v2');
    expect(pack.documents.flashcard.href).toContain('view=v17');
    expect(pack.stakeholder_hrefs.faculty).toContain('/dashboard/faculty/reports/rep-1');
    expect(pack.stakeholder_hrefs.partner).toContain('/dashboard/partner/verify/rep-1');
    expect(pack.stakeholder_hrefs.university).toContain('/dashboard/partner/verify/rep-1');
    expect(pack.documents.analysis_report).toBeNull();
    expect(pack.analysis_attached).toBe(false);
    const locked = buildReportReviewPackage(
      {
        ...report,
        ciiV2: { final: 82 },
        ciiV2Lock: { locked: true },
      } as unknown as StudentReport,
      'https://app.cielpk.com',
    );
    expect(locked.analysis_attached).toBe(true);
    expect(locked.documents.analysis_report?.title).toBe('Analysis report');
    expect(locked.analysis_hrefs.student).toContain('#analysis');
    expect(locked.analysis_hrefs.partner).toBe('');
  });
});
