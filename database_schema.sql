-- Database Schema Script for CIEL API

-- 1. Organizations Table
CREATE TABLE "organizations" (
    "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
    "name" character varying NOT NULL,
    "orgType" character varying NOT NULL,
    "description" text,
    "city" character varying,
    "region" character varying,
    "address" character varying,
    "country" character varying NOT NULL DEFAULT 'Pakistan',
    "countryCode" character varying NOT NULL DEFAULT 'PK',
    "websiteUrl" character varying,
    "logoUrl" character varying,
    "contactName" character varying,
    "contactEmail" character varying,
    "contactPhone" character varying,
    "verificationStatus" character varying NOT NULL DEFAULT 'PENDING',
    "verificationScope" character varying NOT NULL DEFAULT 'LOCAL',
    "verifiedBy" character varying,
    "verifiedAt" TIMESTAMP,
    "verificationNotes" text,
    "worksWithMinors" boolean NOT NULL DEFAULT false,
    "safeguardingAcknowledged" boolean NOT NULL DEFAULT false,
    "dataPolicyAcknowledged" boolean NOT NULL DEFAULT false,
    "isBlocked" boolean NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
    CONSTRAINT "PK_organizations_id" PRIMARY KEY ("id")
);

-- 2. Users Table
CREATE TABLE "users" (
    "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
    "name" character varying NOT NULL,
    "email" character varying NOT NULL,
    "password" character varying NOT NULL,
    "institution" character varying,
    "department" character varying,
    "orgName" character varying,
    "orgType" character varying,
    "contactPerson" character varying,
    "role" character varying NOT NULL,
    "status" character varying NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
    "organizationId" uuid,
    CONSTRAINT "PK_users_id" PRIMARY KEY ("id"),
    CONSTRAINT "UQ_users_email" UNIQUE ("email"),
    CONSTRAINT "FK_users_organizationId" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE
);

-- 3. Opportunities Table
CREATE TABLE "opportunities" (
    "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
    "title" character varying NOT NULL,
    "types" text[],
    "mode" character varying,
    "location" jsonb,
    "timeline" jsonb,
    "sdg_info" jsonb,
    "objectives" jsonb,
    "activity_details" jsonb,
    "supervision" jsonb,
    "verification_method" text[],
    "visibility" character varying NOT NULL DEFAULT 'public',
    "status" character varying NOT NULL DEFAULT 'pending_approval',
    "organizationId" uuid,
    "sdg" character varying NOT NULL,
    "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
    CONSTRAINT "PK_opportunities_id" PRIMARY KEY ("id"),
    CONSTRAINT "FK_opportunities_organizationId" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE
);

-- 4. Timesheets Table (User Applications)
CREATE TABLE "timesheets" (
    "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
    "hours" double precision NOT NULL,
    "description" character varying,
    "evidenceUrl" character varying,
    "evidenceType" character varying,
    "status" character varying NOT NULL DEFAULT 'pending',
    "rejectionReason" character varying,
    "studentId" uuid,
    "opportunityId" uuid,
    "organizationId" uuid,
    "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
    CONSTRAINT "PK_timesheets_id" PRIMARY KEY ("id"),
    CONSTRAINT "FK_timesheets_studentId" FOREIGN KEY ("studentId") REFERENCES "users"("id"),
    CONSTRAINT "FK_timesheets_opportunityId" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id"),
    CONSTRAINT "FK_timesheets_organizationId" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
);

-- 5. Reports Table
CREATE TABLE "reports" (
    "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
    "title" character varying NOT NULL,
    "description" text,
    "evidenceUrl" character varying,
    "evidenceType" character varying,
    "status" character varying NOT NULL DEFAULT 'pending',
    "rejectionReason" character varying,
    "studentId" uuid,
    "opportunityId" uuid,
    "organizationId" uuid,
    "subject" character varying,
    "type" character varying,
    "severity" character varying,
    "reporterId" uuid,
    "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
    CONSTRAINT "PK_reports_id" PRIMARY KEY ("id"),
    CONSTRAINT "FK_reports_studentId" FOREIGN KEY ("studentId") REFERENCES "users"("id"),
    CONSTRAINT "FK_reports_opportunityId" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id"),
    CONSTRAINT "FK_reports_organizationId" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id"),
    CONSTRAINT "FK_reports_reporterId" FOREIGN KEY ("reporterId") REFERENCES "users"("id")
);

-- 6. Audit Logs Table
CREATE TABLE "audit_logs" (
    "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
    "action" character varying NOT NULL,
    "user" character varying,
    "target" character varying,
    "ip" character varying,
    "created_at" TIMESTAMP NOT NULL DEFAULT now(),
    CONSTRAINT "PK_audit_logs_id" PRIMARY KEY ("id")
);

-- 7. Settings Table
CREATE TABLE "settings" (
    "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
    "key" character varying NOT NULL,
    "value" text NOT NULL,
    "description" character varying,
    "type" character varying NOT NULL DEFAULT 'string',
    "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
    CONSTRAINT "PK_settings_id" PRIMARY KEY ("id"),
    CONSTRAINT "UQ_settings_key" UNIQUE ("key")
);
