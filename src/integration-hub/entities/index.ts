import { ExternalPlatform } from './external-platform.entity';
import { ExternalConnection } from './external-connection.entity';
import { ExternalCredential } from './external-credential.entity';
import { ExternalEvent } from './external-event.entity';
import { ExternalRecord } from './external-record.entity';
import { ExternalEvidence } from './external-evidence.entity';
import { ExternalMetricCatalog } from './external-metric-catalog.entity';
import { ExternalAudit } from './external-audit.entity';
import { ExternalSummary } from './external-summary.entity';

export * from './external-platform.entity';
export * from './external-connection.entity';
export * from './external-credential.entity';
export * from './external-event.entity';
export * from './external-record.entity';
export * from './external-evidence.entity';
export * from './external-metric-catalog.entity';
export * from './external-audit.entity';
export * from './external-summary.entity';

/** Every entity on the hub connection. Explicit list: autoLoadEntities is NOT used for the hub. */
export const HUB_ENTITIES = [
  ExternalPlatform,
  ExternalConnection,
  ExternalCredential,
  ExternalEvent,
  ExternalRecord,
  ExternalEvidence,
  ExternalMetricCatalog,
  ExternalAudit,
  ExternalSummary,
];
