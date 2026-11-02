import { HUB_EVENT_TYPES } from '../intake/envelope.util';

/**
 * University Export API scopes. Granted on a platform (`approvedEventTypes`, which is really the
 * platform's capability list) and on each organization connection (`scopes`), exactly like the
 * inbound event types, so the existing admin / organization approval flow covers both directions.
 */
export const HUB_EXPORT_SCOPES = [
  'export:students',
  'export:opportunities',
  'export:community-service',
  'export:fyp',
  'export:ventures',
  'export:summary',
] as const;
export type HubExportScope = (typeof HUB_EXPORT_SCOPES)[number];

/** Everything a platform may be approved for: inbound event types + outbound export scopes. */
export const HUB_PLATFORM_CAPABILITIES = [
  ...HUB_EVENT_TYPES,
  ...HUB_EXPORT_SCOPES,
] as const;

export const HUB_EXPORT_SCHEMA_VERSION = '1.0';
export const HUB_EXPORT_DEFAULT_LIMIT = 200;
export const HUB_EXPORT_MAX_LIMIT = 500;

export function isHubExportScope(value: unknown): value is HubExportScope {
  return (
    typeof value === 'string' &&
    (HUB_EXPORT_SCOPES as readonly string[]).includes(value)
  );
}
