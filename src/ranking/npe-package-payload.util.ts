/**
 * What the national / university ranking AI is given for ONE approved project: the whole combined
 * package, not a summary of it.
 *
 *   1. Flashcard        — identity, period, SDG, team, hours, locked CII and badge (orientation)
 *   2. Detailed report  — all nine content sections (S1 – S10), exactly as the student filed them
 *   3. System analysis  — the Admin-approved CII: score, badge, strengths, development priorities,
 *                         evidence summary, review reasons, quality gates and approval record
 *   4. Evidence         — manifest of every attached file (the originals the analyzer can read are
 *                         attached separately by AiService; see evidence read status)
 *
 * Personal data (CNIC, phone, e-mail, WhatsApp, password-like keys) is stripped at any depth, and
 * the same patterns are scrubbed from free text, so nothing identifying leaves the platform.
 * Section 11 (declarations and any stored AI score) is never sent.
 */
import { StudentReport } from '../reports/entities/student-report.entity';
import { IMPACT_PACKAGE_CONTENT_SOURCES } from '../reports/impact-package-packet.util';
import type { ReportEvidenceFileRef } from '../reports/collect-report-evidence.util';
import type { NpePackageRecord } from './npe-ranking-eligibility';
import { buildStudioFacets } from './npe-studio.util';
import { scrubPersonalText } from '../common/scrub-personal-text.util';

export { scrubPersonalText };

const MAX_DEPTH = 14;

/** Key names (case, `_` and `-` ignored) that identify a person or carry a credential. */
const SENSITIVE_KEYS = new Set([
  'cnic', 'cnicnumber', 'cnichash', 'cniclast4', 'nic', 'nationalid', 'idnumber',
  'phone', 'phonenumber', 'mobile', 'mobilenumber', 'whatsapp', 'whatsappnumber', 'whatsappe164',
  'contactphone', 'contactnumber', 'email', 'emailaddress', 'officialemail', 'contactemail',
  'studentemail', 'password', 'passwordhash', 'token', 'accesstoken', 'otp',
]);

function normKey(key: string): string {
  return key.toLowerCase().replace(/[_\-\s]/g, '');
}

/** Deep copy without identifying keys; strings are scrubbed. Never mutates the stored report. */
export function redactSensitiveDeep(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrubPersonalText(value);
  if (value === null || typeof value !== 'object' || depth > MAX_DEPTH) return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((v) => redactSensitiveDeep(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(normKey(key))) continue;
    out[key] = redactSensitiveDeep(v, depth + 1);
  }
  return out;
}

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown): string {
  return typeof value === 'string' ? scrubPersonalText(value.trim()) : '';
}
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function buildNpeSystemAnalysis(report: StudentReport, pkg: NpePackageRecord) {
  const cii = rec(report.ciiV45);
  const lock = rec(report.ciiV45Lock);
  const badge = rec(lock.finalBadge ?? cii.finalBadge ?? cii.recommendedBadge);
  return {
    locked: pkg.ciiLocked,
    approvedScore: pkg.cii,
    badge: text(badge.name) || null,
    approvedAt: typeof lock.lockedAt === 'string' ? lock.lockedAt : null,
    approvalRef: typeof lock.hash === 'string' ? lock.hash.slice(0, 12) : null,
    adminNote: text(lock.adminNote),
    summary: text(cii.analysisSummary),
    strengths: list(cii.strengths).map((s) => redactSensitiveDeep(s)),
    developmentPriorities: list(cii.developmentPriorities).map((s) => redactSensitiveDeep(s)),
    evidenceSummary: text(cii.evidenceSummary),
    reviewReasons: list(cii.adminReviewReasons).map((s) => redactSensitiveDeep(s)),
    qualityGates: cii.qualityGates ?? null,
    note:
      'This is the Admin-approved CII record. It is context only: it must not be recomputed or changed, and no total CII is to be returned.',
  };
}

export function buildNpeAiPayload(
  report: StudentReport,
  pkg: NpePackageRecord,
  files: ReportEvidenceFileRef[],
) {
  const facets = buildStudioFacets(report);
  const system = buildNpeSystemAnalysis(report, pkg);
  return {
    projectId: report.id,
    packageVersion: pkg.version,
    title: pkg.title,
    university: pkg.university,
    pathway: pkg.pathway,
    lockedCii: pkg.cii,
    ciiLocked: pkg.ciiLocked,
    parts: pkg.parts,
    flashcard: {
      title: pkg.title,
      university: facets.university,
      department: facets.department,
      sdg: facets.sdg || null,
      period: { date: facets.date || null, year: facets.year || null, semester: facets.semester || null },
      city: facets.city || null,
      partner: facets.partner || null,
      activity: facets.activity || null,
      theme: facets.theme || null,
      teamSize: facets.teamSize,
      verifiedServiceHours: facets.verifiedHours,
      beneficiariesReported: facets.reach,
      resourcesMobilizedPkr: facets.funds,
      evidenceClassification: facets.privacy,
      approvedCii: pkg.cii,
      ciiBadge: facets.ciiBadge || null,
      note: 'Orientation only. The detailed report and the evidence carry the facts.',
    },
    sections: Object.fromEntries(
      IMPACT_PACKAGE_CONTENT_SOURCES.map((src) => [
        src.id,
        {
          name: src.name,
          content: src.keys.map((key) =>
            redactSensitiveDeep((report as unknown as Record<string, unknown>)[key]),
          ),
        },
      ]),
    ),
    // kept under its original name too, so older prompts / cached tooling still find it
    priorCii: { locked: pkg.ciiLocked, score: pkg.cii, summary: system.summary },
    systemAnalysis: system,
    uploaded_evidence_files: files.map((f, i) => ({
      file_id: `E${i + 1}`,
      file_name: f.name,
      url: f.url,
      file_type: f.name.split('.').pop() || '',
      source: f.source,
    })),
  };
}
