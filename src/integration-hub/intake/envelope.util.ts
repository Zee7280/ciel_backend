import { ExternalAttestation, ExternalMetricValue } from '../entities';
import { HUB_HARD_LIMITS, isUuid } from '../hub-common.util';

export const HUB_SCHEMA_VERSION = '1.0';

export const HUB_EVENT_TYPES = [
  'activity.session',
  'impact.metric',
  'evidence.item',
  'activity.corrected',
  'activity.voided',
] as const;
export type HubEventType = (typeof HUB_EVENT_TYPES)[number];

export type HubEnvelope = {
  schema_version: string;
  event_id: string;
  event_type: HubEventType;
  connection_id: string;
  occurred_at: string;
  activity: { external_id: string; type: string; title?: string };
  payload?: Record<string, unknown>;
  metrics?: ExternalMetricValue[];
  evidence?: Array<{ upload_id: string }>;
  attestation?: ExternalAttestation;
  correlation?: { corrects?: string | null; voids?: string | null };
};

export type EnvelopeValidation =
  | { ok: true; value: HubEnvelope; bytes: number }
  | { ok: false; code: string; errors: string[]; eventId: string | null };

const PERSONAL_KEY =
  /(^|_)(name|first_name|last_name|full_name|email|e_mail|phone|mobile|cnic|national_id|nic|passport|address|dob|date_of_birth|birth_date|student_id|roll_no|roll_number|registration_no|reg_no|father_name|guardian)($|_)/i;
// Unanchored on purpose: an e-mail or CNIC embedded in free text is still personal data.
const PERSONAL_VALUE_EMAIL = /[^\s@<>()[\]]+@[^\s@<>()[\]]+\.[a-z]{2,}/i;
const PERSONAL_VALUE_CNIC = /(^|\D)\d{5}-?\d{7}-?\d(\D|$)/;

/** Keys (dot paths) in the payload that look like personal data of an individual. */
export function findPersonalFields(
  payload: unknown,
  prefix = '',
  depth = 0,
): string[] {
  const found: string[] = [];
  if (depth > 6 || payload === null || typeof payload !== 'object')
    return found;
  const entries = Array.isArray(payload)
    ? payload.map((v, i) => [String(i), v] as const)
    : Object.entries(payload as Record<string, unknown>);
  for (const [key, value] of entries) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!Array.isArray(payload) && PERSONAL_KEY.test(key)) {
      found.push(path);
      continue;
    }
    if (typeof value === 'string') {
      if (PERSONAL_VALUE_EMAIL.test(value) || PERSONAL_VALUE_CNIC.test(value)) {
        found.push(path);
      }
      continue;
    }
    if (value && typeof value === 'object') {
      found.push(...findPersonalFields(value, path, depth + 1));
    }
  }
  return found;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max
    ? v.trim()
    : null;
}

export function validateEnvelope(raw: unknown): EnvelopeValidation {
  const errors: string[] = [];
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      code: 'ENVELOPE_INVALID',
      errors: ['event must be an object'],
      eventId: null,
    };
  }
  const eventId = str(raw.event_id, 128);
  if (!eventId) errors.push('event_id is required (1–128 chars)');
  if (raw.schema_version !== HUB_SCHEMA_VERSION) {
    errors.push(`schema_version must be "${HUB_SCHEMA_VERSION}"`);
  }
  const eventType = raw.event_type;
  if (
    typeof eventType !== 'string' ||
    !HUB_EVENT_TYPES.includes(eventType as HubEventType)
  ) {
    errors.push(`event_type must be one of ${HUB_EVENT_TYPES.join(', ')}`);
  }
  if (!isUuid(raw.connection_id))
    errors.push('connection_id must be a UUID issued by CIEL PK');
  const occurred =
    typeof raw.occurred_at === 'string' ? new Date(raw.occurred_at) : null;
  if (!occurred || Number.isNaN(occurred.getTime())) {
    errors.push('occurred_at must be an ISO-8601 date-time');
  } else if (occurred.getTime() > Date.now() + 86_400_000) {
    errors.push('occurred_at may not be more than one day in the future');
  }
  const activity = isPlainObject(raw.activity) ? raw.activity : null;
  const externalId = activity ? str(activity.external_id, 128) : null;
  const activityType = activity ? str(activity.type, 64) : null;
  if (!externalId)
    errors.push('activity.external_id is required (1–128 chars)');
  if (!activityType) errors.push('activity.type is required (1–64 chars)');
  const title =
    activity && activity.title !== undefined ? str(activity.title, 200) : null;
  if (activity && activity.title !== undefined && title === null) {
    errors.push('activity.title must be 1–200 chars when present');
  }
  if (raw.payload !== undefined && !isPlainObject(raw.payload))
    errors.push('payload must be an object');
  let metrics: ExternalMetricValue[] | undefined;
  if (raw.metrics !== undefined) {
    if (!Array.isArray(raw.metrics) || raw.metrics.length > 50) {
      errors.push('metrics must be an array of at most 50 items');
    } else {
      metrics = [];
      raw.metrics.forEach((m, i) => {
        if (
          !isPlainObject(m) ||
          !str(m.code, 64) ||
          typeof m.value !== 'number'
        ) {
          errors.push(`metrics[${i}] needs code (string) and value (number)`);
          return;
        }
        metrics!.push({
          code: String(m.code).trim(),
          value: m.value,
          ...(typeof m.unit === 'string' ? { unit: m.unit.trim() } : {}),
          ...(typeof m.classification === 'string'
            ? { classification: m.classification.trim() }
            : {}),
          ...(typeof m.method === 'string' ? { method: m.method.trim() } : {}),
        });
      });
    }
  }
  let evidence: Array<{ upload_id: string }> | undefined;
  if (raw.evidence !== undefined) {
    if (!Array.isArray(raw.evidence) || raw.evidence.length > 20) {
      errors.push('evidence must be an array of at most 20 items');
    } else {
      evidence = [];
      raw.evidence.forEach((e, i) => {
        if (!isPlainObject(e) || !isUuid(e.upload_id)) {
          errors.push(
            `evidence[${i}].upload_id must be a UUID from an upload ticket`,
          );
          return;
        }
        evidence!.push({ upload_id: e.upload_id });
      });
    }
  }
  if (raw.attestation !== undefined && !isPlainObject(raw.attestation)) {
    errors.push('attestation must be an object');
  }
  const correlation = isPlainObject(raw.correlation) ? raw.correlation : {};
  if (eventType === 'activity.corrected' && !str(correlation.corrects, 128)) {
    errors.push(
      'activity.corrected requires correlation.corrects (the event_id being corrected)',
    );
  }
  if (errors.length) {
    return { ok: false, code: 'ENVELOPE_INVALID', errors, eventId };
  }
  const value: HubEnvelope = {
    schema_version: HUB_SCHEMA_VERSION,
    event_id: eventId!,
    event_type: eventType as HubEventType,
    connection_id: raw.connection_id as string,
    occurred_at: occurred!.toISOString(),
    activity: {
      external_id: externalId!,
      type: activityType!,
      ...(title ? { title } : {}),
    },
    ...(isPlainObject(raw.payload) ? { payload: raw.payload } : {}),
    ...(metrics ? { metrics } : {}),
    ...(evidence ? { evidence } : {}),
    ...(isPlainObject(raw.attestation)
      ? { attestation: raw.attestation as ExternalAttestation }
      : {}),
    correlation: {
      corrects: str(correlation.corrects, 128),
      voids: str(correlation.voids, 128),
    },
  };
  const bytes = Buffer.byteLength(JSON.stringify(value));
  if (bytes > HUB_HARD_LIMITS.max_event_bytes) {
    return {
      ok: false,
      code: 'EVENT_TOO_LARGE',
      errors: [`event exceeds ${HUB_HARD_LIMITS.max_event_bytes} bytes`],
      eventId,
    };
  }
  return { ok: true, value, bytes };
}

/** True when an attestation is sufficient to accept personal fields on an allowing connection. */
export function attestationSufficient(
  a: ExternalAttestation | undefined,
): boolean {
  if (!a) return false;
  const basis =
    typeof a.lawful_basis === 'string' && a.lawful_basis.trim().length > 0;
  const ref =
    typeof a.consent_ref === 'string' && a.consent_ref.trim().length > 0;
  return basis && ref;
}
