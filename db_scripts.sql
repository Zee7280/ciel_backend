-- Database Schema Updates for NGO/Partner Dashboard

-- 1. Organizations Table Updates
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS address VARCHAR(255);

-- 2. Opportunities Table Updates (or Creation)
CREATE TABLE IF NOT EXISTS opportunities (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title VARCHAR(255) NOT NULL,
    types TEXT[], -- Array of strings
    mode VARCHAR(50),
    location JSONB,
    timeline JSONB,
    sdg_info JSONB,
    objectives JSONB,
    activity_details JSONB,
    supervision JSONB,
    verification_method TEXT[],
    visibility VARCHAR(50) DEFAULT 'public',
    status VARCHAR(50) DEFAULT 'pending_approval',
    organizationId UUID, -- Foreign Key
    sdg VARCHAR(255),
    createdAt TIMESTAMP DEFAULT NOW(),
    updatedAt TIMESTAMP DEFAULT NOW(),
    CONSTRAINT fk_organization
      FOREIGN KEY(organizationId) 
      REFERENCES organizations(id)
      ON DELETE SET NULL
);

-- 3. Timesheets Table Updates
ALTER TABLE timesheets ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE timesheets ADD COLUMN IF NOT EXISTS evidenceUrl VARCHAR(255);
ALTER TABLE timesheets ADD COLUMN IF NOT EXISTS evidenceType VARCHAR(50);
ALTER TABLE timesheets ADD COLUMN IF NOT EXISTS rejectionReason TEXT;
ALTER TABLE timesheets ADD COLUMN IF NOT EXISTS studentId UUID;
ALTER TABLE timesheets ADD COLUMN IF NOT EXISTS opportunityId UUID;
ALTER TABLE timesheets ADD COLUMN IF NOT EXISTS organizationId UUID;

-- Add Foreign Keys for Timesheets
ALTER TABLE timesheets ADD CONSTRAINT fk_timesheet_student FOREIGN KEY (studentId) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE timesheets ADD CONSTRAINT fk_timesheet_opportunity FOREIGN KEY (opportunityId) REFERENCES opportunities(id) ON DELETE SET NULL;
ALTER TABLE timesheets ADD CONSTRAINT fk_timesheet_organization FOREIGN KEY (organizationId) REFERENCES organizations(id) ON DELETE SET NULL;

-- 4. Reports Table Updates
ALTER TABLE reports ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS evidenceUrl VARCHAR(255);
ALTER TABLE reports ADD COLUMN IF NOT EXISTS evidenceType VARCHAR(50);
ALTER TABLE reports ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'pending';
ALTER TABLE reports ADD COLUMN IF NOT EXISTS rejectionReason TEXT;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS studentId UUID;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS opportunityId UUID;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS organizationId UUID;

-- Add Foreign Keys for Reports
ALTER TABLE reports ADD CONSTRAINT fk_report_student FOREIGN KEY (studentId) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE reports ADD CONSTRAINT fk_report_opportunity FOREIGN KEY (opportunityId) REFERENCES opportunities(id) ON DELETE SET NULL;
ALTER TABLE reports ADD CONSTRAINT fk_report_organization FOREIGN KEY (organizationId) REFERENCES organizations(id) ON DELETE SET NULL;
