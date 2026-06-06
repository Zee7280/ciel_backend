import { buildCielPkAiEvaluationPayload, CIEL_PK_AI_EVALUATION_SCHEMA_VERSION } from './build-ciel-pk-ai-evaluation-payload.util';
import { StudentReport } from './entities/student-report.entity';

describe('buildCielPkAiEvaluationPayload', () => {
    it('builds v1.0 payload without legacy CII or CNIC', () => {
        const report = {
            id: 'report-123',
            studentId: 'student-123',
            project_id: 'project-123',
            opportunityId: 'opp-123',
            submission_date: new Date('2026-06-04T09:20:00.000Z'),
            reportSubmittedAt: new Date('2026-06-04T09:20:00.000Z'),
            status: 'submitted',
            faculty_status: 'pending',
            partner_status: 'pending',
            admin_status: 'pending',
            student: {
                id: 'student-123',
                name: 'Zara Ijaz',
                email: 'student@bnu.edu.pk',
            },
            opportunity: {
                id: 'opp-123',
                title: 'Abroo Teaching Initiative',
                location: { city: 'Lahore', country: 'Pakistan' },
                timeline: { start_date: '2026-05-01', end_date: '2026-05-30', expected_hours: 16 },
            },
            section1: {
                participation_type: 'team',
                team_lead: {
                    name: 'Zara Ijaz',
                    fullName: 'Zara Ijaz',
                    cnic: '12345-1234567-1',
                    email: 'student@bnu.edu.pk',
                    university: 'Beaconhouse National University',
                    degree: 'BS Economics and Finance',
                    year: '2nd Year',
                    role: 'Team Lead',
                    hours: '18',
                },
                team_members: [],
                attendance_logs: [
                    {
                        id: 'att-1',
                        date: '2026-05-15',
                        start_time: '09:00',
                        end_time: '13:00',
                        hours: 4,
                        activity_type: 'field_visit',
                        description: 'Teaching session',
                        location: 'Abroo High School',
                        evidence_url: 'https://example.com/evidence/attendance-001.jpg',
                    },
                ],
                metrics: { total_verified_hours: 18, verified_session_count: 1 },
            },
            section2: {
                discipline: 'Business and Economics',
                problem_category: 'Education Access Gap',
                primary_beneficiary: 'Students',
                problem_statement: 'Students had limited exposure to practical concepts.',
                baseline_evidence: ['Initial observation showed limited practical exposure.'],
                discipline_contribution: 'Economics and business concepts were used.',
            },
            section3: {
                primary_sdg: { goal_number: 4, target_id: '4.4', indicator_id: '4.4.1' },
                contribution_intent_statement: 'The project contributed to SDG 4.',
                validation_status: 'validated',
                secondary_sdgs: [],
            },
            section4: {
                activity_blocks: [
                    {
                        id: 'act-1',
                        title: 'Entrepreneurship Session',
                        sessions_count: '12',
                        description: 'Introduced students to entrepreneurship concepts.',
                        beneficiaries_reached: '60',
                    },
                ],
                project_summary: { distinct_total_beneficiaries: '60', overall_geographic_reach: 'single_site' },
            },
            section5: {
                observed_change: 'Students demonstrated improved awareness.',
                measurable_outcomes: [
                    {
                        id: 'out-1',
                        metric: 'Quiz score improvement',
                        baseline: '20',
                        endline: '65',
                        unit: 'percentage',
                    },
                ],
                challenges: 'Short duration',
            },
            section6: {
                use_resources: 'yes',
                resources: [{ type: 'financial', amount: '13000', unit: 'PKR', purpose: 'Transport and materials', sources: ['student_personal_contribution'] }],
            },
            section7: {
                has_partners: 'yes',
                partners: [{ name: 'Abroo High School', type: 'non_profit_school', role: ['venue'], contribution: ['beneficiary_access'] }],
                formalization_status: ['attendance_verified'],
            },
            section8: {
                has_evidence: 'yes',
                description: 'Photos and attendance sheets uploaded.',
                evidence_types: ['photos', 'attendance_sheets'],
                evidence_files: [{ url: 'https://example.com/files/attendance_sheet.jpg', name: 'attendance_sheet.jpg' }],
                partner_verification: true,
                partner_verification_type: 'attendance_verification',
                ethical_compliance: {
                    informed_consent: true,
                    no_harm: true,
                    privacy_respected: true,
                    authentic: true,
                },
            },
            section9: {
                personal_learning: 'Developed communication skills.',
                academic_application: 'Applied economics concepts.',
                academic_integration: 'Credit-bearing component',
                competency_scores: { communication: 4, teamwork: 4 },
            },
            section10: {
                continuation_status: 'partially',
                mechanisms: ['partner_led_continuation'],
                continuation_details: 'Materials can be reused.',
                scaling_potential: 'scalable_to_other_schools',
                policy_influence: 'none',
            },
            section11: {
                summary_text: 'Old audit',
                cii_index: { totalScore: 84 },
                ai_generated_impact_score: 84,
            },
        } as unknown as StudentReport;

        const payload = buildCielPkAiEvaluationPayload(report);
        const serialized = JSON.stringify(payload);

        expect(payload.schema_version).toBe(CIEL_PK_AI_EVALUATION_SCHEMA_VERSION);
        expect(payload.evaluation_mode).toBe('master_ai_prompt');
        expect(serialized).not.toContain('cii_index');
        expect(serialized).not.toContain('ai_generated_impact_score');
        expect(serialized).not.toContain('12345-1234567-1');
        expect(payload.uploaded_evidence_files.length).toBeGreaterThanOrEqual(2);
        expect((payload.section8_evidence_verification as { evidence_file_ids?: string[] }).evidence_file_ids?.length).toBeGreaterThan(0);
        const firstLog = (payload.section1_participation_identity_attendance as { attendance_logs?: Array<{ evidence_file_ids?: string[] }> })
            .attendance_logs?.[0];
        expect(firstLog?.evidence_file_ids?.length).toBeGreaterThan(0);
        expect(payload.system_validation.legacy_score_removed).toBe(true);
        expect(payload.system_validation.sensitive_fields_removed).toBe(true);
    });
});
