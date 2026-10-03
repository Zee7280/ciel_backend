import { StudentReport } from './entities/student-report.entity';
import { collectReportEvidenceFiles } from './collect-report-evidence.util';

export type ReviewPackageEvidenceKind = 'image' | 'pdf' | 'video' | 'file';

export type ReviewPackageEvidenceItem = {
  url: string;
  name: string;
  source: string;
  kind: ReviewPackageEvidenceKind;
  previewable: boolean;
};

export type ReportReviewPackage = {
  generated_at: string;
  report_id: string;
  documents: {
    flashcard: { title: string; view: 'v17'; href: string };
    detailed_report: { title: string; view: 'print'; href: string };
    evidence: {
      title: string;
      count: number;
      files: ReviewPackageEvidenceItem[];
    };
  };
  admin_review_href: string;
  ai_analyser_href: string;
  admin_doc_hrefs: {
    flashcard: string;
    detailed_report: string;
    evidence: string;
  };
  stakeholder_hrefs: {
    student: string;
    faculty: string;
    partner: string;
    university: string;
    admin: string;
  };
};

function extOf(url: string, name: string): string {
  const blob = `${name} ${url.split('?')[0]}`.toLowerCase();
  const match = blob.match(/\.([a-z0-9]{2,5})(?:$|[#?])/);
  return match?.[1] || '';
}

export function classifyReviewPackageEvidenceKind(
  url: string,
  name: string,
): ReviewPackageEvidenceKind {
  const ext = extOf(url, name);
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif'].includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (['mp4', 'webm', 'mov', 'm4v'].includes(ext)) return 'video';
  if (/image\//i.test(url) || /\.(jpe?g|png|gif|webp)(\?|$)/i.test(url)) return 'image';
  if (/\.pdf(\?|$)/i.test(url)) return 'pdf';
  return 'file';
}

function joinHref(base: string, path: string): string {
  const root = String(base || '').replace(/\/+$/, '');
  const rel = path.startsWith('/') ? path : `/${path}`;
  return root ? `${root}${rel}` : rel;
}

export function buildReportReviewPackage(
  report: Pick<StudentReport, 'id' | 'opportunityId' | 'project_id'> &
    Partial<StudentReport>,
  frontendBase = '',
): ReportReviewPackage {
  const reportId = String(report.id || '').trim();
  const projectId = String(report.opportunityId || report.project_id || reportId).trim();
  const files = collectReportEvidenceFiles(report as StudentReport).map((file) => {
    const kind = classifyReviewPackageEvidenceKind(file.url, file.name);
    return {
      url: file.url,
      name: file.name,
      source: file.source,
      kind,
      previewable: kind === 'image' || kind === 'pdf' || kind === 'video',
    };
  });
  const adminReview = joinHref(
    frontendBase,
    `/dashboard/admin/reports/verify/${encodeURIComponent(reportId)}?package=1`,
  );
  const studentFlash = joinHref(
    frontendBase,
    `/dashboard/student/report?projectId=${encodeURIComponent(projectId)}&view=v17`,
  );
  const studentDetailed = joinHref(
    frontendBase,
    `/dashboard/student/report?projectId=${encodeURIComponent(projectId)}&view=print`,
  );
  const facultyHref = joinHref(
    frontendBase,
    `/dashboard/faculty/reports/${encodeURIComponent(reportId)}`,
  );
  const partnerHref = joinHref(
    frontendBase,
    `/dashboard/partner/verify/${encodeURIComponent(reportId)}`,
  );
  return {
    generated_at: new Date().toISOString(),
    report_id: reportId,
    documents: {
      flashcard: {
        title: 'Revised flashcard',
        view: 'v17',
        href: studentFlash,
      },
      detailed_report: {
        title: 'Detailed report',
        view: 'print',
        href: studentDetailed,
      },
      evidence: {
        title: 'Evidence files',
        count: files.length,
        files,
      },
    },
    admin_review_href: adminReview,
    ai_analyser_href: joinHref(
      frontendBase,
      `/dashboard/admin/reports/verify/${encodeURIComponent(reportId)}?view=cii-v2`,
    ),
    admin_doc_hrefs: {
      flashcard: `${adminReview}&doc=flashcard`,
      detailed_report: `${adminReview}&doc=report`,
      evidence: `${adminReview}&doc=evidence`,
    },
    stakeholder_hrefs: {
      student: studentFlash,
      faculty: facultyHref,
      partner: partnerHref,
      university: partnerHref,
      admin: adminReview,
    },
  };
}
