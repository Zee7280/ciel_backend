import { BadRequestException } from '@nestjs/common';
import {
  STUDENT_APPLY_CLOSED_BEFORE_KEY,
  STUDENT_APPLY_EXPIRED_MESSAGE_KEY,
  STUDENT_APPLY_MAINTENANCE_ENABLED_KEY,
  STUDENT_APPLY_MAINTENANCE_MESSAGE_KEY,
} from '../opportunities/student-apply-maintenance.util';
import { REPORT_PARTNER_APPROVAL_SETTING_KEY } from '../reports/report-partner-approval.util';
import {
  MEMBERSHIP_FEE_PARTNER_PKR_KEY,
  PARTNER_MEMBERSHIP_REQUIRED_KEY,
} from '../organization-membership/partner-membership.util';
import { PLATFORM_SETTING_KEYS } from '../settings/platform-settings.constants';

export type SettingKind =
  | 'boolean'
  | 'text'
  | 'integer'
  | 'email'
  | 'email_list'
  | 'iso_date_or_disabled';

export type SettingSpec = {
  key: string;
  kind: SettingKind;
  description: string;
  maxLength?: number;
  min?: number;
  max?: number;
  maxItems?: number;
};

/** Sentinel stored in STUDENT_APPLY_CLOSED_BEFORE when the apply cut-off is switched off. */
export const CLOSED_BEFORE_DISABLED_SENTINEL = 'disabled';

const FEE = { kind: 'integer', min: 1, max: 1_000_000 } as const;

/** ALLOWLIST of settings editable via POST /admin/settings. Anything else is rejected. */
export const SETTINGS_REGISTRY: readonly SettingSpec[] = [
  {
    key: STUDENT_APPLY_MAINTENANCE_ENABLED_KEY,
    kind: 'boolean',
    description: 'Pause student Join / Apply',
  },
  {
    key: STUDENT_APPLY_MAINTENANCE_MESSAGE_KEY,
    kind: 'text',
    maxLength: 500,
    description: 'Message shown while student apply is paused',
  },
  {
    key: STUDENT_APPLY_CLOSED_BEFORE_KEY,
    kind: 'iso_date_or_disabled',
    description: 'Listings created on or before this date cannot accept applies',
  },
  {
    key: STUDENT_APPLY_EXPIRED_MESSAGE_KEY,
    kind: 'text',
    maxLength: 500,
    description: 'Message shown on expired opportunities',
  },
  {
    key: REPORT_PARTNER_APPROVAL_SETTING_KEY,
    kind: 'boolean',
    description: 'Require partner approval on student reports',
  },
  {
    key: PARTNER_MEMBERSHIP_REQUIRED_KEY,
    kind: 'boolean',
    description: 'Require partner membership fee before activation',
  },
  {
    key: MEMBERSHIP_FEE_PARTNER_PKR_KEY,
    description: 'Partner membership fee (PKR)',
    ...FEE,
  },
  {
    key: PLATFORM_SETTING_KEYS.MEMBERSHIP_FEE_UNIVERSITY_PKR,
    description: 'University membership fee (PKR)',
    ...FEE,
  },
  {
    key: PLATFORM_SETTING_KEYS.MEMBERSHIP_FEE_CORPORATE_PKR,
    description: 'Corporate membership fee (PKR)',
    ...FEE,
  },
  {
    key: PLATFORM_SETTING_KEYS.REPORTING_FEE_PKR,
    description: 'Student reporting fee (PKR)',
    ...FEE,
  },
  {
    key: PLATFORM_SETTING_KEYS.MAINTENANCE_MODE,
    kind: 'boolean',
    description: 'Platform-wide maintenance mode (admins can still sign in)',
  },
  {
    key: PLATFORM_SETTING_KEYS.ALLOW_REGISTRATIONS,
    kind: 'boolean',
    description: 'Allow new account registrations',
  },
  {
    key: PLATFORM_SETTING_KEYS.SITE_NAME,
    kind: 'text',
    maxLength: 80,
    description: 'Public site name',
  },
  {
    key: PLATFORM_SETTING_KEYS.CONTACT_EMAIL,
    kind: 'email',
    description: 'Public contact email',
  },
  {
    key: PLATFORM_SETTING_KEYS.ADMIN_REVIEW_EMAILS,
    kind: 'email_list',
    maxItems: 10,
    description: 'Comma-separated admin review notification emails',
  },
  {
    key: PLATFORM_SETTING_KEYS.REVIEW_SLA_DAYS,
    kind: 'integer',
    min: 1,
    max: 60,
    description: 'Review SLA (days)',
  },
];

const BY_KEY = new Map(SETTINGS_REGISTRY.map((s) => [s.key, s]));

export const SETTINGS_REGISTRY_KEYS: string[] = SETTINGS_REGISTRY.map(
  (s) => s.key,
);

export function getSettingSpec(key: string): SettingSpec | undefined {
  return BY_KEY.get(key);
}

/** Setting.type column value for a registry kind. */
export function settingColumnType(kind: SettingKind): string {
  if (kind === 'boolean') return 'boolean';
  if (kind === 'integer') return 'number';
  return 'string';
}

const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

/**
 * Validates + normalises a settings write. Throws 400 for unknown keys, wrong types and
 * out-of-range values. Returns the canonical string to persist.
 */
export function validateSettingValue(
  key: string,
  raw: unknown,
  now: Date = new Date(),
): { spec: SettingSpec; value: string } {
  const spec = BY_KEY.get(key);
  if (!spec) {
    throw new BadRequestException(`Unknown or non-editable setting "${key}".`);
  }
  const text = typeof raw === 'string' ? raw.trim() : String(raw ?? '').trim();
  const fail = (msg: string): never => {
    throw new BadRequestException(`${key}: ${msg}`);
  };

  switch (spec.kind) {
    case 'boolean': {
      const v = text.toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(v)) return { spec, value: 'true' };
      if (['false', '0', 'no', 'off'].includes(v))
        return { spec, value: 'false' };
      return fail('must be a boolean (true or false).');
    }
    case 'text': {
      if (text.length > (spec.maxLength ?? 500)) {
        fail(`must be at most ${spec.maxLength} characters.`);
      }
      return { spec, value: text };
    }
    case 'integer': {
      if (!/^\d+$/.test(text)) fail('must be a whole number.');
      const n = Number(text);
      if (
        !Number.isSafeInteger(n) ||
        n < (spec.min ?? 0) ||
        n > (spec.max ?? Number.MAX_SAFE_INTEGER)
      ) {
        fail(`must be between ${spec.min} and ${spec.max}.`);
      }
      return { spec, value: String(n) };
    }
    case 'email': {
      if (!EMAIL_RE.test(text) || text.length > 254) {
        fail('must be a valid email address.');
      }
      return { spec, value: text.toLowerCase() };
    }
    case 'email_list': {
      const parts = text
        .split(',')
        .map((p) => p.trim().toLowerCase())
        .filter(Boolean);
      if (parts.length === 0) fail('must contain at least one email address.');
      if (parts.length > (spec.maxItems ?? 10)) {
        fail(`may contain at most ${spec.maxItems} email addresses.`);
      }
      const bad = parts.find((p) => !EMAIL_RE.test(p));
      if (bad) fail(`"${bad}" is not a valid email address.`);
      return { spec, value: [...new Set(parts)].join(',') };
    }
    case 'iso_date_or_disabled': {
      if (text.toLowerCase() === CLOSED_BEFORE_DISABLED_SENTINEL) {
        return { spec, value: CLOSED_BEFORE_DISABLED_SENTINEL };
      }
      const d = new Date(text);
      if (!text || Number.isNaN(d.getTime())) {
        fail(`must be an ISO date or "${CLOSED_BEFORE_DISABLED_SENTINEL}".`);
      }
      if (d.getTime() > now.getTime()) fail('must not be in the future.');
      return { spec, value: d.toISOString() };
    }
  }
}
