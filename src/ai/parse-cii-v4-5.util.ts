import { extractSection11JsonObject } from './parse-section11-v61.util';
import {
  CiiV45Claim,
  CiiV45EvaluatorPayload,
  CiiV45EvidenceAudit,
  CiiV45Privacy,
  CiiV45ProcessingStatus,
  CiiV45SupportStatus,
  normalizeCiiV5AiPayload,
} from '../reports/cii-v4-5.constants';

/**
 * Parses the CII v4.5 AI evaluator's raw JSON response.
 *
 * Required top-level keys must still be present. Claim/evidence *rows* are
 * coerced (string booleans, MATCH/PARTIAL aliases, missing id arrays) so a
 * readable JSON object is not rejected as "Invalid claim inventory".
 */

const REQUIRED_KEYS: (keyof CiiV45EvaluatorPayload)[] = [
  'sectionScores',
];

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function parseCiiV45Response(raw: string): CiiV45EvaluatorPayload | null {
  const parsed = extractSection11JsonObject(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const value = parsed as Record<string, unknown>;

  // exceptionalFeature is nullable; v5.0.2 report-quality JSON does not require
  // inputCompleteness / deductionLedger / echo IDs (the server injects those).
  for (const key of REQUIRED_KEYS) {
    if (!hasOwn(value, key) || value[key] === undefined) return null;
  }

  const framework = String(value.frameworkVersion ?? '5.0').trim();
  if (framework !== '5.0' && framework !== '4.5') return null;
  value.frameworkVersion = '5.0';
  const reportId =
    (typeof value.reportId === 'string' && value.reportId.trim()) ||
    (typeof value.report_id === 'string' && value.report_id.trim()) ||
    'pending';
  const inputFingerprint =
    (typeof value.inputFingerprint === 'string' && value.inputFingerprint.trim()) ||
    (typeof value.input_fingerprint === 'string' && value.input_fingerprint.trim()) ||
    'pending';
  value.reportId = reportId;
  value.inputFingerprint = inputFingerprint;
  if (!Array.isArray(value.sectionScores)) return null;
  if (!Array.isArray(value.adminReviewReasons)) value.adminReviewReasons = [];
  if (!Array.isArray(value.strengths)) value.strengths = [];
  if (!Array.isArray(value.developmentPriorities)) value.developmentPriorities = [];
  if (typeof value.analysisSummary !== 'string') value.analysisSummary = '';
  if (typeof value.studentFeedback !== 'string') value.studentFeedback = '';
  if (!Array.isArray(value.claimInventory)) value.claimInventory = [];
  if (!Array.isArray(value.evidenceAudit)) value.evidenceAudit = [];
  if (!Array.isArray(value.deductionLedger)) value.deductionLedger = [];
  if (!Array.isArray(value.sectionAnalyses)) value.sectionAnalyses = [];
  if (!Array.isArray(value.extraMileCandidates)) value.extraMileCandidates = [];
  if (typeof value.evidenceSummary !== 'string') value.evidenceSummary = '';
  if (!value.extraMileUplift || typeof value.extraMileUplift !== 'object') {
    value.extraMileUplift = { assessmentStatus: 'PENDING_ADMIN', items: [] };
  }
  if (!value.inputCompleteness || typeof value.inputCompleteness !== 'object') {
    value.inputCompleteness = {
      gaps: [],
      individualHours: [{ studentId: 'pending', hours: null, requiredHours: 16, verified: false, recordComplete: false }],
      mandatoryFieldsComplete: true,
    };
  }
  if (!hasOwn(value, 'exceptionalFeature')) value.exceptionalFeature = null;

  const payload = value as unknown as CiiV45EvaluatorPayload;

  // The AI must never assert a positive integrity penalty — only a separately-saved, verified
  // Admin adjudication can. Force it to zero/empty on ingestion.
  payload.integrityPenalty = { points: 0, issues: [] };
  normalizeClaimAndEvidenceArrays(payload);

  return normalizeCiiV5AiPayload(payload);
}

const SUPPORT_ALIASES: Record<string, CiiV45SupportStatus> = {
  SUPPORTED: 'SUPPORTED',
  SUPPORT: 'SUPPORTED',
  MATCH: 'SUPPORTED',
  MATCHED: 'SUPPORTED',
  VERIFIED: 'SUPPORTED',
  PARTIALLY_SUPPORTED: 'PARTIALLY_SUPPORTED',
  PARTIAL: 'PARTIALLY_SUPPORTED',
  PARTIALLY: 'PARTIALLY_SUPPORTED',
  UNSUPPORTED: 'UNSUPPORTED',
  UNMATCHED: 'UNSUPPORTED',
  NONE: 'UNSUPPORTED',
  CONTRADICTED: 'CONTRADICTED',
  CONTRADICT: 'CONTRADICTED',
  PROCESSING_REQUIRED: 'PROCESSING_REQUIRED',
  PROCESSING: 'PROCESSING_REQUIRED',
  PENDING: 'PROCESSING_REQUIRED',
  INACCESSIBLE: 'PROCESSING_REQUIRED',
  UNKNOWN: 'PROCESSING_REQUIRED',
};

const PRIVACY_ALIASES: Record<string, CiiV45Privacy> = {
  PUBLIC: 'PUBLIC',
  RESTRICTED: 'RESTRICTED',
  PRIVATE: 'PRIVATE',
};

const PROCESSING_ALIASES: Record<string, CiiV45ProcessingStatus> = {
  INSPECTED: 'INSPECTED',
  UNREADABLE: 'UNREADABLE',
  CORRUPTED: 'CORRUPTED',
  CONVERSION_FAILED: 'CONVERSION_FAILED',
  INACCESSIBLE: 'INACCESSIBLE',
  DUPLICATE: 'DUPLICATE',
  NOT_INSPECTED: 'INACCESSIBLE',
  UNSEEN: 'INACCESSIBLE',
  FAILED: 'CONVERSION_FAILED',
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (['true', 'yes', '1'].includes(s)) return true;
    if (['false', 'no', '0'].includes(s)) return false;
  }
  return fallback;
}

function asStringId(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function asStringIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => asStringId(item)).filter(Boolean);
}

function enumFromAlias<T extends string>(
  value: unknown,
  aliases: Record<string, T>,
  fallback: T,
): T {
  const key = asStringId(value).toUpperCase().replace(/[\s-]+/g, '_');
  return aliases[key] ?? fallback;
}

function uniqueId(base: string, used: Set<string>): string {
  const seed = base || 'id';
  if (!used.has(seed)) {
    used.add(seed);
    return seed;
  }
  let n = 2;
  while (used.has(`${seed}-${n}`)) n += 1;
  const next = `${seed}-${n}`;
  used.add(next);
  return next;
}

/**
 * gpt-5.6-sol often emits claim/evidence rows that parse as JSON but fail
 * `computeCiiV45Result` (string booleans, MATCH/PARTIAL instead of the v4.5
 * support enum, missing evidenceIds). Coerce those here so Analyze can score
 * instead of 400 "Invalid claim inventory".
 */
function normalizeClaimAndEvidenceArrays(payload: CiiV45EvaluatorPayload): void {
  const usedEvidence = new Set<string>();
  payload.evidenceAudit = (Array.isArray(payload.evidenceAudit) ? payload.evidenceAudit : []).map(
    (raw, i) => {
      const rec = asRecord(raw);
      const evidenceId = uniqueId(
        asStringId(rec.evidenceId || rec.id || rec.file_id) || `E${i + 1}`,
        usedEvidence,
      );
      const row: CiiV45EvidenceAudit = {
        evidenceId,
        fileName: typeof rec.fileName === 'string' ? rec.fileName : undefined,
        fileType: typeof rec.fileType === 'string' ? rec.fileType : undefined,
        privacy: enumFromAlias(rec.privacy, PRIVACY_ALIASES, 'RESTRICTED'),
        material: asBoolean(rec.material, true),
        processingStatus: enumFromAlias(rec.processingStatus, PROCESSING_ALIASES, 'INACCESSIBLE'),
        claimIds: asStringIds(rec.claimIds),
        actualContentSummary:
          typeof rec.actualContentSummary === 'string' ? rec.actualContentSummary : undefined,
        matchConfidence:
          typeof rec.matchConfidence === 'number' && Number.isFinite(rec.matchConfidence)
            ? rec.matchConfidence
            : null,
        supportStatus: enumFromAlias(
          rec.supportStatus ?? rec.status,
          SUPPORT_ALIASES,
          'PROCESSING_REQUIRED',
        ),
        evidenceStrength: typeof rec.evidenceStrength === 'string' ? rec.evidenceStrength : undefined,
        independence: typeof rec.independence === 'string' ? rec.independence : undefined,
        explanation: typeof rec.explanation === 'string' ? rec.explanation : undefined,
      };
      return row;
    },
  );
  const evidenceIds = payload.evidenceAudit.map((e) => e.evidenceId);

  const usedClaims = new Set<string>();
  payload.claimInventory = (Array.isArray(payload.claimInventory) ? payload.claimInventory : []).map(
    (raw, i) => {
      if (typeof raw === 'string') {
        return {
          claimId: uniqueId(`C${i + 1}`, usedClaims),
          text: raw.trim(),
          material: Boolean(raw.trim()),
          evidenceIds: [],
          supportStatus: 'PROCESSING_REQUIRED' as const,
        };
      }
      const rec = asRecord(raw);
      const text = typeof rec.text === 'string' ? rec.text : undefined;
      const row: CiiV45Claim = {
        claimId: uniqueId(asStringId(rec.claimId || rec.id) || `C${i + 1}`, usedClaims),
        text,
        material: asBoolean(rec.material, Boolean(text?.trim())),
        evidenceIds: asStringIds(rec.evidenceIds).filter((id) => evidenceIds.includes(id)),
        supportStatus: enumFromAlias(
          rec.supportStatus ?? rec.status ?? rec.claimSupport,
          SUPPORT_ALIASES,
          'PROCESSING_REQUIRED',
        ),
      };
      return row;
    },
  );
  const claimIds = payload.claimInventory.map((c) => c.claimId);
  for (const evidence of payload.evidenceAudit) {
    evidence.claimIds = evidence.claimIds.filter((id) => claimIds.includes(id));
  }
}
