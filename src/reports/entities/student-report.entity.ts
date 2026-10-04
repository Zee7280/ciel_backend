import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  BeforeInsert,
  BeforeUpdate,
} from 'typeorm';
import { randomUUID } from 'crypto';
import { User } from '../../users/entities/user.entity';
import { Opportunity } from '../../opportunities/entities/opportunity.entity';

@Entity('student_reports')
export class StudentReport {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'studentId' })
  student: User;

  @Column()
  studentId: string;

  @ManyToOne(() => Opportunity, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'opportunityId' })
  opportunity: Opportunity;

  @Column({ nullable: true })
  opportunityId: string;

  @Column({ nullable: true })
  project_id: string;

  /** Opaque token for public QR verification (never use raw report/opportunity id in QR when set). */
  @Column({
    name: 'verification_public_slug',
    type: 'varchar',
    length: 36,
    nullable: true,
    unique: true,
  })
  verificationPublicSlug: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'facultyId' })
  faculty: User;

  @Column({ type: 'uuid', nullable: true })
  facultyId: string | null;

  @Column({ default: 'pending' })
  faculty_status: string; // 'pending', 'approved', 'rejected'

  @Column({ type: 'text', nullable: true })
  faculty_remarks: string;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  submission_date: Date;

  /** Last time the student submitted the report for partner/admin review (aligned with submission_date on submit). */
  @Column({ name: 'report_submitted_at', type: 'timestamptz', nullable: true })
  reportSubmittedAt: Date | null;

  @Column({ name: 'partner_approved_at', type: 'timestamptz', nullable: true })
  partnerApprovedAt: Date | null;

  @Column({ name: 'admin_approved_at', type: 'timestamptz', nullable: true })
  adminApprovedAt: Date | null;

  /** Last admin who approved/rejected/unlocked this report (additive audit columns). */
  @Column({ name: 'admin_reviewed_by', type: 'varchar', length: 255, nullable: true })
  adminReviewedBy: string | null;

  @Column({ name: 'admin_reviewed_at', type: 'timestamptz', nullable: true })
  adminReviewedAt: Date | null;

  @Column({ default: 'draft' })
  status: string; // 'draft', 'submitted', 'partner_verified', 'payment_pending' (legacy), 'payment_under_review', 'verified', 'rejected', 'paid', 'closed'

  @Column({ default: 'pending' })
  partner_status: string; // 'pending', 'approved', 'rejected'

  @Column({ default: 'pending' })
  admin_status: string; // 'pending', 'approved', 'rejected'

  @Column({ type: 'text', nullable: true })
  admin_feedback: string;

  /** Set when CIEL PK Admin retracts an already-published report (e.g. fraud found later) —
   * distinct from 'reject' (sends back for student revision) and 'unlock' (reopens as draft).
   * 'closed' is terminal: the report stops counting anywhere it was already published. */
  @Column({ name: 'closed_at', type: 'timestamptz', nullable: true })
  closedAt: Date | null;

  @Column({ name: 'closed_by_admin_id', type: 'varchar', length: 255, nullable: true })
  closedByAdminId: string | null;

  @Column({ name: 'close_reason', type: 'text', nullable: true })
  closeReason: string | null;

  /** Badges pinned when a stakeholder runs the community-service award model (faculty / partner / university / CIEL).
   * One entry per kind — a new run replaces the previous entry of the same kind here. */
  @Column({ type: 'jsonb', nullable: true })
  awardBadges?: Array<{
    kind: 'fac' | 'par' | 'uni' | 'ciel';
    label: string;
    rank: number;
    of: number;
    score: number;
    scope: string;
    at: string;
    by?: string;
  }> | null;

  /** Append-only log of every award-badge run ever recorded for this report, never overwritten —
   * lets the student-facing National Ranking screen show trend (rank moving up/down over time)
   * and best-rank-held history per cohort, which the upsert-only awardBadges column can't. */
  @Column({ type: 'jsonb', nullable: true })
  awardBadgeHistory?: Array<{
    kind: 'fac' | 'par' | 'uni' | 'ciel';
    label: string;
    rank: number;
    of: number;
    score: number;
    scope: string;
    at: string;
    by?: string;
  }> | null;

  // Auto-Generated Summary Fields (Section 2 Context)
  @Column({ type: 'text', nullable: true })
  summary_text_generated: string;

  @Column({ nullable: true })
  problem_category: string;

  @Column({ nullable: true })
  primary_beneficiary: string;

  @Column({ nullable: true })
  baseline_evidence_source: string;

  @Column({ nullable: true })
  discipline_alignment: string;

  // Section 3: SDG Mapping Metadata
  @Column({ type: 'int', nullable: true })
  primary_sdg_goal: number | null;

  @Column({ type: 'varchar', nullable: true })
  primary_sdg_target: string | null;

  @Column({ type: 'varchar', nullable: true })
  primary_sdg_indicator: string | null;

  @Column({ type: 'text', nullable: true })
  contribution_intent_statement: string;

  @Column({ default: 'pending' })
  sdg_validation_status: string; // 'pending', 'validated', 'weak'

  @Column({ default: 'preliminary' })
  sdg_summary_stage: string; // 'preliminary', 'validated'

  // Section 1: Participation (Standardized 11-section structure)
  @Column({ type: 'jsonb', nullable: true })
  section1: {
    participation_type: 'individual' | 'team';
    faculty_supervisor_email?: string;
    team_lead: {
      name: string;
      fullName?: string;
      cnic: string;
      mobile: string;
      email: string;
      university: string;
      degree: string;
      year: string;
      /** "Semester (1-10)" — additive alongside `year`/Year of Study, not derived from it. */
      semester?: string;
      role?: string;
      hours?: string;
      verified?: boolean;
    };
    /** Not persisted here — stripped before save; team members' identity/academic data (incl. `semester`)
     * lives on the `Participation` record and is read live by teamId/projectId. */
    team_members?: Array<{
      name: string;
      fullName?: string;
      cnic: string;
      mobile: string;
      university: string;
      program: string;
      semester?: string;
      role: string;
      hours: string;
      verified?: boolean;
    }>;
    attendance_logs: Array<{
      id: string;
      date: string;
      start_time: string;
      end_time: string;
      location: string;
      activity_type: string;
      description: string;
      hours: number;
      entryStatus?: string;
    }>;
    metrics: {
      total_verified_hours: number;
      total_active_days: number;
      engagement_span: number;
      attendance_frequency: number;
      weekly_continuity: number;
      eis_score: number;
      engagement_category: string;
      hec_compliance: string;
    };
    privacy_consent: boolean;
    verified_summary?: string;
    media_urls?: string[];
  };

  // Section 2: Project Context
  @Column({ type: 'jsonb', nullable: true })
  section2: {
    problem_statement: string;
    discipline: string;
    discipline_contribution: string;
    baseline_evidence: string;
    baseline_evidence_other?: string;
    baseline_other_entries?: string[];
    problem_category?: string;
    primary_beneficiary?: string;
    summary_text?: string;
    affected_group?: string;
    affected_count?: string;
    system_gaps?: string[];
    /** Legacy single "Other" gap text — kept in sync with system_gaps_other_entries. */
    system_gaps_other?: string;
    /** Multiple custom "Other" gap texts when the student uses Add another. */
    system_gaps_other_entries?: string[];
    media_urls?: string[];
  };

  // Section 3: SDG Contribution Mapping
  @Column({ type: 'jsonb', nullable: true })
  section3: {
    primary_sdg: {
      goal_number: number | null;
      goal_title: string;
      target_code: string;
      indicator_code: string;
      /** Frontend report form field; kept alongside target_code. */
      target_id?: string;
      /** Frontend report form field; kept alongside indicator_code. */
      indicator_id?: string;
      /** Optional local metric after the UN indicator. */
      sub_indicator?: string;
    };
    contribution_intent_statement: string;
    secondary_sdgs: Array<{
      goal_number: number;
      target_id?: string;
      indicator_id?: string;
      sub_indicator?: string;
      justification_text: string;
      status: 'provisional' | 'validated' | 'rejected';
    }>;
    summary_text?: string;
    media_urls?: string[];
  };

  // Section 4: Activities (Expanded)
  @Column({ type: 'jsonb', nullable: true })
  section4: {
    activity_type: string;
    delivery_mode: string;
    total_sessions: string;
    duration_val: string;
    duration_unit: string;
    total_beneficiaries: string;
    my_role: string;
    my_hours: string;
    my_sessions: string;
    my_beneficiaries: string;
    my_output: string;
    beneficiary_categories: string[];
    media_urls?: string[];
  };

  // Section 5: Outcomes (Detailed Metrics)
  @Column({ type: 'jsonb', nullable: true })
  section5: {
    observed_change: string;
    outcome_area: string;
    metric: string;
    baseline: string;
    endline: string;
    unit: string;
    confidence_level: string;
    challenges: string;
    media_urls?: string[];
  };

  // Section 6: Resources (Structured)
  @Column({ type: 'jsonb', nullable: true })
  section6: {
    use_resources: 'yes' | 'no';
    resources: Array<{
      type: string;
      amount: string;
      unit: string;
      source: string;
      purpose: string;
      verification: string;
    }>;
    media_urls?: string[];
  };

  // Section 7: Partnerships (Structured)
  @Column({ type: 'jsonb', nullable: true })
  section7: {
    has_partners: 'yes' | 'no';
    partners: Array<{
      name: string;
      type: string;
      role: string;
      contribution: string[];
      verification: string;
    }>;
    formalization_status: string[];
    media_urls?: string[];
  };

  // Section 8: Evidence (Expanded)
  @Column({ type: 'jsonb', nullable: true })
  section8: {
    evidence_types: string[];
    description: string;
    media_visible: 'public' | 'restricted' | 'private' | 'limited' | 'internal';
    public_share_permission?: boolean;
    ethical_compliance: {
      authentic: boolean;
      informed_consent: boolean;
      no_harm: boolean;
      privacy_respected: boolean;
    };
    partner_verification: boolean;
    media_urls?: string[];
  };

  // Section 9: Reflection (Academic Integration)
  @Column({ type: 'jsonb', nullable: true })
  section9: {
    academic_integration: string;
    personal_learning: string;
    academic_application: string;
    sustainability_reflection: string;
    competency_scores: {
      cognitive: number;
      practical: number;
      social: number;
      transformative: number;
    };
    strongest_competency: string;
    media_urls?: string[];
  };

  // Section 10: Sustainability (Planning)
  @Column({ type: 'jsonb', nullable: true })
  section10: {
    continuation_status: 'yes' | 'partially' | 'no';
    continuation_details: string;
    mechanisms: string[];
    scaling_potential: string;
    policy_influence: string;
    media_urls?: string[];
  };

  // Section 11: Final Intelligence Summary
  @Column({ type: 'jsonb', nullable: true })
  section11: {
    ai_generated_impact_score?: number;
    institutional_alignment_score?: number;
    verified_narrative?: string;
    /** Final report declaration — 5 checkboxes gating submission, replacing a per-section sign-off. */
    final_declaration?: boolean[];
    /** Typed full-name electronic signature accompanying the final declaration. */
    signature_name?: string;
    /** Auto-recorded timestamp the moment the declaration + signature were completed. */
    signed_at?: string;
  };

  /**
   * Retired CII v3.1 ("Balanced CII Rubric") snapshot + faculty approve+lock decision. The v3.1
   * analyzer, prompt, parser and redaction logic have been fully removed — CII v4.5 (`ciiV45`/
   * `ciiV45Lock` below) is now the only path for every report. These two columns are kept
   * declared here, UNUSED BY ANY CODE, purely so TypeORM's `synchronize: true` does not drop
   * them (and the historical v3.1 score data already stored in them) on the next deploy. Do not
   * read or write these from new code — read `ciiV45`/`ciiV45Lock` instead.
   */
  @Column({ type: 'jsonb', nullable: true })
  ciiV2?: Record<string, unknown> | null;

  /** @deprecated retired alongside `ciiV2` above — kept only to avoid an automatic column drop. */
  @Column({ type: 'jsonb', nullable: true })
  ciiV2Lock?: Record<string, unknown> | null;

  /** Composite Impact Index v4.5 evaluation (AI anchors/claims/evidence/narrative + server-computed
   * scores) — the only CII path for Community Service reports. */
  @Column({ type: 'jsonb', nullable: true })
  ciiV45?: Record<string, unknown> | null;

  /** Admin Accept & Publish decision for the CII v4.5 score — immutable once locked. */
  @Column({ type: 'jsonb', nullable: true })
  ciiV45Lock?: {
    locked: boolean;
    hash: string;
    lockedAt: string;
    lockedByAdminId: string;
    adminNote?: string;
    /** The fingerprint this lock was taken against — a live recheck must match this before publish. */
    inputFingerprint: string;
    /** Locking is only ever possible from a stored `ciiV45.scoreStatus === 'FINAL'`. */
    scoreStatusAtLock: 'FINAL';
    aiRecommendedScore?: number;
    adminApprovedScore?: number;
    scoreWasModerated?: boolean;
    scoreModerationReason?: string;
    finalBadge?: {
      code: string;
      name: string;
      level: number;
      numericLevel: number;
      gateCapped: boolean;
    } | null;
  } | null;

  /**
   * Independent AI analyses run from My Impact Wall.
   *
   * These do NOT overwrite the admin-approved record. Each analysis is
   * stored separately with timestamp and who ran it, creating an audit trail.
   * Authorized stakeholders (Faculty, University, CIEL PK) can run additional
   * analyses without disturbing the official approved score.
   */
  @Column({ type: 'jsonb', nullable: true })
  independentAiAnalyses?: Array<{
    id: string;
    runAt: string;
    runByUserId: string;
    runByRole: 'faculty' | 'university' | 'ciel_admin';
    runByName?: string;
    score: number | null;
    badge?: {
      code: string;
      name: string;
      level: number;
      numericLevel: number;
      gateCapped: boolean;
    } | null;
    sections?: Array<{
      dimension: string;
      name: string;
      maximumPoints: number;
      score: number | null;
    }>;
    extraMileUplift?: { total: number | null };
    integrityPenalty?: number;
    feedback?: string;
    note?: string;
  }> | null;

  /**
   * Three-document review package built on student submit:
   * revised flashcard, detailed report, evidence files (previewable thumbs).
   */
  @Column({ name: 'review_package', type: 'jsonb', nullable: true })
  review_package: Record<string, unknown> | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @BeforeInsert()
  @BeforeUpdate()
  assignVerificationPublicSlugIfNeeded(): void {
    if (!this.verificationPublicSlug?.trim()) {
      this.verificationPublicSlug = randomUUID();
    }
  }
}
