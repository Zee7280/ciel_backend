import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Integration Hub schema, version 1. Everything lives in `external_hub`; no table references
 * `public`. Column names follow the entity property names (TypeORM default naming), so the entity
 * classes in src/integration-hub/entities are the source of truth for shapes.
 *
 * Grants to the runtime role are applied here (guarded: skipped when the role does not exist, e.g.
 * on a throwaway local database) so that every new table is usable without a manual step.
 */
export class InitExternalHub1761300000000 implements MigrationInterface {
  name = 'InitExternalHub1761300000000';

  public async up(q: QueryRunner): Promise<void> {
    // The schema itself is created by scripts/hub-bootstrap-roles.sql (needs CREATE on the
    // database, which the migrator role deliberately does not have). Fail early if it is missing.
    const schema = (await q.query(
      `SELECT 1 AS ok FROM information_schema.schemata WHERE schema_name = 'external_hub'`,
    )) as Array<{ ok: number }>;
    if (schema.length === 0) {
      throw new Error(
        'Schema external_hub does not exist. Run scripts/hub-bootstrap-roles.sql as the database owner first.',
      );
    }

    await q.query(`
      CREATE TABLE "external_hub"."external_platforms" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "slug" varchar(64) NOT NULL,
        "name" varchar(160) NOT NULL,
        "description" text,
        "status" varchar(16) NOT NULL DEFAULT 'sandbox',
        "integrationMode" varchar(8) NOT NULL DEFAULT 'push',
        "approvedEventTypes" text[] NOT NULL DEFAULT '{}',
        "settings" jsonb NOT NULL DEFAULT '{}',
        "technicalContact" jsonb,
        "agreementReference" varchar(160),
        "createdByUserId" uuid,
        "liveAt" timestamptz,
        "suspendedAt" timestamptz,
        "suspensionReason" text,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_external_platforms_slug" UNIQUE ("slug")
      )`);
    await q.query(
      `CREATE INDEX "IDX_external_platforms_status" ON "external_hub"."external_platforms" ("status")`,
    );

    await q.query(`
      CREATE TABLE "external_hub"."external_connections" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "platform_id" uuid NOT NULL,
        "organization_id" uuid NOT NULL,
        "organizationName" varchar(200) NOT NULL,
        "status" varchar(16) NOT NULL DEFAULT 'proposed',
        "purpose" text,
        "scopes" text[] NOT NULL DEFAULT '{}',
        "dpaReference" varchar(160),
        "personalFieldsAllowed" boolean NOT NULL DEFAULT false,
        "orgEvidenceOpenAllowed" boolean NOT NULL DEFAULT false,
        "retentionDays" integer,
        "referralDomain" varchar(255),
        "validFrom" timestamptz,
        "validUntil" timestamptz,
        "proposedByUserId" uuid,
        "orgApprovedByUserId" uuid,
        "orgApprovedAt" timestamptz,
        "authorizedByUserId" uuid,
        "authorizedAt" timestamptz,
        "suspendedAt" timestamptz,
        "statusReason" text,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "FK_external_connections_platform"
          FOREIGN KEY ("platform_id") REFERENCES "external_hub"."external_platforms" ("id") ON DELETE RESTRICT,
        CONSTRAINT "UQ_external_connections_platform_org" UNIQUE ("platform_id", "organization_id")
      )`);
    await q.query(
      `CREATE INDEX "IDX_external_connections_org" ON "external_hub"."external_connections" ("organization_id")`,
    );
    await q.query(
      `CREATE INDEX "IDX_external_connections_status" ON "external_hub"."external_connections" ("status")`,
    );

    await q.query(`
      CREATE TABLE "external_hub"."external_credentials" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "platform_id" uuid NOT NULL,
        "keyId" varchar(48) NOT NULL,
        "secretCiphertext" text NOT NULL,
        "secretLast4" varchar(4) NOT NULL,
        "status" varchar(16) NOT NULL DEFAULT 'active',
        "label" varchar(120),
        "expiresAt" timestamptz,
        "lastUsedAt" timestamptz,
        "createdByUserId" uuid,
        "revokedAt" timestamptz,
        "revokedByUserId" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "FK_external_credentials_platform"
          FOREIGN KEY ("platform_id") REFERENCES "external_hub"."external_platforms" ("id") ON DELETE RESTRICT,
        CONSTRAINT "UQ_external_credentials_keyId" UNIQUE ("keyId")
      )`);
    await q.query(
      `CREATE INDEX "IDX_external_credentials_platform" ON "external_hub"."external_credentials" ("platform_id")`,
    );

    await q.query(`
      CREATE TABLE "external_hub"."external_events" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "connection_id" uuid NOT NULL,
        "platform_id" uuid NOT NULL,
        "sourceEventId" varchar(128) NOT NULL,
        "eventType" varchar(64) NOT NULL,
        "schemaVersion" varchar(16) NOT NULL,
        "envelope" jsonb NOT NULL,
        "status" varchar(16) NOT NULL DEFAULT 'received',
        "attempts" integer NOT NULL DEFAULT 0,
        "nextAttemptAt" timestamptz,
        "lockedAt" timestamptz,
        "lockedBy" varchar(64),
        "errorCode" varchar(64),
        "errorMessage" text,
        "credentialKeyId" varchar(48),
        "sourceIp" varchar(64),
        "payloadBytes" integer,
        "receivedAt" timestamptz NOT NULL DEFAULT now(),
        "processedAt" timestamptz,
        CONSTRAINT "FK_external_events_connection"
          FOREIGN KEY ("connection_id") REFERENCES "external_hub"."external_connections" ("id") ON DELETE RESTRICT,
        CONSTRAINT "UQ_external_events_connection_source" UNIQUE ("connection_id", "sourceEventId")
      )`);
    await q.query(
      `CREATE INDEX "IDX_external_events_status_next" ON "external_hub"."external_events" ("status", "nextAttemptAt")`,
    );
    await q.query(
      `CREATE INDEX "IDX_external_events_connection_received" ON "external_hub"."external_events" ("connection_id", "receivedAt")`,
    );
    await q.query(
      `CREATE INDEX "IDX_external_events_platform" ON "external_hub"."external_events" ("platform_id")`,
    );
    await q.query(
      `CREATE INDEX "IDX_external_events_type" ON "external_hub"."external_events" ("eventType")`,
    );

    await q.query(`
      CREATE TABLE "external_hub"."external_records" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "connection_id" uuid NOT NULL,
        "platform_id" uuid NOT NULL,
        "externalActivityId" varchar(128) NOT NULL,
        "activityType" varchar(64) NOT NULL,
        "title" varchar(200),
        "occurredOn" date,
        "payload" jsonb NOT NULL DEFAULT '{}',
        "metrics" jsonb NOT NULL DEFAULT '[]',
        "attestation" jsonb,
        "version" integer NOT NULL DEFAULT 1,
        "status" varchar(16) NOT NULL DEFAULT 'current',
        "supersededById" uuid,
        "sourceEventId" uuid NOT NULL,
        "reviewState" varchar(32) NOT NULL DEFAULT 'unreviewed',
        "reviewNote" text,
        "reviewedByUserId" uuid,
        "reviewedAt" timestamptz,
        "voidedAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "FK_external_records_connection"
          FOREIGN KEY ("connection_id") REFERENCES "external_hub"."external_connections" ("id") ON DELETE RESTRICT,
        CONSTRAINT "UQ_external_records_connection_activity_version" UNIQUE ("connection_id", "externalActivityId", "version")
      )`);
    await q.query(
      `CREATE INDEX "IDX_external_records_conn_type_date" ON "external_hub"."external_records" ("connection_id", "activityType", "occurredOn")`,
    );
    await q.query(
      `CREATE INDEX "IDX_external_records_conn_status" ON "external_hub"."external_records" ("connection_id", "status")`,
    );
    await q.query(
      `CREATE INDEX "IDX_external_records_platform" ON "external_hub"."external_records" ("platform_id")`,
    );

    await q.query(`
      CREATE TABLE "external_hub"."external_evidence" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "connection_id" uuid NOT NULL,
        "platform_id" uuid NOT NULL,
        "record_id" uuid,
        "uploadId" uuid NOT NULL,
        "bucket" varchar(128) NOT NULL,
        "storageKey" varchar(512) NOT NULL,
        "originalName" varchar(255),
        "mimeType" varchar(128) NOT NULL,
        "sizeBytes" bigint,
        "sha256" varchar(64),
        "state" varchar(16) NOT NULL DEFAULT 'quarantined',
        "visibility" varchar(16) NOT NULL DEFAULT 'restricted',
        "ticketExpiresAt" timestamptz NOT NULL,
        "acceptedAt" timestamptz,
        "rejectionCode" varchar(64),
        "purgedAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_external_evidence_uploadId" UNIQUE ("uploadId")
      )`);
    await q.query(
      `CREATE INDEX "IDX_external_evidence_conn_state" ON "external_hub"."external_evidence" ("connection_id", "state")`,
    );
    await q.query(
      `CREATE INDEX "IDX_external_evidence_record" ON "external_hub"."external_evidence" ("record_id")`,
    );

    await q.query(`
      CREATE TABLE "external_hub"."external_metric_catalog" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "code" varchar(64) NOT NULL,
        "name" varchar(160) NOT NULL,
        "unit" varchar(32) NOT NULL,
        "dataType" varchar(16) NOT NULL DEFAULT 'number',
        "aggregation" varchar(16) NOT NULL DEFAULT 'sum',
        "defaultClassification" varchar(24) NOT NULL DEFAULT 'observed',
        "minValue" numeric,
        "maxValue" numeric,
        "sector" varchar(64),
        "sdgs" integer[] NOT NULL DEFAULT '{}',
        "methodologyNotes" text,
        "platformFieldMappings" jsonb NOT NULL DEFAULT '{}',
        "active" boolean NOT NULL DEFAULT true,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_external_metric_catalog_code" UNIQUE ("code")
      )`);

    await q.query(`
      CREATE TABLE "external_hub"."external_audit" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "actorType" varchar(16) NOT NULL,
        "actorId" varchar(64),
        "actorLabel" varchar(160),
        "action" varchar(64) NOT NULL,
        "targetType" varchar(32) NOT NULL,
        "targetId" varchar(64),
        "connectionId" uuid,
        "details" jsonb,
        "ip" varchar(64),
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(
      `CREATE INDEX "IDX_external_audit_target" ON "external_hub"."external_audit" ("targetType", "targetId")`,
    );
    await q.query(
      `CREATE INDEX "IDX_external_audit_created" ON "external_hub"."external_audit" ("createdAt")`,
    );
    await q.query(
      `CREATE INDEX "IDX_external_audit_action" ON "external_hub"."external_audit" ("action")`,
    );
    await q.query(
      `CREATE INDEX "IDX_external_audit_connection" ON "external_hub"."external_audit" ("connectionId")`,
    );

    await q.query(`
      CREATE TABLE "external_hub"."external_summaries" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "connection_id" uuid NOT NULL,
        "scopeKey" varchar(160) NOT NULL,
        "period" varchar(8) NOT NULL,
        "recordCount" integer NOT NULL DEFAULT 0,
        "metricTotals" jsonb NOT NULL DEFAULT '{}',
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_external_summaries_scope" UNIQUE ("connection_id", "scopeKey", "period")
      )`);

    // Runtime role privileges. DELETE only where retention needs it; never on external_audit.
    await q.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ciel_hub_app') THEN
          GRANT USAGE ON SCHEMA "external_hub" TO ciel_hub_app;
          GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA "external_hub" TO ciel_hub_app;
          GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "external_hub" TO ciel_hub_app;
          GRANT DELETE ON
            "external_hub"."external_events",
            "external_hub"."external_evidence",
            "external_hub"."external_records",
            "external_hub"."external_summaries"
          TO ciel_hub_app;
          REVOKE DELETE ON "external_hub"."external_audit" FROM ciel_hub_app;
        END IF;
      END
      $$;`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "external_hub"."external_summaries"`);
    await q.query(`DROP TABLE IF EXISTS "external_hub"."external_audit"`);
    await q.query(
      `DROP TABLE IF EXISTS "external_hub"."external_metric_catalog"`,
    );
    await q.query(`DROP TABLE IF EXISTS "external_hub"."external_evidence"`);
    await q.query(`DROP TABLE IF EXISTS "external_hub"."external_records"`);
    await q.query(`DROP TABLE IF EXISTS "external_hub"."external_events"`);
    await q.query(`DROP TABLE IF EXISTS "external_hub"."external_credentials"`);
    await q.query(`DROP TABLE IF EXISTS "external_hub"."external_connections"`);
    await q.query(`DROP TABLE IF EXISTS "external_hub"."external_platforms"`);
  }
}
