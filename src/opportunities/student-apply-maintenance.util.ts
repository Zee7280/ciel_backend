/** Pause Join / Apply only. Reports, attendance, and review keep running. */
export const STUDENT_APPLY_MAINTENANCE_ENABLED_KEY =
  'STUDENT_APPLY_MAINTENANCE_ENABLED';
export const STUDENT_APPLY_MAINTENANCE_MESSAGE_KEY =
  'STUDENT_APPLY_MAINTENANCE_MESSAGE';
/** ISO timestamp: listings created on or before this cannot accept new applies. */
export const STUDENT_APPLY_CLOSED_BEFORE_KEY = 'STUDENT_APPLY_CLOSED_BEFORE';

export const DEFAULT_STUDENT_APPLY_MAINTENANCE_MESSAGE =
  'Student applications are temporarily paused for maintenance. Existing reports, attendance, and reviews continue as usual.';

export const CATALOG_APPLY_CLOSED_MESSAGE =
  'Applications for this opportunity have closed. Enrolled students can continue reports and attendance.';

export type ApplyBlockedReason = 'maintenance' | 'catalog_closed';

export type ApplyMaintenanceState = {
  maintenanceEnabled: boolean;
  maintenanceMessage: string;
  closedBefore: Date | null;
};

export type ApplyGateFields = {
  applications_open: boolean;
  apply_blocked_reason: ApplyBlockedReason | null;
  apply_blocked_message: string | null;
  apply_maintenance: { enabled: boolean; message: string };
};

export function parseBooleanSettingValue(
  value: string | null | undefined,
  defaultEnabled = false,
): boolean {
  if (value == null || String(value).trim() === '') return defaultEnabled;
  const normalized = String(value).trim().toLowerCase();
  if (['false', '0', 'no', 'off', 'disabled'].includes(normalized)) return false;
  if (['true', '1', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  return defaultEnabled;
}

export function parseApplyMaintenanceMessage(
  value: string | null | undefined,
): string {
  const text = String(value || '').trim();
  return text || DEFAULT_STUDENT_APPLY_MAINTENANCE_MESSAGE;
}

export function parseClosedBeforeSettingValue(
  value: string | null | undefined,
): Date | null {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

export function isStudentApplyMaintenanceSettingKey(key: string): boolean {
  return (
    key === STUDENT_APPLY_MAINTENANCE_ENABLED_KEY ||
    key === STUDENT_APPLY_MAINTENANCE_MESSAGE_KEY ||
    key === STUDENT_APPLY_CLOSED_BEFORE_KEY
  );
}

export function decorateApplyGate(
  opportunity: { createdAt?: Date | string | null },
  state: ApplyMaintenanceState,
): ApplyGateFields {
  const maintenance = {
    enabled: state.maintenanceEnabled,
    message: state.maintenanceMessage,
  };
  if (state.maintenanceEnabled) {
    return {
      applications_open: false,
      apply_blocked_reason: 'maintenance',
      apply_blocked_message: state.maintenanceMessage,
      apply_maintenance: maintenance,
    };
  }
  const createdAt = opportunity.createdAt
    ? new Date(opportunity.createdAt)
    : null;
  if (
    state.closedBefore &&
    createdAt &&
    !Number.isNaN(createdAt.getTime()) &&
    createdAt.getTime() <= state.closedBefore.getTime()
  ) {
    return {
      applications_open: false,
      apply_blocked_reason: 'catalog_closed',
      apply_blocked_message: CATALOG_APPLY_CLOSED_MESSAGE,
      apply_maintenance: maintenance,
    };
  }
  return {
    applications_open: true,
    apply_blocked_reason: null,
    apply_blocked_message: null,
    apply_maintenance: maintenance,
  };
}
