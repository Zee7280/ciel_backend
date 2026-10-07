import { isCiiFacultyLocked } from '../reports/community-award.util';
import { pickCiiV45DisplayScore } from '../reports/cii-v4-5-display.util';
import { isCommunityAwardMedalReport } from '../reports/community-award.util';
import { reportIndividualHoursMet } from '../reports/build-ciel-pk-ai-evaluation-payload.util';
import {
  IMPACT_PACKAGE_SYNC_CONTRACT,
  validateImpactPackagePacket,
} from '../reports/impact-package-packet.util';
import { StudentReport } from '../reports/entities/student-report.entity';
import { NPE_CII_SCALE, type NpePackageStatus } from './npe-ranking.constants';

export type NpePackageRecord = {
  id: string;
  title: string;
  university: string;
  pathway: string;
  version: string;
  approval: 'approved' | 'pending' | 'rejected';
  cii: number | null;
  ciiLocked: boolean;
  ciiScale: typeof NPE_CII_SCALE;
  packageComplete: boolean;
  hoursMet: boolean;
  consentComplete: boolean;
  evidenceAccessible: boolean;
  integrity: 'clear' | 'review' | 'confirmed_fraud';
  parts: string[];
};

export type NpeGate = { status: NpePackageStatus; reason: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function npePackageVersion(report: StudentReport): string {
  const stored = asRecord(report.review_package);
  const schema =
    (typeof stored?.schema_version === 'string' && stored.schema_version) ||
    IMPACT_PACKAGE_SYNC_CONTRACT.schema_version;
  const stamp = report.reportSubmittedAt || report.submission_date || report.updatedAt;
  return `${schema}:${new Date(stamp).toISOString()}`;
}

export function npePathway(report: StudentReport): string {
  const s2 = asRecord(report.section2);
  const opp = asRecord(report.opportunity);
  const fromS2 =
    (typeof s2?.discipline === 'string' && s2.discipline.trim()) ||
    (typeof s2?.project_type === 'string' && s2.project_type.trim()) ||
    '';
  const fromOpp =
    (typeof opp?.category === 'string' && opp.category.trim()) ||
    (Array.isArray(opp?.types) ? String(opp.types[0] || '').trim() : '');
  return fromS2 || fromOpp || 'Community service';
}

export function npeUniversity(report: StudentReport): string {
  const s1 = asRecord(report.section1);
  const lead = asRecord(s1?.team_lead);
  return (
    (typeof lead?.university === 'string' && lead.university.trim()) ||
    report.student?.university ||
    report.student?.institution ||
    '—'
  );
}

export function gateNpePackage(p: NpePackageRecord): NpeGate {
  if (p.approval === 'rejected' || p.integrity === 'confirmed_fraud') {
    return {
      status: 'Excluded',
      reason: 'Report rejected or integrity violation confirmed.',
    };
  }
  const issues: string[] = [];
  if (p.approval !== 'approved') issues.push('Report awaiting approval');
  if (
    p.ciiLocked !== true ||
    p.cii == null ||
    !Number.isFinite(p.cii) ||
    p.cii < 0 ||
    p.cii > 110 ||
    p.ciiScale !== NPE_CII_SCALE
  ) {
    issues.push('CII lock / scale not validated');
  }
  if (p.packageComplete !== true) issues.push('Incomplete report package');
  if (p.hoursMet !== true) issues.push('Required individual hours not verified');
  if (p.consentComplete !== true) issues.push('Declarations / consent incomplete');
  if (p.evidenceAccessible !== true) issues.push('Evidence access incomplete');
  if (p.integrity !== 'clear') issues.push('Integrity requires review');
  return {
    status: issues.length ? 'Review' : 'Eligible',
    reason: issues.join('; ') || 'All eligibility checks passed.',
  };
}

export function buildNpePackageRecord(report: StudentReport): NpePackageRecord {
  const medal = isCommunityAwardMedalReport({
    status: report.status,
    faculty_status: report.faculty_status,
    admin_status: report.admin_status,
  });
  const overall = String(report.status || '').toLowerCase();
  const approval: NpePackageRecord['approval'] =
    overall === 'rejected' || overall === 'declined' || overall === 'closed'
      ? 'rejected'
      : medal
        ? 'approved'
        : 'pending';
  const ciiLocked = isCiiFacultyLocked(report.ciiV45Lock);
  const cii = pickCiiV45DisplayScore(report.ciiV45, report.ciiV45Lock);
  const stored = asRecord(report.review_package);
  const storedOk = asRecord(stored?.packet_integrity)?.ok === true;
  const live = validateImpactPackagePacket(report);
  const packageComplete = storedOk || live.ok;
  const files = Array.isArray(asRecord(report.section8)?.evidence_files)
    ? (asRecord(report.section8)?.evidence_files as unknown[])
    : [];
  return {
    id: report.id,
    title:
      report.opportunity?.title ||
      report.project_id ||
      'Community service',
    university: npeUniversity(report),
    pathway: npePathway(report),
    version: npePackageVersion(report),
    approval,
    cii,
    ciiLocked,
    ciiScale: NPE_CII_SCALE,
    packageComplete,
    hoursMet: reportIndividualHoursMet(report),
    consentComplete: medal || overall === 'submitted' || overall === 'verified',
    evidenceAccessible: files.length === 0 || files.every((f) => {
      const rec = asRecord(f);
      return Boolean(rec && (typeof rec.url === 'string' && rec.url.trim()));
    }),
    integrity: approval === 'rejected' ? 'confirmed_fraud' : 'clear',
    parts: [
      'Flashcard',
      'V13 detailed report',
      'Original evidence',
      'CII analysis',
      'Locked CII',
    ],
  };
}
