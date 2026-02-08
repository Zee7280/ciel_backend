-- Student Reports Table Migration
-- This script creates the student_reports table for storing comprehensive student project reports

CREATE TABLE IF NOT EXISTS student_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "studentId" UUID NOT NULL,
    "opportunityId" UUID,
    project_id VARCHAR(255),
    submission_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(50) NOT NULL DEFAULT 'draft',
    
    -- Section data stored as JSONB for flexibility
    section1 JSONB,
    section2 JSONB,
    section3 JSONB,
    section4 JSONB,
    section5 JSONB,
    section6 JSONB,
    section7 JSONB,
    section8 JSONB,
    section10 JSONB,
    section12 JSONB,
    
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    
    -- Foreign key constraints
    CONSTRAINT fk_student_reports_student FOREIGN KEY ("studentId") 
        REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_student_reports_opportunity FOREIGN KEY ("opportunityId") 
        REFERENCES opportunities(id) ON DELETE SET NULL
);

-- Create indexes for better query performance
CREATE INDEX idx_student_reports_student ON student_reports("studentId");
CREATE INDEX idx_student_reports_opportunity ON student_reports("opportunityId");
CREATE INDEX idx_student_reports_status ON student_reports(status);
CREATE INDEX idx_student_reports_submission_date ON student_reports(submission_date);

-- Create GIN indexes for JSONB columns to enable efficient querying
CREATE INDEX idx_student_reports_section2 ON student_reports USING GIN (section2);
CREATE INDEX idx_student_reports_section3 ON student_reports USING GIN (section3);
CREATE INDEX idx_student_reports_section5 ON student_reports USING GIN (section5);

COMMENT ON TABLE student_reports IS 'Stores comprehensive student project impact reports with 12 sections of data';
COMMENT ON COLUMN student_reports.status IS 'Report status: draft, submitted, verified, rejected';
COMMENT ON COLUMN student_reports.section1 IS 'Context: problem statement';
COMMENT ON COLUMN student_reports.section2 IS 'Team: participation type, team lead, members, consent';
COMMENT ON COLUMN student_reports.section3 IS 'SDG Mapping: primary/secondary SDGs with evidence';
COMMENT ON COLUMN student_reports.section4 IS 'Activities: description, financial resources, evidence';
COMMENT ON COLUMN student_reports.section5 IS 'Outcomes: observed changes and metrics';
COMMENT ON COLUMN student_reports.section6 IS 'Resources: used resources and evidence';
COMMENT ON COLUMN student_reports.section7 IS 'Partnerships: partner details and formalization';
COMMENT ON COLUMN student_reports.section8 IS 'Evidence: files, consents, verification';
COMMENT ON COLUMN student_reports.section10 IS 'Reflection: learning and sustainability';
COMMENT ON COLUMN student_reports.section12 IS 'Declaration: student and partner declarations';
