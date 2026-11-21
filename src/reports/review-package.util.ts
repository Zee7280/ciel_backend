import { StudentReport } from './entities/student-report.entity';
import { collectReportEvidenceFiles } from './collect-report-evidence.util';
import { pickCiiV45DisplayScore } from './cii-v4-5-display.util';
import {
  buildCanonicalImpactPacket,
  IMPACT_PACKAGE_SYNC_CONTRACT,
  type CanonicalImpactPacket,
  type PacketIntegrity,
} from './impact-package-packet.util';

export type ReviewPackageEvidenceKind = 'image' | 'pdf' | 'video' | 'file';

export type ReviewPackageEvidenceItem = {
  url: string;
  name: string;
  source: string;
  kind: ReviewPackageEvidenceKind;
  previewable: boolean;
};

export type ReviewPackageAudience =
  | 'student'
  | 'faculty'
  | 'partner'
  | 'university'
  | 'admin';

export type ReportReviewPackage = {
  generated_at: string;
  report_id: string;
  schema: 'impact-package-v1';
  analysis_attached: boolean;
  documents: {
    flashcard: { title: string; view: 'flash'; href: string };
    detailed_report: { title: string; view: 'print'; href: string };
    evidence: {
      title: string;
      count: number;
      files: ReviewPackageEvidenceItem[];
    };
    analysis_report: { title: string; view: 'cii-v4-5'; href: string } | null;
  };
  admin_review_href: string;
  ai_analyser_href: string;
  admin_doc_hrefs: {
    flashcard: string;
    detailed_report: string;
    evidence: string;
    analysis_report: string;
  };
  stakeholder_hrefs: {
    student: string;
    faculty: string;
    partner: string;
    university: string;
    admin: string;
  };
  analysis_hrefs: {
    student: string;
    faculty: string;
    university: string;
    admin: string;
    partner: string;
  };
  sync_contract: typeof IMPACT_PACKAGE_SYNC_CONTRACT;
  packet_integrity: PacketIntegrity;
  canonical_packet: CanonicalImpactPacket;
};

/** Partner / NGO get the student bundle only. Faculty, student, university, admin get analysis after publish. */
export function reviewPackageIncludesAnalysis(
  audience: ReviewPackageAudience,
): boolean {
  return audience !== 'partner';
}

export function analysisIsAttached(
  report: Partial<StudentReport> | null | undefined,
): boolean {
  const lock = report?.ciiV45Lock as { locked?: unknown } | null | undefined;
  const locked = lock?.locked === true || lock?.locked === 'true';
  return Boolean(
    locked && pickCiiV45DisplayScore(report?.ciiV45, lock) != null,
  );
}

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
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif'].includes(ext))
    return 'image';
  if (ext === 'pdf') return 'pdf';
  if (['mp4', 'webm', 'mov', 'm4v'].includes(ext)) return 'video';
  if (/image\//i.test(url) || /\.(jpe?g|png|gif|webp)(\?|$)/i.test(url))
    return 'image';
  if (/\.pdf(\?|$)/i.test(url)) return 'pdf';
  return 'file';
}

function joinHref(base: string, path: string): string {
  const root = String(base || '').replace(/\/+$/, '');
  const rel = path.startsWith('/') ? path : `/${path}`;
  return root ? `${root}${rel}` : rel;
}

export type ReportPackageNoticeAudience =
  | 'student'
  | 'faculty'
  | 'partner'
  | 'university';

export type ReportPackageNotice = {
  audience: ReportPackageNoticeAudience;
  title: string;
  message: string;
  /** Relative dashboard path (the in-app notification opens it inside the same origin). */
  link: string;
};

/** `https://app/…/x?y#z` → `/…/x?y#z`; relative paths pass through. */
export function relativeAppPath(href: string): string {
  const value = String(href || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) {
    try {
      const u = new URL(value);
      return `${u.pathname}${u.search}${u.hash}`;
    } catch {
      return '';
    }
  }
  return value.startsWith('/') ? value : `/${value}`;
}

/**
 * In-app notices sent alongside the package e-mails once CIEL PK Admin approves a report. Each
 * audience lands on its own approved-package screen (student: flashcard; faculty: Impact Records;
 * partner / NGO: My Impact; university: Project Records), never on the raw report.
 */
export function buildReportPackageNotices(
  pack: Pick<ReportReviewPackage, 'stakeholder_hrefs' | 'documents'>,
  input: { projectTitle: string; studentName: string },
): ReportPackageNotice[] {
  const project = input.projectTitle || 'Community Service report';
  const student = input.studentName || 'The student';
  const notices: ReportPackageNotice[] = [
    {
      audience: 'student',
      title: 'Your impact report is approved',
      message: `CIEL PK approved your Community Service report for "${project}". Your flashcard, badge and permitted evidence are now on My Impact.`,
      link: relativeAppPath(pack.documents.flashcard.href),
    },
    {
      audience: 'faculty',
      title: 'Impact Package published',
      message: `CIEL PK approved ${student}'s report for "${project}". The approved package (flashcard, detailed report, permitted evidence) is open in Impact Records.`,
      link: relativeAppPath(pack.stakeholder_hrefs.faculty),
    },
    {
      audience: 'partner',
      title: 'Impact Package published',
      message: `CIEL PK approved the Community Service report for "${project}" linked to your organization. Open the approved package under My Impact.`,
      link: relativeAppPath(pack.stakeholder_hrefs.partner),
    },
    {
      audience: 'university',
      title: 'Impact Package published',
      message: `CIEL PK approved ${student}'s report for "${project}". The approved package is in Project Records and on your Impact Wall.`,
      link: relativeAppPath(pack.stakeholder_hrefs.university),
    },
  ];
  return notices.filter((n) => n.link);
}

export function buildReportReviewPackage(
  report: Pick<StudentReport, 'id' | 'opportunityId' | 'project_id'> &
    Partial<StudentReport>,
  frontendBase = '',
): ReportReviewPackage {
  const reportId = String(report.id || '').trim();
  const projectId = String(
    report.opportunityId || report.project_id || reportId,
  ).trim();
  const files = collectReportEvidenceFiles(report as StudentReport).map(
    (file) => {
      const kind = classifyReviewPackageEvidenceKind(file.url, file.name);
      return {
        url: file.url,
        name: file.name,
        source: file.source,
        kind,
        previewable: kind === 'image' || kind === 'pdf' || kind === 'video',
      };
    },
  );
  const adminReview = joinHref(
    frontendBase,
    `/dashboard/admin/reports/verify/${encodeURIComponent(reportId)}?package=1`,
  );
  const studentFlash = joinHref(
    frontendBase,
    `/dashboard/student/report?projectId=${encodeURIComponent(projectId)}&view=flash#flash`,
  );
  const studentDetailed = joinHref(
    frontendBase,
    `/dashboard/student/report?projectId=${encodeURIComponent(projectId)}&view=print#report`,
  );
  const facultyHref = joinHref(
    frontendBase,
    `/dashboard/faculty/reports/${encodeURIComponent(reportId)}?view=dossier`,
  );
  const facultyAnalysisHref = joinHref(
    frontendBase,
    `/dashboard/faculty/reports/${encodeURIComponent(reportId)}?view=dossier#analysis`,
  );
  const partnerHref = joinHref(
    frontendBase,
    `/dashboard/partner/verify/${encodeURIComponent(reportId)}?package=1`,
  );
  const universityHref = joinHref(
    frontendBase,
    `/dashboard/partner/verify/${encodeURIComponent(reportId)}?package=1`,
  );
  const analyserHref = joinHref(
    frontendBase,
    `/dashboard/admin/reports/verify/${encodeURIComponent(reportId)}?view=cii-v4-5`,
  );
  const analysisAttached = analysisIsAttached(report);
  const studentAnalysis = joinHref(
    frontendBase,
    `/dashboard/student/report?projectId=${encodeURIComponent(projectId)}&view=analysis#analysis`,
  );
  const packet = buildCanonicalImpactPacket(report);
  return {
    generated_at: new Date().toISOString(),
    report_id: reportId,
    schema: 'impact-package-v1',
    analysis_attached: analysisAttached,
    documents: {
      flashcard: {
        title: 'Impact flashcard',
        view: 'flash',
        href: studentFlash,
      },
      detailed_report: {
        title: 'Detailed report',
        view: 'print',
        href: studentDetailed,
      },
      evidence: {
        title: 'Evidence gallery',
        count: files.length,
        files,
      },
      analysis_report: analysisAttached
        ? {
            title: 'Analysis report',
            view: 'cii-v4-5',
            href: studentAnalysis,
          }
        : null,
    },
    admin_review_href: adminReview,
    ai_analyser_href: analyserHref,
    admin_doc_hrefs: {
      flashcard: `${adminReview}&doc=flashcard`,
      detailed_report: `${adminReview}&doc=report`,
      evidence: `${adminReview}&doc=evidence`,
      analysis_report: analyserHref,
    },
    stakeholder_hrefs: {
      student: studentFlash,
      faculty: facultyHref,
      partner: partnerHref,
      university: universityHref,
      admin: adminReview,
    },
    analysis_hrefs: {
      student: studentAnalysis,
      faculty: facultyAnalysisHref,
      university: `${universityHref}&doc=analysis`,
      admin: analyserHref,
      partner: '',
    },
    sync_contract: IMPACT_PACKAGE_SYNC_CONTRACT,
    packet_integrity: packet.packet_integrity,
    canonical_packet: packet,
  };
}
