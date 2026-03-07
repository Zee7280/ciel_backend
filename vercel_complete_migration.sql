-- ==============================================================================
-- Ciel PK - Complete Database Migration Script for Vercel
-- Warning: This script drops existing tables and recreates them.
-- ALL EXISTING DATA IN THESE TABLES WILL BE LOST.
-- Run this ENTIRE script in your Vercel Storage "Query" tab.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. Drop Existing Tables & Constraints (To start fresh)
-- ------------------------------------------------------------------------------
DROP TABLE IF EXISTS "attendance_logs" CASCADE;
DROP TABLE IF EXISTS "participants" CASCADE;
DROP TABLE IF EXISTS "timesheets" CASCADE;
DROP TABLE IF EXISTS "otps" CASCADE;

-- Also attempt to recreate or verify ENUMs
DO $$ BEGIN
    CREATE TYPE "attendance_logs_entrystatus_enum" AS ENUM('pending', 'verified', 'flagged');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE "participants_participationmode_enum" AS ENUM('individual', 'team');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE "participants_yearofstudy_enum" AS ENUM('1st Year', '2nd Year', '3rd Year', '4th Year', 'Graduate', 'Postgraduate');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE "participants_academicintegrationtype_enum" AS ENUM('Voluntary', 'Course-Linked', 'Credit-Bearing', 'Capstone / Thesis', 'Research-Integrated');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE "participants_status_enum" AS ENUM('draft', 'submitted', 'verified', 'finalized');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ------------------------------------------------------------------------------
-- 2. Create OTPs Table (For Team/Identity Verification)
-- ------------------------------------------------------------------------------
CREATE TABLE "otps" (
    "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
    "email" character varying NOT NULL,
    "otp" character varying NOT NULL,
    "expiresAt" TIMESTAMP NOT NULL,
    "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
    CONSTRAINT "PK_otp_id" PRIMARY KEY ("id")
);

-- ------------------------------------------------------------------------------
-- 3. Create Participants Table
-- ------------------------------------------------------------------------------
CREATE TABLE "participants" (
    "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
    "projectId" uuid NOT NULL, 
    "userId" character varying NOT NULL,
    "participationMode" "participants_participationmode_enum" NOT NULL DEFAULT 'individual',
    "isTeamLead" boolean NOT NULL DEFAULT false,
    "fullName" character varying NOT NULL,
    "cnicHash" character varying NOT NULL,
    "cnic" character varying,
    "cnicLast4" character varying NOT NULL,
    "mobile" character varying NOT NULL,
    "mobileVerified" boolean NOT NULL DEFAULT false,
    "email" character varying NOT NULL,
    "emailVerified" boolean NOT NULL DEFAULT false,
    "universityId" character varying NOT NULL,
    "universityName" character varying NOT NULL,
    "academicProgram" character varying NOT NULL,
    "yearOfStudy" "participants_yearofstudy_enum" NOT NULL,
    "department" character varying NOT NULL,
    "academicIntegrationType" "participants_academicintegrationtype_enum" NOT NULL,
    "status" "participants_status_enum" NOT NULL DEFAULT 'draft',
    "eisScore" double precision,
    "hecStatus" character varying,
    "finalizedAt" TIMESTAMP,
    "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
    CONSTRAINT "PK_participants_id" PRIMARY KEY ("id")
);
-- Note: UNIQUE constraint on cnicHash was removed intentionally to allow multiple project regs.

-- ------------------------------------------------------------------------------
-- 4. Create Attendance Logs Table
-- ------------------------------------------------------------------------------
CREATE TABLE "attendance_logs" (
    "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
    "participantId" uuid NOT NULL, -- UUID format matched properly for FK
    "projectId" uuid NOT NULL,
    "dateOfEngagement" date NOT NULL,
    "startTime" time without time zone NOT NULL,
    "endTime" time without time zone NOT NULL,
    "sessionHours" numeric(4,2) NOT NULL,
    "organizationName" character varying NOT NULL,
    "activityType" character varying NOT NULL,
    "description" character varying(300) NOT NULL,
    "evidenceUploaded" boolean NOT NULL DEFAULT false,
    "evidenceUrl" character varying,
    "entryStatus" "attendance_logs_entrystatus_enum" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
    CONSTRAINT "PK_attendance_logs_id" PRIMARY KEY ("id")
);

-- ------------------------------------------------------------------------------
-- 5. Create Timesheets Table
-- ------------------------------------------------------------------------------
CREATE TABLE "timesheets" (
    id uuid NOT NULL DEFAULT uuid_generate_v4(),
    hours double precision NOT NULL,
    description character varying,
    "evidenceUrl" character varying,
    "evidenceType" character varying,
    status character varying NOT NULL DEFAULT 'pending',
    "rejectionReason" character varying,
    "studentId" uuid,
    "opportunityId" uuid,
    "organizationId" uuid,
    "createdAt" timestamp without time zone NOT NULL DEFAULT now(),
    "updatedAt" timestamp without time zone NOT NULL DEFAULT now(),
    CONSTRAINT "PK_1dc280b68c9353ecce41a34be71" PRIMARY KEY (id)
);

-- ------------------------------------------------------------------------------
-- 6. Add Foreign Key Constraints (ON DELETE CASCADE)
-- ------------------------------------------------------------------------------

-- Opportunity Participants (assumes table was created by TypeORM synchronization already)
DO $$ BEGIN
    ALTER TABLE "opportunity_participants" DROP CONSTRAINT IF EXISTS "FK_29e089dc6b15c7dfec438b9af27";
    ALTER TABLE "opportunity_participants" ADD CONSTRAINT "FK_29e089dc6b15c7dfec438b9af27" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE CASCADE;
EXCEPTION WHEN OTHERS THEN null; END $$;

-- Student Reports (assumes table was created by TypeORM synchronization already)
DO $$ BEGIN
    ALTER TABLE "student_reports" DROP CONSTRAINT IF EXISTS "FK_21695119dc83300aec4e6ef1bd8";
    ALTER TABLE "student_reports" ADD CONSTRAINT "FK_21695119dc83300aec4e6ef1bd8" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE CASCADE;
EXCEPTION WHEN OTHERS THEN null; END $$;

-- Reports (assumes table was created by TypeORM synchronization already)
DO $$ BEGIN
    ALTER TABLE "reports" DROP CONSTRAINT IF EXISTS "FK_bfddeb2a65feeb0208b0432252a";
    ALTER TABLE "reports" ADD CONSTRAINT "FK_bfddeb2a65feeb0208b0432252a" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE CASCADE;
EXCEPTION WHEN OTHERS THEN null; END $$;


-- Timesheets Constraints
ALTER TABLE "timesheets" ADD CONSTRAINT "FK_timesheet_opportunity" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE CASCADE;
ALTER TABLE "timesheets" ADD CONSTRAINT "FK_timesheet_organization" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE NO ACTION;
ALTER TABLE "timesheets" ADD CONSTRAINT "FK_timesheet_student" FOREIGN KEY ("studentId") REFERENCES "users"("id") ON DELETE CASCADE;

-- Attendance Logs Constraints
ALTER TABLE "attendance_logs" ADD CONSTRAINT "FK_att_opportunity" FOREIGN KEY ("projectId") REFERENCES "opportunities"("id") ON DELETE CASCADE;
ALTER TABLE "attendance_logs" ADD CONSTRAINT "FK_att_participant" FOREIGN KEY ("participantId") REFERENCES "participants"("id") ON DELETE CASCADE;

-- Participants Constraints
ALTER TABLE "participants" ADD CONSTRAINT "FK_part_project" FOREIGN KEY ("projectId") REFERENCES "opportunities"("id") ON DELETE CASCADE;

-- User -> Organization Cascade
DO $$ BEGIN
    ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "FK_f3d6aea8fcca58182b2e80ce979"; -- Common TypeORM name for users.organizationId
    ALTER TABLE "users" ADD CONSTRAINT "FK_user_organization" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE;
EXCEPTION WHEN OTHERS THEN null; END $$;

-- Opportunity -> Organization Cascade
DO $$ BEGIN
    ALTER TABLE "opportunities" DROP CONSTRAINT IF EXISTS "FK_organization_id_opp"; -- Custom or common name
    ALTER TABLE "opportunities" ADD CONSTRAINT "FK_opp_organization" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE;
EXCEPTION WHEN OTHERS THEN null; END $$;

-- ------------------------------------------------------------------------------
-- END OF SCRIPT
-- ------------------------------------------------------------------------------
