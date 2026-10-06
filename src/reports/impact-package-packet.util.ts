import { BadRequestException } from '@nestjs/common';
import { StudentReport } from './entities/student-report.entity';
import { collectReportEvidenceFiles } from './collect-report-evidence.util';

/** Locked Student Report → Impact Package contract (HTML FINAL-110-SYNC). */
export const IMPACT_PACKAGE_SYNC_CONTRACT = {
  contract_version: '2026-10-06-FINAL-SYNC-1',
  schema_version: '3.0',
  framework_version: '5.1-FINAL',
  content_sections: 9,
  final_authority: 'CIEL PK Super Admin',
  scoring: {
    rule: 'AI_REPORT_QUALITY_85_PLUS_ADMIN_EVIDENCE_15_ONLY',
    ai_max: 85,
    admin_evidence_max: 15,
    final_max: 100,
  },
} as const;

export const IMPACT_PACKAGE_CONTENT_SOURCES = [
  { id: '1', name: 'Participation & Individual Effort', keys: ['section1'] },
  { id: '2', name: 'Community Need & Starting Point', keys: ['section2'] },
  { id: '3', name: 'SDG Contribution', keys: ['section3'] },
  {
    id: '4',
    name: 'Activities, Outputs & Measured Change',
    keys: ['section4', 'section5'],
  },
  { id: '5', name: 'Resources & Stewardship', keys: ['section6'] },
  { id: '6', name: 'Partnership & Collaboration', keys: ['section7'] },
  { id: '7', name: 'Evidence, Ethics & Verification', keys: ['section8'] },
  { id: '8', name: 'Reflection & Academic Growth', keys: ['section9'] },
  { id: '9', name: 'Sustainability & Handover', keys: ['section10'] },
] as const;

export type PacketIntegrity = {
  ok: boolean;
  issues: string[];
  content_sections: number;
  answer_fields: number;
  evidence_files: number;
};

export type CanonicalImpactPacket = {
  schema_version: string;
  report_id: string;
  flashcard: { title: string; project_id: string };
  detailed_report: {
    sections: Array<{
      id: string;
      name: string;
      source: string[];
      present: boolean;
    }>;
  };
  evidence: { files: Array<{ url: string; name: string; source: string }> };
  signoff: {
    submitted_at: string | null;
    status: string;
    final_authority: string;
  };
  packet_integrity: PacketIntegrity;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function countOwnKeys(value: unknown): number {
  const rec = asRecord(value);
  return rec ? Object.keys(rec).length : 0;
}

export function validateImpactPackagePacket(
  report: Partial<StudentReport> | Record<string, unknown> | null | undefined,
): PacketIntegrity {
  const row = (report || {}) as Record<string, unknown>;
  const issues: string[] = [];
  let present = 0;
  let fields = 0;
  for (const src of IMPACT_PACKAGE_CONTENT_SOURCES) {
    const missing = src.keys.filter((key) => !asRecord(row[key]));
    if (missing.length) {
      issues.push(
        `Missing Detailed Report content section ${src.id} (${src.name}).`,
      );
    } else {
      present += 1;
    }
    for (const key of src.keys) fields += countOwnKeys(row[key]);
  }
  const files = collectReportEvidenceFiles(row as StudentReport);
  return {
    ok: issues.length === 0,
    issues,
    content_sections: present,
    answer_fields: fields,
    evidence_files: files.length,
  };
}

export function assertPacketReadyForAnalysis(
  report: Partial<StudentReport> | Record<string, unknown> | null | undefined,
): PacketIntegrity {
  const integrity = validateImpactPackagePacket(report);
  if (!integrity.ok) {
    throw new BadRequestException(
      `Student packet integrity HOLD · ${integrity.issues.length} issue(s). The AI Analyser must not score this package until corrected. ${integrity.issues.join(' ')}`,
    );
  }
  return integrity;
}

export function buildCanonicalImpactPacket(
  report: Pick<StudentReport, 'id'> & Partial<StudentReport>,
): CanonicalImpactPacket {
  const integrity = validateImpactPackagePacket(report);
  const files = collectReportEvidenceFiles(report as StudentReport);
  const opportunity = asRecord(report.opportunity);
  const title =
    (typeof opportunity?.title === 'string' && opportunity.title.trim()) ||
    String(report.project_id || report.id || 'Community engagement report');
  return {
    schema_version: IMPACT_PACKAGE_SYNC_CONTRACT.schema_version,
    report_id: String(report.id || ''),
    flashcard: {
      title,
      project_id: String(report.opportunityId || report.project_id || report.id || ''),
    },
    detailed_report: {
      sections: IMPACT_PACKAGE_CONTENT_SOURCES.map((src) => ({
        id: src.id,
        name: src.name,
        source: [...src.keys],
        present: src.keys.every((key) => asRecord((report as Record<string, unknown>)[key])),
      })),
    },
    evidence: { files },
    signoff: {
      submitted_at: report.reportSubmittedAt
        ? new Date(report.reportSubmittedAt).toISOString()
        : report.submission_date
          ? new Date(report.submission_date).toISOString()
          : null,
      status: String(report.status || ''),
      final_authority: IMPACT_PACKAGE_SYNC_CONTRACT.final_authority,
    },
    packet_integrity: integrity,
  };
}
