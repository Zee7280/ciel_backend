import * as crypto from 'crypto';
import {
  buildCielPkAiEvaluationPayload,
  buildCielPkAiEvaluationPayloadV45,
  computeCiiV45InputFingerprint,
  CIEL_PK_AI_EVALUATION_SCHEMA_VERSION,
  CIEL_PK_AI_EVALUATION_SCHEMA_VERSION_V45,
  EvidenceByteSource,
} from './build-ciel-pk-ai-evaluation-payload.util';
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
        timeline: {
          start_date: '2026-05-01',
          end_date: '2026-05-30',
          expected_hours: 16,
        },
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
        problem_statement:
          'Students had limited exposure to practical concepts.',
        baseline_evidence: [
          'Initial observation showed limited practical exposure.',
        ],
        discipline_contribution: 'Economics and business concepts were used.',
      },
      section3: {
        primary_sdg: {
          goal_number: 4,
          target_id: '4.a',
          indicator_id: '4.a.1',
          sub_indicator: 'Sessions / activities completed',
        },
        contribution_intent_statement: 'The project contributed to SDG 4.',
        validation_status: 'validated',
        secondary_sdgs: [],
      },
      section4: {
        activity_blocks: [
          {
            id: 'act-1',
            title: 'Entrepreneurship Session',
            status: 'Completed',
            sub_category: 'Workshop',
            activity_period: '12–18 Oct 2026',
            partner_host: 'Abroo High School',
            sessions_count: '12',
            description: 'Introduced students to entrepreneurship concepts.',
            beneficiaries_reached: '60',
            unique_beneficiaries: '40',
            overlap_note: 'same class attended twice',
            reach_counting_method: 'Verified registration / list',
            site_note: 'Classroom 4',
            sdgs: [4],
            ladder_ui: { open: 0 },
            serves_beneficiaries: true,
          },
        ],
        project_summary: {
          distinct_total_beneficiaries: '60',
          overall_geographic_reach: 'single_site',
        },
      },
      section5: {
        observed_change: 'Students demonstrated improved awareness.',
        measurable_outcomes: [
          {
            id: 'out-1',
            metric: 'Percentage Improvement (%)',
            metric_other: 'Quiz score improvement',
            baseline: '20',
            endline: '65',
            unit: 'percentage',
            activity_id: 'act-1',
            sure: 1,
            confidence_level: ['Directly Measured'],
          },
        ],
        challenges: 'Short duration',
      },
      section6: {
        use_resources: 'yes',
        resources: [
          {
            type: 'financial',
            amount: '13000',
            unit: 'PKR',
            purpose: 'Transport and materials',
            sources: ['student_personal_contribution'],
          },
        ],
      },
      section7: {
        has_partners: 'yes',
        partners: [
          {
            name: 'Abroo High School',
            type: 'non_profit_school',
            role: ['venue'],
            contribution: ['beneficiary_access'],
          },
        ],
        formalization_status: ['attendance_verified'],
      },
      section8: {
        has_evidence: 'yes',
        description: 'Photos and attendance sheets uploaded.',
        evidence_types: ['photos', 'attendance_sheets'],
        evidence_files: [
          {
            url: 'https://example.com/files/attendance_sheet.jpg',
            name: 'attendance_sheet.jpg',
          },
        ],
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
    expect(
      (
        payload.section8_evidence_verification as {
          evidence_file_ids?: string[];
          media_visibility?: string;
          public_share_permission?: boolean;
        }
      ).evidence_file_ids?.length,
    ).toBeGreaterThan(0);
    expect(
      (payload.section8_evidence_verification as { media_visibility?: string })
        .media_visibility,
    ).toBe('restricted');
    const firstLog = (
      payload.section1_participation_identity_attendance as {
        attendance_logs?: Array<{ evidence_file_ids?: string[] }>;
      }
    ).attendance_logs?.[0];
    expect(firstLog?.evidence_file_ids?.length).toBeGreaterThan(0);
    expect(payload.system_validation.legacy_score_removed).toBe(true);
    expect(payload.system_validation.sensitive_fields_removed).toBe(true);
    // Must match the live v4.5 evaluator (cii-v4-5.constants.ts) — a mismatch here would send the
    // model a contradictory rubric.
    expect(payload.system_validation.scoring_rubric).toMatchObject({
      cii_v45_framework_version: '4.5',
      max_total: 100,
    });
    const attendanceSummary = (
      payload.section1_participation_identity_attendance as {
        attendance_summary?: {
          max_daily_attendance_hours_per_student?: number;
        };
      }
    ).attendance_summary;
    expect(attendanceSummary?.max_daily_attendance_hours_per_student).toBe(9);
    const section3 = payload.section3_sdg_strategy_intent as {
      primary_sdg?: { target_code?: string; indicator_code?: string; sub_indicator?: string };
    };
    expect(section3.primary_sdg).toMatchObject({
      target_code: '4.a',
      indicator_code: '4.a.1',
      sub_indicator: 'Sessions / activities completed',
    });
    const section4 = payload.section4_activities_outputs_scale as {
      activity_blocks?: Array<{
        status?: string;
        activity_date?: string;
        sub_category?: string;
        partner_host?: string;
        site_note?: string;
        sdgs?: number[];
        serves_beneficiaries?: boolean;
        beneficiaries?: { unique_count?: number; overlap_note?: string; counting_method?: string };
      }>;
    };
    expect(section4.activity_blocks?.[0]).toMatchObject({
      status: 'Completed',
      activity_date: '12–18 Oct 2026',
      sub_category: 'Workshop',
      partner_host: 'Abroo High School',
      site_note: 'Classroom 4',
      sdgs: [4],
      serves_beneficiaries: true,
      beneficiaries: {
        unique_count: 40,
        overlap_note: 'same class attended twice',
        counting_method: 'Verified registration / list',
      },
    });
    const section5 = payload.section5_outcomes_systemic_change as {
      measurable_outcomes?: Array<{
        activity_id?: string | null;
        sure?: number | null;
        confidence_level?: string[];
        outcome_statement?: string;
      }>;
    };
    expect(section5.measurable_outcomes?.[0]).toMatchObject({
      activity_id: 'act-1',
      sure: 1,
      confidence_level: ['Directly Measured'],
      outcome_statement: 'Quiz score improvement',
    });
  });

  it('derives sessions/geography from ladder activities, drops ladder_ui, sends challenge_tags', () => {
    const payload = buildCielPkAiEvaluationPayload({
      id: 'r1',
      studentId: 's1',
      section4: {
        activity_blocks: [
          {
            id: 'a1',
            title: 'Reading circles',
            geographic_reach: 'Single Site',
            ladder_ui: { open: 3 },
            outputs: [
              { type: 'Sessions Conducted', quantity: '3', unit: 'Sessions' },
              { type: 'Kits Distributed', quantity: '10', unit: 'Kits' },
            ],
          },
        ],
      },
      section5: { challenge_tags: ['limited_budget'], measurable_outcomes: [] },
    } as unknown as StudentReport);
    const s4 = payload.section4_activities_outputs_scale as {
      project_summary: { total_sessions: number; geographic_reach: string };
      activity_blocks: Array<Record<string, unknown>>;
    };
    expect(s4.project_summary.total_sessions).toBe(3);
    expect(s4.project_summary.geographic_reach).toBe('Single Site');
    expect(s4.activity_blocks[0]).not.toHaveProperty('ladder_ui');
    expect(
      (payload.section5_outcomes_systemic_change as { challenge_tags: string[] }).challenge_tags,
    ).toEqual(['limited_budget']);
  });

  it('treats attendance-log hours as complete even when roster team_lead.hours is empty', () => {
    const payload = buildCielPkAiEvaluationPayload({
      id: 'r-hours',
      studentId: 's1',
      opportunity: { timeline: { expected_hours: 16 } },
      section1: {
        participation_type: 'individual',
        team_lead: { name: 'Zara Ijaz', email: 'student@bnu.edu.pk', hours: 0 },
        team_members: [],
        attendance_logs: [
          { student_name: 'Zara Ijaz', hours: 8, approval_status: 'pending' },
          { student_name: 'Zara Ijaz', hours: 8, approval_status: 'approved' },
          { student_name: 'Zara Ijaz', hours: 4, approval_status: 'rejected' },
        ],
        metrics: { total_verified_hours: 0 },
      },
      section8: {
        evidence_files: [{ url: 'https://example.com/a.jpg', name: 'a.jpg' }],
      },
    } as unknown as StudentReport);
    const summary = (
      payload.section1_participation_identity_attendance as {
        attendance_summary?: {
          required_hours_met?: boolean;
          total_verified_team_hours?: number;
          students_below_required_hours?: string[];
        };
      }
    ).attendance_summary;
    expect(summary?.required_hours_met).toBe(true);
    expect(summary?.students_below_required_hours).toEqual([]);
    expect(summary?.total_verified_team_hours).toBeGreaterThanOrEqual(16);
  });

  it('counts live sessionHours on attendance logs the same way submit does', () => {
    const payload = buildCielPkAiEvaluationPayload({
      id: 'r-session-hours',
      studentId: 's1',
      opportunity: { timeline: { expected_hours: 16 } },
      section1: {
        participation_type: 'individual',
        team_lead: { name: 'Saber Ara', hours: 0 },
        team_members: [],
        attendance_logs: [
          { student_name: 'Saber Ara', sessionHours: 7, approval_status: 'pending' },
          { student_name: 'Saber Ara', sessionHours: 9, approvalStatus: 'pending' },
        ],
        metrics: { total_verified_hours: 0 },
      },
      section8: {
        evidence_files: [{ url: 'https://example.com/a.jpg', name: 'a.jpg' }],
      },
    } as unknown as StudentReport);
    const summary = (
      payload.section1_participation_identity_attendance as {
        attendance_summary?: { required_hours_met?: boolean };
      }
    ).attendance_summary;
    expect(summary?.required_hours_met).toBe(true);
  });
});

function minimalV45Report(): StudentReport {
  return {
    id: 'report-45',
    studentId: 'student-45',
    project_id: 'project-45',
    opportunityId: 'opp-45',
    submission_date: new Date('2026-06-04T09:20:00.000Z'),
    reportSubmittedAt: new Date('2026-06-04T09:20:00.000Z'),
    status: 'submitted',
    faculty_status: 'pending',
    partner_status: 'pending',
    admin_status: 'pending',
    student: { id: 'student-45', name: 'Zara Ijaz', email: 'student@bnu.edu.pk' },
    opportunity: {
      id: 'opp-45',
      title: 'Abroo Teaching Initiative',
      location: { city: 'Lahore', country: 'Pakistan' },
      timeline: { start_date: '2026-05-01', end_date: '2026-05-30', expected_hours: 16 },
    },
    section1: {
      participation_type: 'individual',
      team_lead: { name: 'Zara Ijaz', fullName: 'Zara Ijaz', email: 'student@bnu.edu.pk', hours: '18' },
      team_members: [],
      attendance_logs: [],
      metrics: { total_verified_hours: 18, verified_session_count: 1 },
    },
    section2: { discipline: 'Economics', problem_statement: 'Limited exposure.' },
    section3: { primary_sdg: { goal_number: 4 }, secondary_sdgs: [] },
    section4: { activity_blocks: [], project_summary: {} },
    section5: { observed_change: 'Improved awareness.', measurable_outcomes: [] },
    section6: { use_resources: 'no' },
    section7: { has_partners: 'no' },
    section8: {
      has_evidence: 'yes',
      evidence_files: [{ url: 'https://example.com/files/evidence-1.jpg', name: 'evidence-1.jpg' }],
    },
    section9: { personal_learning: 'Grew communication skills.' },
    section10: { continuation_status: 'partially' },
  } as unknown as StudentReport;
}

function fakeS3(buffer: Buffer | null): EvidenceByteSource {
  return {
    getObjectBufferByPublicUrl: jest.fn(async () => (buffer ? { buffer } : null)),
  };
}

describe('buildCielPkAiEvaluationPayloadV45', () => {
  it('builds the v4.5 payload with a real sha256 hash per evidence file and the v4.5 scoring rubric', async () => {
    const bytes = Buffer.from('fake evidence bytes');
    const payload = await buildCielPkAiEvaluationPayloadV45(minimalV45Report(), fakeS3(bytes));

    expect(payload.schema_version).toBe(CIEL_PK_AI_EVALUATION_SCHEMA_VERSION_V45);
    expect(payload.report_id).toBe('report-45');
    expect(payload.uploaded_evidence_files).toHaveLength(1);
    expect(payload.uploaded_evidence_files[0].file_integrity.sha256).toBe(
      crypto.createHash('sha256').update(bytes).digest('hex'),
    );
    expect(payload.uploaded_evidence_files[0].file_integrity.size_bytes).toBe(bytes.byteLength);
    expect(
      (payload.system_validation.scoring_rubric as { cii_v45_framework_version: string }).cii_v45_framework_version,
    ).toBe('4.5');
    expect(typeof payload.input_fingerprint).toBe('string');
    expect(payload.input_fingerprint.length).toBeGreaterThan(0);
  });

  it('degrades gracefully (null hash) when an evidence file fails to fetch, without throwing', async () => {
    const payload = await buildCielPkAiEvaluationPayloadV45(minimalV45Report(), fakeS3(null));
    expect(payload.uploaded_evidence_files[0].file_integrity.sha256).toBeNull();
    expect(typeof payload.input_fingerprint).toBe('string');
  });
});

describe('computeCiiV45InputFingerprint', () => {
  it('is deterministic for identical input and changes when a section changes', () => {
    const report = minimalV45Report();
    const files = [{ file_id: 'EV-001', file_integrity: { sha256: 'abc' } }];

    const fp1 = computeCiiV45InputFingerprint(report, files);
    const fp2 = computeCiiV45InputFingerprint({ ...report } as StudentReport, files);
    expect(fp1).toBe(fp2);

    const changed = computeCiiV45InputFingerprint(
      { ...report, section9: { personal_learning: 'A different reflection entirely.' } } as StudentReport,
      files,
    );
    expect(changed).not.toBe(fp1);
  });

  it('changes when an evidence file hash changes', () => {
    const report = minimalV45Report();
    const fp1 = computeCiiV45InputFingerprint(report, [
      { file_id: 'EV-001', file_integrity: { sha256: 'abc' } },
    ]);
    const fp2 = computeCiiV45InputFingerprint(report, [
      { file_id: 'EV-001', file_integrity: { sha256: 'different' } },
    ]);
    expect(fp1).not.toBe(fp2);
  });

  it('is stable regardless of evidence-file array order', () => {
    const report = minimalV45Report();
    const fp1 = computeCiiV45InputFingerprint(report, [
      { file_id: 'EV-001', file_integrity: { sha256: 'a' } },
      { file_id: 'EV-002', file_integrity: { sha256: 'b' } },
    ]);
    const fp2 = computeCiiV45InputFingerprint(report, [
      { file_id: 'EV-002', file_integrity: { sha256: 'b' } },
      { file_id: 'EV-001', file_integrity: { sha256: 'a' } },
    ]);
    expect(fp1).toBe(fp2);
  });
});
