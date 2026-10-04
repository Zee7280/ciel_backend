import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  UnauthorizedException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Repository,
  In,
  DeepPartial,
  Brackets,
  EntityManager,
  ObjectLiteral,
  QueryFailedError,
  IsNull,
} from 'typeorm';
import { Opportunity } from './entities/opportunity.entity';
import { Organization } from '../organizations/entities/organization.entity';
import {
  CREATE_DEDUPE_IGNORED_STATUSES,
  CREATE_DEDUPE_WINDOW_MS,
  createPayloadFingerprint,
} from './opportunity-create-dedupe.util';
import { Participation } from '../engagement/entities/participant.entity';
import {
  CreateOpportunityDto,
  UpdateOpportunityDto,
} from './dto/create-opportunity.dto';
import { AdminSetOpportunityContactsDto } from './dto/admin-set-opportunity-contacts.dto';
import { OrganizationsService } from '../organizations/organizations.service';
import { EngagementService } from '../engagement/engagement.service';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/enums/user-role.enum';
import {
  getProfileCompletionStatus,
  resolveDisplayNameForProfile,
} from '../users/profile-completion.util';
import {
  MailService,
  OpportunityVerificationEmailDetails,
} from '../mail/mail.service';
import { randomUUID } from 'crypto';
import { applyCanonicalPrivateCandidatePhone, isPrivateCandidateDto } from './private-candidate.util';
import { isPubliclyVisibleOpportunity as isPubliclyVisibleOpportunityUtil } from './opportunity-visibility.util';
import {
  OpportunityWorkflowService,
  WORKFLOW_STAGE,
  LINE_STATUS,
  ApprovalActor,
} from './opportunity-workflow.service';
import {
  normalizeOpportunityTitleForMatch,
  opportunityMatchesUniversity,
  opportunityTitlesAreSimilar,
} from './opportunity-title-match.util';
import {
  buildOpportunityDetailView,
  STUDENT_RESPONSIBILITIES_MAX_LENGTH,
} from './opportunity-detail-view.util';
import {
  buildStudentBrowseListingFields,
  classifyBrowseCreator,
} from './student-browse-listing.util';
import { purifyStudentOpportunityContent } from './opportunity-content-purify.util';
import {
  buildApprovalReminderCopy,
  buildOpportunityApprovalTracker,
  communityServicePublicCode,
} from './opportunity-approval-tracker.util';
import { redactOpportunityContactDetails } from './opportunity-secrets.util';
import { isProjectVerificationAuthRequired } from '../common/project-verification-auth.util';
import { canonicalizePhoneInput } from '../common/phone-e164.util';
import { NotificationsService } from '../notifications/notifications.service';
import { OpportunityApplication } from './entities/opportunity-application.entity';
import { OpportunityApplicationsService } from './opportunity-applications.service';
import { StudentReport } from '../reports/entities/student-report.entity';
import { Report } from '../reports/entities/report.entity';
import { AttendanceLog } from '../engagement/entities/attendance-log.entity';
import { Payment } from '../payments/entities/payment.entity';
import { Timesheet } from '../timesheets/entities/timesheet.entity';
import { FacultyUniversityScopeService } from '../faculty-university-scope/faculty-university-scope.service';
import {
  REPORTING_WINDOW_DAYS,
  addDaysToDateOnly,
  asTimeline,
  compareDateOnly,
  getProjectEndDate,
  toDateOnlyString,
  validateTimelineForPersist,
} from './opportunity-timeline.util';

/** Authenticated caller shape (`req.user`) used to gate opportunity detail reads. */
export interface OpportunityDetailViewer {
  id?: string;
  email?: string;
  role?: string;
  organizationId?: string | null;
}

/** Columns only the workflow/approval services may write — never client-patchable. */
/** Cap on the free-text reason accepted from anonymous magic-link reject/revision calls. */
export const MAX_TOKEN_DECISION_REASON_LENGTH = 2000;

const SERVER_CONTROLLED_OPPORTUNITY_FIELDS = [
  'id',
  'status',
  'admin_approved',
  'admin_approval_required',
  'workflowStage',
  'workflow_stage',
  'facultyApprovalStatus',
  'partnerApprovalStatus',
  'adminApprovalStatus',
  'faculty_approval_status',
  'partner_approval_status',
  'admin_approval_status',
  'faculty_verified',
  'faculty_verification_token',
  'faculty_verification_status',
  'partnerToken',
  'partnerTokenExpiresAt',
  'facultyTokenExpiresAt',
  'liaisonToken',
  'liaisonVerified',
  'partnerVerified',
  'requiresPartnerApproval',
  'execution_verified',
  'execution_verification_token',
  'execution_verification_status',
  'rejectionReason',
  'rejection_reason',
  'createFingerprint',
  'creatorId',
  'facultyId',
  'organizationId',
  'isStudentCreated',
  'version',
  'approvalHistory',
  'attendanceRoutingOverride',
  'admin_hidden',
  'admin_expired',
  'createdAt',
  'updatedAt',
] as const;

/** Roles that may POST /opportunities. Students use the student flow; investors have none. */
const OPPORTUNITY_CREATOR_ROLES: UserRole[] = [
  UserRole.SUPER_ADMIN,
  UserRole.FACULTY,
  UserRole.UNIVERSITY,
  UserRole.NGO,
  UserRole.CORPORATE,
  UserRole.ORGANIZATION_ADMIN,
];

function stripServerControlledFields<T extends Record<string, unknown>>(
  patch: T,
): Partial<T> {
  const clean: Record<string, unknown> = { ...patch };
  for (const key of SERVER_CONTROLLED_OPPORTUNITY_FIELDS) delete clean[key];
  // The validation pipe (`transform: true`) instantiates the DTO with every un-sent field set to
  // `undefined`. `Object.assign(entity, patch)` would copy those over the loaded entity, so any
  // logic reading the in-memory row after a partial edit (partner / faculty email resolution,
  // gate recomputation) would see `supervision` / `partner_organization` / … as missing even
  // though they are still stored. Only fields the client actually sent may overwrite the row.
  for (const key of Object.keys(clean)) {
    if (clean[key] === undefined) delete clean[key];
  }
  return clean as Partial<T>;
}

/** Cap for the long free-text opportunity description. */
const OPPORTUNITY_LONG_TEXT_MAX = 12000;

/** Wizard fields a draft save may write. Tokens, approval gates, ownership, and status stay server-owned. */
const DRAFT_PERSIST_KEYS = [
  'title',
  'types',
  'mode',
  'location',
  'timeline',
  'sdg_info',
  'secondary_sdgs',
  'objectives',
  'activity_details',
  'supervision',
  'verification_method',
  'restricted_universities',
  'executing_context',
  'executing_organization',
  'partner_organization',
  'safety_supervision_declaration',
  'safety_declaration',
  'submission_confirmations',
  'participation_scope',
  'visibility_and_academic_linkage',
  'external_partner_collaboration',
  'academic_linkage',
  'student_contact',
  'visibility',
] as const;

/** Same wizard fields, for full (non-draft) edits through update(). Server-owned keys stay out. */
const UPDATE_PERSIST_KEYS = DRAFT_PERSIST_KEYS;

function pickDraftPersistFields(dto: Record<string, unknown>): Record<string, unknown> {
  let plain: Record<string, unknown>;
  try {
    plain = JSON.parse(JSON.stringify(dto ?? {})) as Record<string, unknown>;
  } catch {
    plain = { ...(dto ?? {}) };
  }
  const picked: Record<string, unknown> = {};
  for (const key of DRAFT_PERSIST_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(plain, key)) continue;
    if (plain[key] === undefined) continue;
    picked[key] = plain[key];
  }
  if (typeof picked.mode === 'string' && !picked.mode.trim()) {
    picked.mode = null;
  }
  if (picked.types !== undefined && !Array.isArray(picked.types)) {
    picked.types = [];
  }
  if (
    picked.verification_method !== undefined &&
    !Array.isArray(picked.verification_method)
  ) {
    picked.verification_method = [];
  }
  return picked;
}

@Injectable()
export class OpportunitiesService {
  constructor(
    @InjectRepository(Opportunity)
    private opportunitiesRepository: Repository<Opportunity>,
    @InjectRepository(Participation)
    private participationRepository: Repository<Participation>,
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    @InjectRepository(Organization)
    private organizationsRepository: Repository<Organization>,
    private organizationsService: OrganizationsService,
    private engagementService: EngagementService,
    private mailService: MailService,
    private notificationsService: NotificationsService,
    private readonly opportunityWorkflow: OpportunityWorkflowService,
    private readonly opportunityApplicationsService: OpportunityApplicationsService,
    private readonly facultyUniversityScope: FacultyUniversityScopeService,
  ) {}

  private isValidEmail(email?: string) {
    if (!email) return false;
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
  }

  private normalizeEmail(s?: string | null) {
    return (s || '').trim().toLowerCase();
  }

  private async deleteChildRows(
    manager: EntityManager,
    entity: { new (): ObjectLiteral },
    where: Record<string, unknown> | Array<Record<string, unknown>>,
  ): Promise<number> {
    const filters = Array.isArray(where) ? where : [where];
    let affected = 0;

    for (const filter of filters) {
      const result = await manager.delete(entity, filter);
      affected += result.affected ?? 0;
    }

    return affected;
  }

  private async deleteOpportunityChildren(
    manager: EntityManager,
    opportunityId: string,
  ) {
    const deleted = {
      attendanceLogs: await this.deleteChildRows(manager, AttendanceLog, {
        projectId: opportunityId,
      }),
      payments: await this.deleteChildRows(manager, Payment, {
        projectId: opportunityId,
      }),
      studentReports: await this.deleteChildRows(manager, StudentReport, [
        { opportunityId },
        { project_id: opportunityId },
      ]),
      reports: await this.deleteChildRows(manager, Report, { opportunityId }),
      timesheets: await this.deleteChildRows(manager, Timesheet, {
        opportunityId,
      }),
      opportunityApplications: await this.deleteChildRows(
        manager,
        OpportunityApplication,
        { opportunityId },
      ),
      participations: await this.deleteChildRows(manager, Participation, {
        projectId: opportunityId,
      }),
    };

    return deleted;
  }

  private extractQueryFailedDetail(error: QueryFailedError) {
    const driverError = error.driverError as
      | { detail?: string; message?: string }
      | undefined;
    return String(
      driverError?.detail || driverError?.message || error.message || '',
    ).trim();
  }

  private buildOpportunityDeleteConflictMessage(id: string, error: unknown) {
    const dbDetail =
      error instanceof QueryFailedError
        ? this.extractQueryFailedDetail(error)
        : '';

    return dbDetail
      ? `Opportunity "${id}" could not be deleted because dependent records still exist: ${dbDetail}`
      : `Opportunity "${id}" could not be deleted because dependent records still exist. Remove or unlink the remaining child records and try again.`;
  }

  /** F2 “additional partner organization” — executing-org portal confirmation runs only when this block is present. */
  private hasAdditionalPartnerOrganization(
    dto: Pick<CreateOpportunityDto, 'partner_organization'>,
  ): boolean {
    const po = dto.partner_organization as
      | Record<string, unknown>
      | null
      | undefined;
    if (!po || typeof po !== 'object') return false;
    const email =
      typeof po['official_email'] === 'string'
        ? po['official_email'].trim()
        : '';
    const name =
      typeof po['organization_name'] === 'string'
        ? po['organization_name'].trim()
        : '';
    return email.length > 0 || name.length > 0;
  }

  /**
   * Partner contact email for student-created opportunities (legacy + new payload shapes).
   * Priority: external_partner_collaboration → supervision external/partner fields → executing_context.partner → partner_organization.
   */
  private resolvePartnerEmail(dto: CreateOpportunityDto): string | null {
    const collab = dto.external_partner_collaboration as
      | { official_email?: string }
      | undefined;
    const fromCollab =
      collab && typeof collab.official_email === 'string'
        ? collab.official_email
        : undefined;
    const sup = dto.supervision as
      | { external_partner_email?: string; partner_email?: string }
      | undefined;
    const fromSupExt =
      sup && typeof sup.external_partner_email === 'string'
        ? sup.external_partner_email
        : undefined;
    const fromSupPartner =
      sup && typeof sup.partner_email === 'string'
        ? sup.partner_email
        : undefined;
    const ctx = dto.executing_context as
      | { partner?: { official_email?: string } }
      | undefined;
    const fromCtx =
      ctx?.partner && typeof ctx.partner.official_email === 'string'
        ? ctx.partner.official_email
        : undefined;
    const po = dto.partner_organization as
      | { official_email?: string }
      | undefined;
    const fromPo =
      po && typeof po.official_email === 'string'
        ? po.official_email
        : undefined;

    for (const c of [fromCollab, fromSupExt, fromSupPartner, fromCtx, fromPo]) {
      const e = this.normalizeEmail(c);
      if (e && this.isValidEmail(e)) {
        return e;
      }
    }
    return null;
  }

  /** Same heuristics as {@link resolvePartnerEmail}, reading persisted opportunity JSON. */
  private resolvePartnerEmailFromOpportunity(opp: Opportunity): string | null {
    return this.resolvePartnerEmail({
      external_partner_collaboration: opp.external_partner_collaboration,
      supervision: opp.supervision,
      executing_context: opp.executing_context,
      partner_organization: opp.partner_organization,
    } as CreateOpportunityDto);
  }

  /**
   * EVERY partner contact email the creator's form can carry (not just the first non-empty one):
   * the partner list (`GET /opportunities?partner_id=me`) matches a row on any of these, so the
   * detail read and the approve/reject/revise gate must accept the same set — otherwise a partner
   * listed through a later field gets a 404 / 403 on a row the UI shows.
   */
  private collectPartnerContactEmails(opp: Opportunity): string[] {
    const collab = opp.external_partner_collaboration as
      | { official_email?: unknown }
      | null
      | undefined;
    const sup = opp.supervision as
      | { external_partner_email?: unknown; partner_email?: unknown }
      | null
      | undefined;
    const ctx = opp.executing_context as
      | { partner?: { official_email?: unknown } }
      | null
      | undefined;
    const po = opp.partner_organization as
      | { official_email?: unknown }
      | null
      | undefined;
    return this.uniqueValidEmails([
      collab?.official_email,
      sup?.external_partner_email,
      sup?.partner_email,
      ctx?.partner?.official_email,
      po?.official_email,
    ]);
  }

  /** EVERY faculty contact email on the record (supervision contact / official email and the
   * NGO form's "academic / faculty link" representative) — the faculty approvals list matches all. */
  private collectFacultyReviewerEmails(opp: Opportunity): string[] {
    const sup = opp.supervision as
      | { contact?: unknown; official_email?: unknown }
      | null
      | undefined;
    const val = opp.visibility_and_academic_linkage as
      | {
          faculty_institutional_representative?: { official_email?: unknown };
        }
      | null
      | undefined;
    return this.uniqueValidEmails([
      sup?.contact,
      sup?.official_email,
      val?.faculty_institutional_representative?.official_email,
    ]);
  }

  /** Official executing-organization contact(s) — the only login that may confirm execution. */
  private collectExecutingOrgEmails(opp: Opportunity): string[] {
    const exec = opp.executing_organization as
      | { official_email?: unknown; officialEmail?: unknown }
      | null
      | undefined;
    return this.uniqueValidEmails([exec?.official_email, exec?.officialEmail]);
  }

  private uniqueValidEmails(raw: unknown[]): string[] {
    const out = new Set<string>();
    for (const r of raw) {
      if (typeof r !== 'string') continue;
      const e = this.normalizeEmail(r);
      if (e && this.isValidEmail(e)) out.add(e);
    }
    return [...out];
  }

  private buildOpportunityVerificationEmailDetails(
    opp: Opportunity,
    meta: {
      studentName?: string;
      studentUniversity?: string;
      facultyAuthorName?: string;
      facultyAuthorEmail?: string;
    },
  ): OpportunityVerificationEmailDetails {
    const timeline = opp.timeline as Record<string, unknown> | null | undefined;
    const tl: string[] = [];
    if (timeline && typeof timeline === 'object') {
      if (timeline.start_date)
        tl.push(`Starts: ${String(timeline.start_date)}`);
      if (timeline.end_date) tl.push(`Ends: ${String(timeline.end_date)}`);
      if (timeline.expected_hours != null && timeline.expected_hours !== '') {
        tl.push(`Expected hours: ${String(timeline.expected_hours)}`);
      }
    }
    const sup = opp.supervision as Record<string, unknown> | null | undefined;
    const supervisorBits: string[] = [];
    if (sup && typeof sup === 'object') {
      if (
        typeof sup.supervisor_name === 'string' &&
        sup.supervisor_name.trim()
      ) {
        supervisorBits.push(sup.supervisor_name.trim());
      }
      if (
        typeof sup.faculty_department === 'string' &&
        sup.faculty_department.trim()
      ) {
        supervisorBits.push(sup.faculty_department.trim());
      }
      if (
        typeof sup.faculty_university_name === 'string' &&
        sup.faculty_university_name.trim()
      ) {
        supervisorBits.push(sup.faculty_university_name.trim());
      }
    }
    let partnerOrg: string | undefined;
    if (
      sup &&
      typeof sup.partner_org_name === 'string' &&
      sup.partner_org_name.trim()
    ) {
      partnerOrg = sup.partner_org_name.trim();
    }
    const po = opp.partner_organization as
      | {
          organization_name?: string;
          contact_person_name?: string;
        }
      | undefined;
    if (!partnerOrg && po?.organization_name?.trim())
      partnerOrg = po.organization_name.trim();
    const collab = opp.external_partner_collaboration as
      | {
          organization_name?: string;
          contact_person_name?: string;
          contact_name?: string;
        }
      | undefined;
    if (!partnerOrg && collab?.organization_name?.trim())
      partnerOrg = collab.organization_name.trim();
    const ectPartner = opp.executing_context?.partner as
      | {
          organization_name?: string;
          contact_person_name?: string;
          contact_name?: string;
        }
      | undefined;
    if (!partnerOrg && ectPartner?.organization_name?.trim())
      partnerOrg = ectPartner.organization_name.trim();

    let partnerRecipientName: string | undefined;
    const supPartnerContact =
      sup &&
      typeof sup === 'object' &&
      typeof sup.partner_contact_person === 'string' &&
      sup.partner_contact_person.trim()
        ? sup.partner_contact_person.trim()
        : undefined;
    if (po?.contact_person_name?.trim())
      partnerRecipientName = po.contact_person_name.trim();
    else if (collab?.contact_person_name?.trim())
      partnerRecipientName = collab.contact_person_name.trim();
    else if (collab?.contact_name?.trim())
      partnerRecipientName = collab.contact_name.trim();
    else if (ectPartner?.contact_person_name?.trim())
      partnerRecipientName = ectPartner.contact_person_name.trim();
    else if (ectPartner?.contact_name?.trim())
      partnerRecipientName = ectPartner.contact_name.trim();
    else if (supPartnerContact) partnerRecipientName = supPartnerContact;
    else if (partnerOrg) partnerRecipientName = partnerOrg;

    const ect = opp.executing_context as { type?: string } | undefined;
    let executionSummary: string | undefined;
    if (ect?.type === 'partner')
      executionSummary = 'With host / partner organization';
    else if (ect?.type === 'independent')
      executionSummary = 'Independent community activity';

    let objectivesPreview: string | undefined;
    const obj = opp.objectives as { description?: string } | undefined;
    if (obj?.description && typeof obj.description === 'string') {
      const raw = obj.description.trim();
      if (raw)
        objectivesPreview = raw.length > 300 ? `${raw.slice(0, 297)}…` : raw;
    }

    let sdgLabel: string | undefined;
    const sdg = opp.sdg_info as { sdg_id?: string } | undefined;
    if (sdg?.sdg_id) sdgLabel = String(sdg.sdg_id);
    else if (opp.sdg && opp.sdg !== 'SDG') sdgLabel = opp.sdg;

    const loc = opp.location as { city?: string; venue?: string } | undefined;
    const locParts = [loc?.city, loc?.venue].filter(
      (x): x is string => typeof x === 'string' && !!x.trim(),
    );

    const scope = opp.participation_scope as
      | { creator_university_name?: string }
      | null
      | undefined;
    const creatorUni =
      scope &&
      typeof scope.creator_university_name === 'string' &&
      scope.creator_university_name.trim()
        ? scope.creator_university_name.trim()
        : undefined;
    const institutionName = meta.studentUniversity?.trim() || creatorUni;

    let facultyReviewerName: string | undefined;
    let departmentName: string | undefined;
    if (sup && typeof sup === 'object') {
      if (
        typeof sup.supervisor_name === 'string' &&
        sup.supervisor_name.trim()
      ) {
        facultyReviewerName = sup.supervisor_name.trim();
      }
      if (
        typeof sup.faculty_department === 'string' &&
        sup.faculty_department.trim()
      ) {
        departmentName = sup.faculty_department.trim();
      }
    }

    let volunteersRequired: string | undefined;
    if (
      timeline &&
      typeof timeline === 'object' &&
      timeline.volunteers_required != null &&
      timeline.volunteers_required !== ''
    ) {
      volunteersRequired = String(timeline.volunteers_required);
    }

    return {
      publicCode: communityServicePublicCode(opp.id, opp.createdAt),
      mode: opp.mode || undefined,
      typesLine: opp.types?.length ? opp.types.join(', ') : undefined,
      timelineSummary: tl.length ? tl.join(' · ') : undefined,
      locationSummary: locParts.length ? locParts.join(', ') : undefined,
      sdgLabel,
      partnerOrganization: partnerOrg,
      partnerRecipientName,
      executionSummary,
      facultySupervisionLine: supervisorBits.length
        ? supervisorBits.join(' · ')
        : undefined,
      objectivesPreview,
      studentName: meta.studentName,
      studentUniversity: meta.studentUniversity,
      institutionName,
      facultyReviewerName,
      departmentName,
      volunteersRequired,
      facultyAuthorName: meta.facultyAuthorName,
      facultyAuthorEmail: meta.facultyAuthorEmail,
    };
  }

  /**
   * Public magic-link tokens: must be a non-empty string of URL-safe chars (randomUUID is 36).
   * TypeORM silently DROPS `where: { col: undefined }`, which would match an arbitrary row, so
   * every token entry point normalizes first. Malformed input gets the same generic 404 as an
   * unknown token so existence is never leaked.
   */
  private normalizeVerificationToken(token: unknown): string {
    if (
      typeof token !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(token.trim())
    ) {
      throw new NotFoundException('Invalid or expired verification link.');
    }
    return token.trim();
  }

  private normalizeDecisionReason(reason: unknown): string | undefined {
    if (reason === undefined || reason === null) return undefined;
    if (typeof reason !== 'string') {
      throw new BadRequestException('Reason must be text.');
    }
    const r = reason.trim();
    if (r.length > MAX_TOKEN_DECISION_REASON_LENGTH) {
      throw new BadRequestException(
        `Reason must be at most ${MAX_TOKEN_DECISION_REASON_LENGTH} characters.`,
      );
    }
    return r || undefined;
  }

  /** Like normalizeDecisionReason, but a trimmed non-empty reason is mandatory (400 otherwise). */
  private requireDecisionReason(reason: unknown): string {
    const r = this.normalizeDecisionReason(reason);
    if (!r) {
      throw new BadRequestException(
        'A reason is required (it is shown to the creator so they know what to change).',
      );
    }
    return r;
  }

  /** Expired link → identical generic 404 as an unknown token. Null expiry = no expiry. */
  private assertVerificationLinkNotExpired(
    expiresAt: Date | string | null | undefined,
  ): void {
    if (!expiresAt) return;
    const t = new Date(expiresAt).getTime();
    if (Number.isFinite(t) && t < Date.now()) {
      throw new NotFoundException('Invalid or expired verification link.');
    }
  }

  /** Rejected / revision / draft / closed rows can never be actioned through an emailed link. */
  private isClosedForTokenAction(opp: Opportunity): boolean {
    const status = String(opp.status || '').toLowerCase();
    return (
      opp.workflowStage === WORKFLOW_STAGE.REJECTED ||
      opp.workflowStage === WORKFLOW_STAGE.REVISION ||
      ['rejected', 'revision', 'draft', 'closed', 'cancelled', 'canceled', 'completed', 'archived'].includes(status)
    );
  }

  private assertOpenForTokenAction(opp: Opportunity): void {
    if (this.isClosedForTokenAction(opp)) {
      throw new BadRequestException(
        'This opportunity is not awaiting action and can no longer be actioned via this link.',
      );
    }
  }

  private verificationAuthRequired(): boolean {
    return isProjectVerificationAuthRequired();
  }

  private projectVerificationTokenKind(
    opportunity: Opportunity,
    token: string,
  ): 'faculty' | 'partner' | 'liaison' | null {
    if (opportunity.faculty_verification_token === token) return 'faculty';
    if (opportunity.partnerToken === token) return 'partner';
    if (opportunity.liaisonToken === token) return 'liaison';
    return null;
  }

  private verificationUserMatchesToken(
    opportunity: Opportunity,
    kind: 'faculty' | 'partner' | 'liaison',
    user: { id: string; email: string; role: string },
  ): boolean {
    const ue = this.normalizeEmail(user.email);
    if (kind === 'faculty' || kind === 'liaison') {
      if (user.role !== UserRole.FACULTY) return false;
      if (opportunity.facultyId && user.id === opportunity.facultyId)
        return true;
      const sup = opportunity.supervision as
        | Record<string, unknown>
        | undefined;
      const c = this.normalizeEmail(
        typeof sup?.contact === 'string' ? sup.contact : '',
      );
      const oe = this.normalizeEmail(
        typeof sup?.official_email === 'string' ? sup.official_email : '',
      );
      if (ue === c || (!!oe && ue === oe)) return true;
      const po = opportunity.partner_organization as
        | Record<string, unknown>
        | undefined;
      const poe = this.normalizeEmail(
        typeof po?.official_email === 'string' ? po.official_email : '',
      );
      return !!poe && ue === poe;
    }
    const pe = this.resolvePartnerEmailFromOpportunity(opportunity);
    if (!pe || ue !== this.normalizeEmail(pe)) return false;
    if (user.role === UserRole.STUDENT) return false;
    return true;
  }

  /**
   * When VERIFICATION_REQUIRE_AUTH is enabled, a legacy liaison link still needs a matching login.
   * Faculty and partner magic links stay anonymous: the emailed token is the credential, same as
   * the public partner flashcard. Dashboard approve/reject/revise is a separate logged-in path.
   */
  private assertVerificationIdentityIfRequired(
    opportunity: Opportunity,
    token: string,
    user?: { id: string; email: string; role: string },
  ): void {
    const kind = this.projectVerificationTokenKind(opportunity, token);
    if (kind === 'partner' || kind === 'faculty') return;
    if (!this.verificationAuthRequired()) return;
    if (!user?.id) {
      throw new UnauthorizedException('Login required to verify this link.');
    }
    if (!kind) return;
    if (!this.verificationUserMatchesToken(opportunity, kind, user)) {
      throw new ForbiddenException('Ye link is account se link nahi hai');
    }
  }

  /**
   * F2 "partner organization" block: separate collaboration contact who must acknowledge in the portal
   * when their email is not the same as the executing-organization official contact.
   */
  private shouldRequirePartnerOrganizationAck(
    dto: CreateOpportunityDto,
  ): boolean {
    const po = dto.partner_organization as
      | { official_email?: string }
      | undefined;
    const raw =
      po && typeof po.official_email === 'string'
        ? po.official_email
        : undefined;
    const pe = this.normalizeEmail(raw);
    if (!pe || !this.isValidEmail(pe)) return false;
    const exec = dto.executing_organization as
      | { official_email?: string }
      | undefined;
    const ee =
      exec && typeof exec.official_email === 'string'
        ? this.normalizeEmail(exec.official_email)
        : null;
    if (!ee) return true;
    return pe !== ee;
  }

  /** Whether partner approval + email flow applies for this student submission. */
  private studentOpportunityRequiresPartner(
    dto: CreateOpportunityDto,
  ): boolean {
    const typePartner = dto.executing_context?.type === 'partner';
    const collab = dto.external_partner_collaboration;
    const hasCollab =
      collab !== null &&
      collab !== undefined &&
      typeof collab === 'object' &&
      Object.keys(collab as object).length > 0;
    const sup = dto.supervision as
      | { external_partner_email?: string; partner_email?: string }
      | undefined;
    const hasSupPartnerLead = !!(
      sup?.external_partner_email || sup?.partner_email
    );
    return (
      typePartner ||
      hasCollab ||
      hasSupPartnerLead ||
      this.shouldRequirePartnerOrganizationAck(dto)
    );
  }

  /** Same rule as {@link createStudentOpportunity} — used when student edits/resubmits after rejection. */
  studentCreatedPayloadRequiresPartner(dto: CreateOpportunityDto): boolean {
    return this.studentOpportunityRequiresPartner(dto);
  }

  /**
   * After student resubmit saved the row in `pending_partner` (faculty already cleared): send partner verify email.
   */
  async notifyPartnerForStudentOpportunityPartnerQueue(
    opportunity: Opportunity,
  ): Promise<void> {
    await this.sendPartnerApprovalEmail(opportunity);
  }

  /**
   * Bind `facultyId` to the registered FACULTY user whose email matches supervision.contact.
   * If no account exists yet, clears facultyId so signup reconciliation can link later.
   */
  private async syncOpportunityFacultyIdToSupervisionEmail(
    opp: Opportunity,
  ): Promise<string | null> {
    const email = this.getFacultyEmailFromOpportunity(opp);
    if (!email) {
      opp.facultyId = null;
      return null;
    }

    const facultyUser = await this.usersRepository
      .createQueryBuilder('u')
      .where('LOWER(TRIM(u.email)) = :em', { em: email })
      .andWhere('u.role = :role', { role: UserRole.FACULTY })
      .getOne();

    opp.facultyId = facultyUser?.id ?? null;
    return facultyUser?.id ?? null;
  }

  /**
   * Liaison/partner links do not log the faculty in; set facultyId from supervision.contact first,
   * then partner_organization.official_email if needed, so approvals/history bind to the faculty account.
   */
  private async assignFacultyIdFromSupervisionIfMissing(
    opp: Opportunity,
  ): Promise<void> {
    if (opp.facultyId) return;

    const tryBindFacultyByEmail = async (raw: string): Promise<boolean> => {
      const em = this.normalizeEmail(raw);
      if (!em) return false;
      const user = await this.usersRepository
        .createQueryBuilder('u')
        .where('LOWER(TRIM(u.email)) = :em', { em })
        .andWhere('u.role = :role', { role: UserRole.FACULTY })
        .getOne();
      if (user) {
        opp.facultyId = user.id;
        return true;
      }
      return false;
    };

    const sup = opp.supervision;
    if (sup && typeof sup === 'object') {
      const o = sup as Record<string, unknown>;
      const rawSup =
        (typeof o.contact === 'string' && o.contact) ||
        (typeof o.official_email === 'string' && o.official_email) ||
        '';
      if (await tryBindFacultyByEmail(rawSup)) return;
    }

    const po = opp.partner_organization as Record<string, unknown> | undefined;
    const rawPo =
      po && typeof po.official_email === 'string' ? po.official_email : '';
    await tryBindFacultyByEmail(rawPo);
  }

  /** Faculty contact email, read generically off whichever field the creator's form used:
   * `supervision.contact`/`official_email` (student/faculty flows) or
   * `visibility_and_academic_linkage.faculty_institutional_representative.official_email`
   * (the NGO/Partner Organization form's optional "Academic / faculty link" section). Works on
   * either a `CreateOpportunityDto` (at create time) or a saved `Opportunity` entity — same JSON
   * shape either way. */
  private resolveFacultyEmail(dto: {
    supervision?: unknown;
    visibility_and_academic_linkage?: unknown;
  }): string | null {
    const sup = dto.supervision as Record<string, unknown> | undefined;
    const val =
      dto.visibility_and_academic_linkage &&
      typeof dto.visibility_and_academic_linkage === 'object'
        ? (dto.visibility_and_academic_linkage as Record<string, unknown>)
        : undefined;
    const fir =
      val?.faculty_institutional_representative &&
      typeof val.faculty_institutional_representative === 'object'
        ? (val.faculty_institutional_representative as Record<
            string,
            unknown
          >)
        : undefined;
    // Partner / NGO / University forms mirror the EXECUTING ORGANIZATION's official contact into
    // supervision.contact (role "Executing organization — official contact"). That person is not a
    // faculty supervisor: treating them as one routed every org-created opportunity to
    // "pending faculty" and sent the faculty email to the organization's own contact, making
    // faculty linkage mandatory and never reaching a real linked faculty. Only the optional
    // faculty representative counts for those.
    const supRole =
      sup && typeof sup.role === 'string' ? sup.role.trim().toLowerCase() : '';
    const supIsExecutingOrgContact = supRole.startsWith('executing organization');
    const raw =
      (!supIsExecutingOrgContact &&
        sup &&
        typeof sup.contact === 'string' &&
        sup.contact) ||
      (!supIsExecutingOrgContact &&
        sup &&
        typeof sup.official_email === 'string' &&
        sup.official_email) ||
      (fir && typeof fir.official_email === 'string' && fir.official_email) ||
      '';
    const em = this.normalizeEmail(raw);
    return em && this.isValidEmail(em) ? em : null;
  }

  /** Fields whose change on an already-LIVE listing must send it back through review
   * (who may apply, where/how it runs, which SDG, and every stakeholder contact). */
  private liveMaterialSignature(opp: Opportunity): string {
    const loc = (opp.location ?? {}) as Record<string, unknown>;
    return JSON.stringify([
      opp.participation_scope ?? null,
      opp.restricted_universities ?? null,
      opp.mode ?? null,
      loc.pin ?? loc.city ?? null,
      (opp.sdg_info as { sdg_id?: unknown } | null)?.sdg_id ?? null,
      this.resolvePartnerEmailFromOpportunity(opp),
      this.getFacultyEmailFromOpportunity(opp),
      (opp.executing_organization as { official_email?: unknown } | null)
        ?.official_email ?? null,
    ]);
  }

  private getFacultyEmailFromOpportunity(opp: Opportunity): string | null {
    return this.resolveFacultyEmail(opp);
  }

  /** Snapshot before student PATCH — used to detect faculty/partner assignment changes on resubmit. */
  snapshotStudentOpportunityResubmit(opp: Opportunity): {
    facultyEmail: string | null;
    partnerEmail: string | null;
    requiresPartner: boolean;
  } {
    return {
      facultyEmail: this.getFacultyEmailFromOpportunity(opp),
      partnerEmail: this.resolvePartnerEmailFromOpportunity(opp),
      requiresPartner: this.studentCreatedPayloadRequiresPartner(
        opp as unknown as CreateOpportunityDto,
      ),
    };
  }

  /**
   * After a student saves edits while `workflowStage === revision`, rewind the correct queue and
   * invalidate stale approvals when faculty/partner assignments changed.
   */
  async applyStudentCreatedOpportunityResubmit(
    opp: Opportunity,
    before: {
      facultyEmail: string | null;
      partnerEmail: string | null;
      requiresPartner: boolean;
    },
  ): Promise<{ notifyFaculty: boolean; notifyPartner: boolean }> {
    const dto = opp as unknown as CreateOpportunityDto;
    const requiresPartnerNow = this.studentCreatedPayloadRequiresPartner(dto);
    opp.requiresPartnerApproval = requiresPartnerNow;

    const facultyEmailNow = this.getFacultyEmailFromOpportunity(opp);
    const partnerEmailNow = this.resolvePartnerEmailFromOpportunity(opp);
    const facultyEmailChanged =
      this.normalizeEmail(before.facultyEmail || '') !==
      this.normalizeEmail(facultyEmailNow || '');
    const partnerEmailChanged =
      this.normalizeEmail(before.partnerEmail || '') !==
      this.normalizeEmail(partnerEmailNow || '');
    const requiresPartnerChanged =
      before.requiresPartner !== requiresPartnerNow;
    const partnerNowRequired = requiresPartnerNow && !!partnerEmailNow;

    if (partnerNowRequired && !partnerEmailNow) {
      throw new BadRequestException(
        'Partner approval is required for this submission but no valid partner email was found.',
      );
    }

    const facultyLineNeedsReview =
      facultyEmailChanged ||
      opp.facultyApprovalStatus === LINE_STATUS.REJECTED ||
      opp.facultyApprovalStatus === LINE_STATUS.REVISION_REQUESTED ||
      opp.faculty_verification_status === 'rejected' ||
      !opp.faculty_verified ||
      opp.facultyApprovalStatus === LINE_STATUS.PENDING ||
      opp.faculty_verification_status === WORKFLOW_STAGE.PENDING_FACULTY;

    if (facultyLineNeedsReview) {
      opp.workflowStage = WORKFLOW_STAGE.PENDING_FACULTY;
      opp.status = WORKFLOW_STAGE.PENDING_FACULTY;
      opp.facultyApprovalStatus = LINE_STATUS.PENDING;
      opp.faculty_verification_status = WORKFLOW_STAGE.PENDING_FACULTY;
      opp.faculty_verified = false;
      opp.faculty_verification_token = randomUUID();
      if (facultyEmailChanged) {
        opp.facultyId = null;
        await this.assignFacultyIdFromSupervisionIfMissing(opp);
      }
      opp.partnerApprovalStatus = partnerNowRequired
        ? LINE_STATUS.PENDING
        : LINE_STATUS.NOT_APPLICABLE;
      opp.partnerVerified = !partnerNowRequired;
      opp.adminApprovalStatus = LINE_STATUS.PENDING;
      opp.admin_approved = false;
      return { notifyFaculty: true, notifyPartner: false };
    }

    const partnerLineNeedsReview =
      partnerNowRequired &&
      (requiresPartnerChanged ||
        partnerEmailChanged ||
        opp.partnerApprovalStatus === LINE_STATUS.REJECTED ||
        opp.partnerApprovalStatus === LINE_STATUS.REVISION_REQUESTED ||
        !opp.partnerVerified ||
        opp.partnerApprovalStatus !== LINE_STATUS.APPROVED);

    if (partnerLineNeedsReview) {
      opp.workflowStage = WORKFLOW_STAGE.PENDING_PARTNER;
      opp.status = WORKFLOW_STAGE.PENDING_PARTNER;
      opp.partnerApprovalStatus = LINE_STATUS.PENDING;
      opp.partnerVerified = false;
      // Fresh link per re-review round; the previous one stops resolving.
      opp.partnerToken = randomUUID();
      opp.adminApprovalStatus = LINE_STATUS.PENDING;
      opp.admin_approved = false;
      return { notifyFaculty: false, notifyPartner: true };
    }

    opp.workflowStage = WORKFLOW_STAGE.PENDING_ADMIN;
    opp.status = 'pending_approval';
    opp.adminApprovalStatus = LINE_STATUS.PENDING;
    opp.admin_approved = false;
    return { notifyFaculty: false, notifyPartner: false };
  }

  /**
   * Creator-triggered resend of the email the current reviewer should already have received.
   * Does not move the approval stage. Faculty and partner only — CIEL PK has no magic-link inbox here.
   */
  async remindOpportunityReviewer(userId: string, opportunityId: string) {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) throw new ForbiddenException('User not found');
    const opp = await this.opportunitiesRepository.findOne({
      where: { id: opportunityId },
    });
    if (!opp) throw new NotFoundException('Opportunity not found');
    const isOwner = opp.creatorId === userId;
    const isAdmin = user.role === UserRole.SUPER_ADMIN;
    const callerEmail = this.normalizeEmail(user.email);
    const isNamedFaculty =
      !!callerEmail &&
      this.collectFacultyReviewerEmails(opp).includes(callerEmail);
    const isNamedPartner =
      !!callerEmail &&
      this.collectPartnerContactEmails(opp).includes(callerEmail);
    const isUniversity = user.role === UserRole.UNIVERSITY;
    if (!isOwner && !isAdmin && !isNamedFaculty && !isNamedPartner) {
      if (!isUniversity) {
        throw new ForbiddenException('You do not have access to this opportunity');
      }
      const creator = await this.getOpportunityCreatorContact(opp);
      const userUni = String(user.university || user.institution || '')
        .trim()
        .toLowerCase();
      const creatorUni = String(creator?.university || creator?.institution || '')
        .trim()
        .toLowerCase();
      if (!userUni || !creatorUni || userUni !== creatorUni) {
        throw new ForbiddenException(
          'University reminders are limited to opportunities from your institution.',
        );
      }
    }

    const reminderCopy = buildApprovalReminderCopy(opp, this.frontendOrigin());
    const tracker = buildOpportunityApprovalTracker(opp);

    if (this.isAwaitingFacultyDashboardReview(opp)) {
      if (!opp.faculty_verification_token) {
        opp.faculty_verification_token = randomUUID();
        await this.opportunitiesRepository.save(opp);
      }
      const facultyTo = this.getFacultyEmailFromOpportunity(opp);
      if (!facultyTo) {
        throw new BadRequestException(
          'No faculty email is saved on this opportunity.',
        );
      }
      const sent = await this.notifyFacultyForStudentOpportunityVerification(opp);
      if (!sent) {
        throw new BadRequestException(
          `The email could not be sent to ${facultyTo}. The mail server rejected it.`,
        );
      }
      return {
        success: true,
        sent_to: 'faculty',
        message: `Verification email sent to ${facultyTo}.`,
        ...tracker,
        reminder: reminderCopy,
      };
    }

    const awaitingPartner =
      !!opp.requiresPartnerApproval &&
      !opp.partnerVerified &&
      opp.partnerApprovalStatus !== LINE_STATUS.APPROVED &&
      (opp.workflowStage === WORKFLOW_STAGE.PENDING_PARTNER ||
        opp.status === 'pending_partner');
    if (awaitingPartner) {
      if (!opp.partnerToken) {
        opp.partnerToken = randomUUID();
        await this.opportunitiesRepository.save(opp);
      }
      const partnerTo = this.resolvePartnerEmailFromOpportunity(opp);
      if (!partnerTo) {
        throw new BadRequestException(
          'No partner email is saved on this opportunity.',
        );
      }
      const sent = await this.sendPartnerApprovalEmail(opp);
      if (!sent) {
        throw new BadRequestException(
          `The email could not be sent to ${partnerTo}. The mail server rejected it.`,
        );
      }
      return {
        success: true,
        sent_to: 'partner',
        partner_email: partnerTo,
        message: `Verification email sent to ${partnerTo}. Check Inbox and Spam.`,
        ...tracker,
        reminder: reminderCopy,
      };
    }

    const awaitingAdmin =
      opp.workflowStage === WORKFLOW_STAGE.PENDING_ADMIN ||
      opp.status === 'pending_approval';
    if (awaitingAdmin) {
      await this.sendAdminReviewEmail(opp, 'CIEL PK final approval');
      return {
        success: true,
        sent_to: 'admin',
        message: 'CIEL PK has been reminded that this opportunity is ready for final approval.',
        ...tracker,
        reminder: reminderCopy,
      };
    }

    throw new BadRequestException(
      'This opportunity is not waiting on a faculty, partner, or CIEL PK review.',
    );
  }

  /** Faculty verification email after student resubmit reaches `pending_faculty`. */
  async notifyFacultyForStudentOpportunityVerification(
    opportunity: Opportunity,
  ): Promise<boolean> {
    const facultyTo = this.getFacultyEmailFromOpportunity(opportunity);
    if (!facultyTo || !opportunity.faculty_verification_token) return false;

    const creator = await this.getOpportunityCreatorContact(opportunity);
    const studentVerifyDetails = this.buildOpportunityVerificationEmailDetails(
      opportunity,
      {
        studentName: creator
          ? resolveDisplayNameForProfile(creator)
          : undefined,
        studentUniversity:
          creator?.university || creator?.institution || undefined,
      },
    );

    try {
      await this.mailService.sendFacultyStudentOpportunityVerification(
        facultyTo,
        opportunity.title,
        opportunity.faculty_verification_token,
        studentVerifyDetails,
        {
          path: '/verify/faculty',
          returnTo: this.getFacultyApprovalReturnTo(opportunity.id),
        },
      );
      return true;
    } catch (e) {
      console.warn(
        'Failed to send faculty verification email on resubmit',
        (e as Error).message,
      );
      return false;
    }
  }

  /**
   * One new organization row per student opportunity when there is no named partner org.
   * Same student creating many opportunities → many placeholder orgs (no shared dummy).
   */
  private async createPlaceholderOrganizationForStudentOpportunity(
    opportunityTitle: string,
  ): Promise<string> {
    const t = (opportunityTitle || 'Untitled').trim().slice(0, 72);
    const tag = randomUUID().slice(0, 8);
    const name = `Student opportunity — ${t} — ${tag}`;
    const row = this.organizationsRepository.create({
      name,
      orgType: 'OTHER',
      verificationStatus: 'unclaimed_student_initiated',
      country: 'Pakistan',
      countryCode: 'PK',
      description:
        'Auto-created placeholder for a student-submitted opportunity (not a partner site).',
    });
    const saved = await this.organizationsRepository.save(row);
    return saved.id;
  }

  private normalizeSafetyDeclaration(safety?: any) {
    if (!safety) return safety;
    return {
      environment_safe_and_appropriate:
        safety.environment_safe_and_appropriate ??
        safety.site_safe_and_suitable,
      students_guided_and_supervised:
        safety.students_guided_and_supervised ??
        safety.students_properly_supervised,
      lawful_ethical_and_non_hazardous:
        safety.lawful_ethical_and_non_hazardous ??
        safety.lawful_and_free_from_hazards,
      precautions_and_basic_safety:
        safety.precautions_and_basic_safety ??
        safety.basic_safety_and_emergency_measures,
    };
  }

  private validateSafetyDeclaration(safety?: any) {
    if (!safety)
      throw new BadRequestException('safety_declaration is required');
    const normalized = this.normalizeSafetyDeclaration(safety);
    const keys = [
      'environment_safe_and_appropriate',
      'students_guided_and_supervised',
      'lawful_ethical_and_non_hazardous',
      'precautions_and_basic_safety',
    ];
    const allTrue = keys.every((k) => normalized[k] === true);
    if (!allTrue) {
      throw new BadRequestException(
        'All safety_declaration checks must be true',
      );
    }
  }

  private resolveSafetyDeclarationPayload(dto: {
    safety_declaration?: any;
    safety_supervision_declaration?: any;
  }) {
    return dto.safety_declaration ?? dto.safety_supervision_declaration;
  }

  private validateSubmissionConfirmations(confirm?: any) {
    if (!confirm)
      throw new BadRequestException('submission_confirmations are required');
    const normalized = {
      academically_valid_and_accurately_described:
        confirm.academically_valid_and_accurately_described ??
        confirm.genuine_and_accurate,
      activity_properly_supervised:
        confirm.activity_properly_supervised ??
        confirm.organization_responsible_for_execution,
      environment_safe_and_appropriate:
        confirm.environment_safe_and_appropriate,
      information_correct_and_verifiable:
        confirm.information_correct_and_verifiable,
    };
    const keys = [
      'academically_valid_and_accurately_described',
      'activity_properly_supervised',
      'environment_safe_and_appropriate',
      'information_correct_and_verifiable',
    ];
    if (!keys.every((k) => normalized[k] === true)) {
      throw new BadRequestException(
        'All submission_confirmations must be true',
      );
    }
  }

  private validateParticipationScope(scope?: any) {
    if (!scope) return; // backward compatibility
    const rule = scope.rule;
    if (!rule)
      throw new BadRequestException('participation_scope.rule is required');
    const uniNames: string[] = scope.university_names || [];
    const creatorUni = scope.creator_university_name || '';
    const deptScope = scope.department_restriction?.scope || 'all';
    const departments: string[] =
      scope.department_restriction?.departments || [];

    const needDepts =
      [
        'departments_across_universities',
        'own_university_departments',
      ].includes(rule) || deptScope === 'specific';
    if (needDepts && (!departments || departments.length === 0)) {
      throw new BadRequestException(
        'Department list required for department-specific participation_scope',
      );
    }

    const needUniList = [
      'restricted_specific_universities',
      'departments_across_universities',
    ].includes(rule);
    if (needUniList && uniNames.length === 0) {
      throw new BadRequestException(
        'University list required for participation_scope.rule',
      );
    }

    if (rule === 'open_all_universities') {
      return;
    }
    if (rule === 'own_university_only' && creatorUni && uniNames.length === 0) {
      scope.university_names = [creatorUni];
    }
    if (
      rule === 'own_university_departments' &&
      creatorUni &&
      uniNames.length === 0
    ) {
      scope.university_names = [creatorUni];
    }
  }

  /** Contact emails on the org blocks drive verification mails — reject malformed ones up front
   * (and never let a raw API call skip the form's own check). */
  private validateOrganizationContacts(dto: {
    executing_organization?: any;
    partner_organization?: any;
  }) {
    for (const [key, block] of [
      ['executing_organization', dto.executing_organization],
      ['partner_organization', dto.partner_organization],
    ] as const) {
      const email = block?.official_email;
      if (email == null || email === '') continue;
      if (typeof email !== 'string' || email.length > 254 || !this.isValidEmail(email.trim())) {
        throw new BadRequestException(`${key}.official_email must be a valid email`);
      }
    }
  }

  private validateSupervision(supervision: any) {
    if (!supervision) return;
    if (
      supervision.whatsapp_e164 &&
      !/^\+[1-9]\d{7,14}$/.test(String(supervision.whatsapp_e164).trim())
    ) {
      throw new BadRequestException(
        'supervision.whatsapp_e164 must be in international format, e.g. +923001234567',
      );
    }
    if (supervision.contact && !this.isValidEmail(supervision.contact)) {
      throw new BadRequestException(
        'supervision.contact must be a valid email',
      );
    }
    if (
      supervision.external_partner_email &&
      !this.isValidEmail(supervision.external_partner_email)
    ) {
      throw new BadRequestException(
        'supervision.external_partner_email must be a valid email',
      );
    }
    if (
      supervision.partner_email &&
      !this.isValidEmail(supervision.partner_email)
    ) {
      throw new BadRequestException(
        'supervision.partner_email must be a valid email',
      );
    }
    if (supervision.faculty_department === '')
      throw new BadRequestException('faculty_department is required');
    if (supervision.faculty_university_name === '')
      throw new BadRequestException('faculty_university_name is required');

    for (const key of [
      'whatsapp_e164',
      'partner_whatsapp_e164',
      'faculty_whatsapp',
      'partner_phone',
    ] as const) {
      const raw = supervision[key];
      if (typeof raw !== 'string' || !raw.trim()) continue;
      const parsed = canonicalizePhoneInput(raw, { required: false });
      if (parsed.error) throw new BadRequestException(parsed.error);
      supervision[key] = parsed.e164;
    }
  }

  /** A non-remote opportunity needs a real map pin, not just a picked city — otherwise it can
   * "float" with no accurate location while still passing every other check. The frontend's own
   * form validation should already require this; this is the same rule enforced server-side so a
   * raw API call (or a form bug) can't bypass it. */
  validateLocation(mode?: string, location?: any) {
    if (mode === 'Remote') return;
    const pin = typeof location?.pin === 'string' ? location.pin.trim() : '';
    if (!pin) {
      throw new BadRequestException(
        'location.pin is required for a non-Remote opportunity — pin the exact location on the map.',
      );
    }
  }

  /** Project start/end required; application deadline only when early close is enabled. */
  validateTimeline(timeline: unknown, opts?: { requireDates?: boolean }) {
    const err = validateTimelineForPersist(timeline, opts);
    if (err) throw new BadRequestException(err);
  }

  /**
   * Create-time validators, applied to whichever of these keys an edit touches (email formats,
   * phone canonicalisation, all-true safety/confirmation checks, scope shape). Shared by
   * `update()` and the student edit route so neither can persist what create would reject.
   */
  validateEditPatch(patch: Record<string, any>) {
    this.validateNestedContactEmails(patch);
    if (patch.supervision) this.validateSupervision(patch.supervision);
    if (patch.external_partner_collaboration) {
      this.validateExternalPartner(patch.external_partner_collaboration);
    }
    if (patch.participation_scope) {
      this.validateParticipationScope(patch.participation_scope);
    }
    if (patch.safety_declaration || patch.safety_supervision_declaration) {
      this.validateSafetyDeclaration(
        this.resolveSafetyDeclarationPayload({
          safety_declaration: patch.safety_declaration,
          safety_supervision_declaration: patch.safety_supervision_declaration,
        }),
      );
    }
    if (patch.submission_confirmations) {
      this.validateSubmissionConfirmations(patch.submission_confirmations);
    }
  }

  /**
   * Free-text hygiene + size bounds for EVERY creator type (not just students): control characters
   * stripped, title whitespace collapsed, and the long free-text fields capped so an unbounded
   * jsonb value can't be written through the API.
   */
  private sanitizeAndBoundContent(dto: {
    title?: string;
    objectives?: unknown;
    activity_details?: unknown;
  }) {
    purifyStudentOpportunityContent(dto);
    const objectives = dto.objectives as { description?: unknown } | undefined;
    const activity = dto.activity_details as
      | { student_responsibilities?: unknown }
      | undefined;
    const tooLong = (value: unknown, max: number) =>
      typeof value === 'string' && value.length > max;
    if (tooLong(objectives?.description, OPPORTUNITY_LONG_TEXT_MAX)) {
      throw new BadRequestException(
        `objectives.description is too long (max ${OPPORTUNITY_LONG_TEXT_MAX} characters).`,
      );
    }
    if (tooLong(activity?.student_responsibilities, STUDENT_RESPONSIBILITIES_MAX_LENGTH)) {
      throw new BadRequestException(
        `activity_details.student_responsibilities is too long (max ${STUDENT_RESPONSIBILITIES_MAX_LENGTH} characters).`,
      );
    }
  }

  /**
   * Faculty / admin / org creators: block re-submitting the same project title twice (a double
   * click, a retry after a slow response, or a copy-paste). Exact normalised-title match against
   * this creator's own live-or-pending listings only — drafts, rejected and closed ones don't count.
   */
  private async assertNoOwnDuplicateTitle(userId: string, title?: string) {
    const target = normalizeOpportunityTitleForMatch(title || '');
    if (target.length < 6) return;
    const dead = ['rejected', 'cancelled', 'archived', 'closed', 'draft'];
    const mine = await this.opportunitiesRepository.find({
      where: { creatorId: userId },
      select: ['id', 'title', 'status', 'workflowStage'],
      order: { createdAt: 'DESC' },
      take: 200,
    });
    const dup = (mine ?? []).find(
      (o) =>
        !dead.includes(String(o.status || '').toLowerCase()) &&
        o.workflowStage !== WORKFLOW_STAGE.REJECTED &&
        normalizeOpportunityTitleForMatch(o.title || '') === target,
    );
    if (dup) {
      throw new ConflictException({
        message: `You already have an opportunity titled "${dup.title}". Open it from your list instead of creating a duplicate.`,
        code: 'DUPLICATE_OPPORTUNITY_TITLE',
        existingOpportunityId: dup.id,
      });
    }
  }

  /** Contact emails nested in free-form JSON blobs (not covered by the DTO): when present they
   * must be real emails, otherwise routing/mail silently fails and the listing is orphaned. */
  private validateNestedContactEmails(src: {
    executing_organization?: any;
    partner_organization?: any;
    visibility_and_academic_linkage?: any;
  }) {
    const checks: Array<[string, unknown]> = [
      ['executing_organization.official_email', src.executing_organization?.official_email],
      ['partner_organization.official_email', src.partner_organization?.official_email],
      [
        'faculty_institutional_representative.official_email',
        src.visibility_and_academic_linkage?.faculty_institutional_representative?.official_email,
      ],
    ];
    for (const [label, value] of checks) {
      if (typeof value !== 'string' || !value.trim()) continue;
      if (!this.isValidEmail(value.trim())) {
        throw new BadRequestException(`${label} must be a valid email`);
      }
    }
  }

  private validateExternalPartner(collab?: any) {
    if (!collab) return;
    const { organization_name, contact_person, official_email } = collab;
    if (!organization_name || !contact_person || !official_email) {
      throw new BadRequestException(
        'external_partner_collaboration requires organization_name, contact_person, official_email',
      );
    }
    if (!this.isValidEmail(official_email)) {
      throw new BadRequestException(
        'external_partner_collaboration.official_email must be valid',
      );
    }
  }

  private ensureProfileComplete(user: User) {
    const { profile_complete, profile_missing_fields } =
      getProfileCompletionStatus(user);
    if (!profile_complete) {
      throw new ForbiddenException(
        `Profile incomplete: missing ${profile_missing_fields.join(', ')}`,
      );
    }
  }

  async getOccupiedSeats(opportunityId: string): Promise<number> {
    return await this.participationRepository.count({
      where: {
        projectId: opportunityId,
        status: In([
          'pending',
          'accepted',
          'approved',
          'verified',
          'paid',
          'pending_payment_approval',
          'pending_ciel_approval',
          'pending_faculty_approval',
        ]),
      },
    });
  }

  async getFacultyOrgFallback(facultyId?: string | null) {
    if (!facultyId) return null;
    const faculty = await this.usersRepository.findOne({
      where: { id: facultyId },
    });
    if (!faculty) return null;
    return {
      id: null,
      name: faculty.institution || faculty.university || faculty.name,
      logo_url: null,
    };
  }

  private readonly publicLiveStatuses = [
    'active',
    'live',
    'open',
    'recruiting',
  ];

  private normalizeOpportunityStatus(status?: string | null): string | null {
    const normalized = (status || '').trim().toLowerCase();
    if (!normalized) return null;
    if (this.publicLiveStatuses.includes(normalized)) return 'active';
    if (['completed', 'complete', 'verified', 'finalized'].includes(normalized))
      return 'completed';
    if (
      [
        'closed',
        'inactive',
        'draft',
        'rejected',
        'cancelled',
        'canceled',
      ].includes(normalized)
    ) {
      return 'closed';
    }
    return normalized;
  }

  private buildOpportunityOrganization(
    opp: Opportunity,
    orgFallback?: {
      id: string | null;
      name: string | null;
      logo_url: string | null;
    } | null,
  ) {
    if (opp.organization) {
      return {
        id: opp.organization.id,
        name: opp.organization.name,
        logo_url: opp.organization.logoUrl,
      };
    }
    return orgFallback || null;
  }

  private buildPublicOpportunityPayload(
    opp: Opportunity,
    occupiedSeats: number,
    orgFallback?: {
      id: string | null;
      name: string | null;
      logo_url: string | null;
    } | null,
    detail = false,
  ) {
    const volunteersRequired = opp.timeline?.volunteers_required || 0;
    const organization = this.buildOpportunityOrganization(opp, orgFallback);
    const organizationName =
      organization?.name ||
      opp.partner_organization?.organization_name ||
      opp.executing_organization?.name ||
      (opp.supervision &&
      typeof opp.supervision === 'object' &&
      typeof (opp.supervision as { faculty_university_name?: unknown })
        .faculty_university_name === 'string'
        ? (opp.supervision as { faculty_university_name: string })
            .faculty_university_name
        : null) ||
      null;

    const remainingSeats = Math.max(0, volunteersRequired - occupiedSeats);
    const listing = buildStudentBrowseListingFields(opp, {
      remaining_seats: remainingSeats,
      organization_name: organizationName || 'Unknown',
    });

    const base = {
      id: opp.id,
      title: opp.title,
      createdAt: opp.createdAt,
      created_at: opp.createdAt,
      description: opp.objectives?.description || '',
      status: this.getApiOpportunityStatus(opp),
      mode: opp.mode,
      types: opp.types,
      sdg: opp.sdg_info?.sdg_id || opp.sdg || null,
      sdg_info: opp.sdg_info,
      secondary_sdgs: Array.isArray(opp.secondary_sdgs)
        ? opp.secondary_sdgs
        : [],
      organization_name: organizationName,
      organization,
      participant_count: occupiedSeats,
      remaining_seats: remainingSeats,
      volunteersNeeded: volunteersRequired,
      location: opp.location,
      timeline: opp.timeline,
      from_time: opp.timeline?.from_time,
      to_time: opp.timeline?.to_time,
      ...this.getWorkflowResponseFields(opp),
      ...listing,
      created_by_role: classifyBrowseCreator(opp),
      faculty_verified: opp.faculty_verified === true,
      execution_verified: opp.execution_verified === true,
      admin_approved: opp.admin_approved === true,
      ...this.getDirectoryControlFields(opp),
    };

    if (!detail) {
      return {
        ...base,
        participation_scope: opp.participation_scope,
        executing_context: opp.executing_context,
        executing_organization: opp.executing_organization,
        partner_organization: opp.partner_organization,
        safety_supervision_declaration: opp.safety_supervision_declaration,
        safety_declaration: opp.safety_declaration,
        visibility_and_academic_linkage: opp.visibility_and_academic_linkage,
        submission_confirmations: opp.submission_confirmations,
        external_partner_collaboration: opp.external_partner_collaboration,
        academic_linkage: opp.academic_linkage,
      };
    }

    return {
      ...base,
      objectives: opp.objectives,
      activity_details: opp.activity_details,
      supervision: opp.supervision,
      verification_method: opp.verification_method,
      participation_scope: opp.participation_scope,
      executing_context: opp.executing_context,
      executing_organization: opp.executing_organization,
      partner_organization: opp.partner_organization,
      safety_supervision_declaration: opp.safety_supervision_declaration,
      safety_declaration: opp.safety_declaration,
      visibility_and_academic_linkage: opp.visibility_and_academic_linkage,
      submission_confirmations: opp.submission_confirmations,
      external_partner_collaboration: opp.external_partner_collaboration,
      academic_linkage: opp.academic_linkage,
      detail_view: buildOpportunityDetailView(opp),
    };
  }

  private getApiOpportunityStatus(opp: Opportunity): string | null {
    // Keep unfinished creator drafts out of the closed/rejected bucket. normalizeOpportunityStatus
    // maps the raw word "draft" to "closed", which hid them from every Drafts tab.
    if (String(opp.status || '').toLowerCase() === 'draft') return 'draft';
    if (opp.workflowStage === WORKFLOW_STAGE.LIVE && opp.admin_approved)
      return 'live';
    if (
      opp.workflowStage === WORKFLOW_STAGE.PENDING_FACULTY ||
      opp.workflowStage === WORKFLOW_STAGE.PENDING_PARTNER ||
      opp.workflowStage === WORKFLOW_STAGE.PENDING_ADMIN ||
      (opp.workflowStage === WORKFLOW_STAGE.LIVE && !opp.admin_approved)
    ) {
      return 'pending_verification';
    }
    if (opp.workflowStage === WORKFLOW_STAGE.REJECTED) return 'rejected';
    if (opp.workflowStage === WORKFLOW_STAGE.REVISION) return 'revision';
    const normalized = this.normalizeOpportunityStatus(opp.status);
    // Never surface `live` for rows that are not CIEL-admin approved. Legacy rows can still have
    // `status = active` while `admin_approved` is false; those must stay in review, not "live".
    if (normalized === 'active' && opp.admin_approved) return 'live';
    return normalized;
  }

  private getWorkflowResponseFields(opp: Opportunity) {
    const tracker = buildOpportunityApprovalTracker(opp);
    return {
      workflow_stage: opp.workflowStage ?? null,
      faculty_approval_status: opp.facultyApprovalStatus ?? null,
      partner_approval_status: opp.partnerApprovalStatus ?? null,
      admin_approval_status: opp.adminApprovalStatus ?? null,
      public_code: tracker.public_code,
      linked_draft: tracker.linked_draft,
      currently_with: tracker.currently_with,
      currently_with_role: tracker.currently_with_role,
      next_step: tracker.next_step,
      waiting_since: tracker.waiting_since,
      approval_route: tracker.route,
      approval_checklist: tracker.checklist,
    };
  }

  private frontendOrigin(): string {
    return (
      process.env.FRONTEND_URL ||
      process.env.APP_URL ||
      ''
    ).replace(/\/+$/, '');
  }

  /** Whether CIEL admin final-approve may run without skipping required gates. */
  private isOpportunityReadyForAdminFinalApprove(opp: Opportunity): boolean {
    if (String(opp.status || '').toLowerCase() === 'draft') return false;
    // A rejected row or one CIEL PK sent back for revision is not in the approval queue: it must
    // be edited and resubmitted by its creator first (student-created rows already enforced this
    // through the stage check below; org / faculty rows used to be approvable straight from
    // `rejected` / `revision`, skipping the creator's fix and any reviewer that rejected it).
    if (
      opp.workflowStage === WORKFLOW_STAGE.REJECTED ||
      opp.workflowStage === WORKFLOW_STAGE.REVISION ||
      ['rejected', 'revision'].includes(String(opp.status || '').toLowerCase())
    ) {
      return false;
    }
    // Executing-org portal confirm must always finish before CIEL final approve —
    // never trust a client-supplied `admin_approval_required` to skip this gate.
    if (opp.execution_verification_token && !opp.execution_verified) {
      return false;
    }
    if (opp.isStudentCreated) {
      if (opp.workflowStage === WORKFLOW_STAGE.PENDING_ADMIN) return true;
      if (!opp.workflowStage && opp.status === 'pending_approval') return true;
      return false;
    }
    // An NGO/Partner Organization creator's optionally-linked faculty gate — same rule as the
    // partner check just below: admin can't finalize while that line is still open.
    if (
      opp.facultyApprovalStatus &&
      opp.facultyApprovalStatus !== LINE_STATUS.APPROVED &&
      opp.facultyApprovalStatus !== LINE_STATUS.NOT_APPLICABLE
    ) {
      return false;
    }
    if (opp.requiresPartnerApproval && !opp.partnerVerified) return false;
    if (opp.status === 'pending_partner') return false;
    if (opp.workflowStage === WORKFLOW_STAGE.PENDING_PARTNER) return false;
    if (opp.status === 'pending_faculty') return false;
    if (opp.workflowStage === WORKFLOW_STAGE.PENDING_FACULTY) return false;
    if (opp.status === 'pending_execution') return false;
    return true;
  }

  /** Short label for the admin approvals queue (student pipeline + final step). */
  private describeAdminQueueFlow(opp: Opportunity): {
    flow_status: string;
    admin_can_approve: boolean;
  } {
    const admin_can_approve = this.isOpportunityReadyForAdminFinalApprove(opp);
    const st = opp.status;
    if (opp.isStudentCreated) {
      const ws = opp.workflowStage;
      if (
        ws === WORKFLOW_STAGE.PENDING_FACULTY ||
        st === 'pending_faculty' ||
        st === 'pending_verification'
      ) {
        return {
          flow_status: 'Awaiting faculty / liaison',
          admin_can_approve: false,
        };
      }
      if (ws === WORKFLOW_STAGE.PENDING_PARTNER || st === 'pending_partner') {
        return { flow_status: 'Awaiting partner', admin_can_approve: false };
      }
      if (ws === WORKFLOW_STAGE.PENDING_ADMIN || st === 'pending_approval') {
        return { flow_status: 'CIEL final approval', admin_can_approve };
      }
      return { flow_status: st || 'In review', admin_can_approve };
    }
    if (st === 'pending_partner') {
      return { flow_status: 'Awaiting partner', admin_can_approve: false };
    }
    return { flow_status: 'CIEL final approval', admin_can_approve };
  }

  /**
   * Student-created rows stay off the public directory until CIEL final approval.
   * After that they are listed like any other live opportunity (browse + homepage).
   * Apply Now still uses participation_scope; the stored default visibility is "restricted".
   */
  private getDirectoryControlFields(opp: Opportunity) {
    return {
      admin_hidden: opp.admin_hidden === true,
      admin_expired: opp.admin_expired === true,
      directory_visible: this.isPubliclyVisibleOpportunity(opp),
    };
  }

  /**
   * Public directory: honor org/creator visibility flags only. Participation rules apply at
   * apply/enroll time. Delegates to the shared util so admin list payloads can report the exact
   * same `directory_visible` truth instead of re-deriving a simplified (and driftable) version.
   */
  private isPubliclyVisibleOpportunity(opp: Opportunity): boolean {
    return isPubliclyVisibleOpportunityUtil(opp);
  }

  private getFacultyApprovalReturnTo(opportunityId: string): string {
    return `/dashboard/faculty/approvals?opportunity=${encodeURIComponent(opportunityId)}&tab=pending`;
  }

  private getPartnerApprovalReturnTo(opportunityId: string): string {
    return `/dashboard/partner/verify?opportunity=${encodeURIComponent(opportunityId)}&tab=pending`;
  }

  private async getOpportunityCreatorContact(opportunity: Opportunity) {
    if (!opportunity.creatorId) return null;
    return this.usersRepository.findOne({
      where: { id: opportunity.creatorId },
      select: ['id', 'email', 'name', 'university', 'institution', 'role'],
    });
  }

  private async notifyStudentOpportunityUpdate(
    opportunity: Opportunity,
    input: {
      title: string;
      message: string;
      emailSubject: string;
      emailTitle?: string;
      emailMessage?: string;
      reason?: string | null;
      /** When true, only in-app notification is sent (no generic status email). */
      skipStatusEmail?: boolean;
    },
  ) {
    const creator = await this.getOpportunityCreatorContact(opportunity);
    if (!creator) return;

    if (creator.id) {
      try {
        await this.notificationsService.createApprovalNotification(
          creator.id,
          input.title,
          input.message,
        );
      } catch (error) {
        console.warn(
          'Failed to create student notification',
          (error as Error).message,
        );
      }
    }

    if (creator.email && !input.skipStatusEmail) {
      try {
        await this.mailService.sendStudentOpportunityStatusUpdate(
          creator.email,
          opportunity.title,
          input.emailSubject,
          input.emailTitle || input.title,
          input.emailMessage || input.message,
          input.reason,
        );
      } catch (error) {
        console.warn(
          'Failed to send student opportunity update email',
          (error as Error).message,
        );
      }
    }
  }

  private async sendPartnerApprovalEmail(
    opportunity: Opportunity,
    introText?: string,
  ): Promise<boolean> {
    const partnerEmail = this.resolvePartnerEmailFromOpportunity(opportunity);
    if (!partnerEmail) {
      console.warn(
        'Partner approval email skipped: no partner email on opportunity',
        opportunity.id,
      );
      return false;
    }
    if (!opportunity.partnerToken) {
      opportunity.partnerToken = randomUUID();
      await this.opportunitiesRepository.save(opportunity);
    }

    const creator = await this.getOpportunityCreatorContact(opportunity);
    const details = this.buildOpportunityVerificationEmailDetails(opportunity, {
      studentName: creator?.name || undefined,
      studentUniversity:
        creator?.university || creator?.institution || undefined,
    });

    try {
      await this.mailService.sendPartnerVerification(
        partnerEmail,
        opportunity.title,
        opportunity.partnerToken,
        details,
        {
          path: '/verify/partner',
          returnTo: this.getPartnerApprovalReturnTo(opportunity.id),
          introText:
            introText ??
            (`The faculty supervisor has approved <strong>${this.escHtml(opportunity.title)}</strong>. ` +
              'Please review the partner execution scope to continue this opportunity in CIEL.'),
          ctaLabel: 'Review partner approval',
        },
      );
      return true;
    } catch (error) {
      console.warn(
        'Failed to send partner approval email',
        (error as Error).message,
      );
      return false;
    }
  }

  private async sendAdminReviewEmail(
    opportunity: Opportunity,
    stageLabel: string,
  ) {
    try {
      await this.mailService.sendAdminOpportunityReviewNeeded(
        opportunity.title,
        opportunity.id,
        stageLabel,
        communityServicePublicCode(opportunity.id, opportunity.createdAt),
      );
    } catch (error) {
      console.warn(
        'Failed to send admin review email',
        (error as Error).message,
      );
    }
  }

  private escHtml(input: string) {
    return String(input)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private async handleFacultyApprovedSideEffects(opportunity: Opportunity): Promise<{
    partnerEmailSent: boolean;
    partnerEmail: string | null;
  }> {
    // Partner/admin notice must fire for every creator kind that can reach this stage after a
    // faculty gate clears — legacy liaison flow, an NGO/Partner Organization creator's linked
    // faculty gate, and now a CIEL PK Super Admin's named-faculty gate (initCielAdminCreated) all
    // route through here with `isStudentCreated: false`. Only the in-app "your opportunity" student
    // notice below is student-specific.
    if (opportunity.workflowStage === WORKFLOW_STAGE.PENDING_PARTNER) {
      // Faculty → Partner is sequential. Do not email the partner at create while
      // faculty is still pending — their verify link is rejected until this stage.
      const partnerEmail = this.resolvePartnerEmailFromOpportunity(opportunity);
      const partnerEmailSent = await this.sendPartnerApprovalEmail(opportunity);
      if (!partnerEmailSent) {
        console.warn(
          'Faculty approved but partner verification email was NOT delivered (scheduling background retry)',
          {
            opportunityId: opportunity.id,
            partnerEmail,
            hasPartnerToken: !!opportunity.partnerToken,
          },
        );
        const oppId = opportunity.id;
        setTimeout(() => {
          this.sendPartnerApprovalEmail(opportunity).then((ok) => {
            if (!ok) {
              console.warn(
                'Background partner verification email retry failed',
                { opportunityId: oppId, partnerEmail },
              );
            }
          });
        }, 12_000);
      }
      if (opportunity.isStudentCreated) {
        await this.notifyStudentOpportunityUpdate(opportunity, {
          title: 'Faculty Approved',
          message:
            'Your opportunity has passed faculty review and is now waiting for partner approval.',
          emailSubject: 'Faculty approved your opportunity',
        });
      }
      return { partnerEmailSent, partnerEmail };
    }

    if (opportunity.workflowStage === WORKFLOW_STAGE.PENDING_ADMIN) {
      await this.sendAdminReviewEmail(opportunity, 'faculty approval');
      if (opportunity.isStudentCreated) {
        await this.notifyStudentOpportunityUpdate(opportunity, {
          title: 'Faculty Approved',
          message:
            'Your opportunity has passed faculty review and is now waiting for admin approval.',
          emailSubject: 'Faculty approved your opportunity',
        });
      }
    }
    return { partnerEmailSent: false, partnerEmail: null };
  }

  private async handlePartnerApprovedSideEffects(opportunity: Opportunity) {
    const execBlocking =
      !!opportunity.execution_verification_token &&
      !opportunity.execution_verified;
    const stillNeedsCielReview =
      opportunity.workflowStage === WORKFLOW_STAGE.PENDING_ADMIN ||
      (opportunity.status === 'pending_approval' && !opportunity.admin_approved);
    if (
      stillNeedsCielReview &&
      (!execBlocking || opportunity.isStudentCreated)
    ) {
      await this.sendAdminReviewEmail(opportunity, 'partner approval');
    }

    if (!opportunity.isStudentCreated) return;

    await this.notifyStudentOpportunityUpdate(opportunity, {
      title: 'Partner Approved',
      message:
        'Your opportunity has passed partner review and is now waiting for admin approval.',
      emailSubject: 'Partner approved your opportunity',
    });
  }

  private async handleAdminApprovedSideEffects(opportunity: Opportunity) {
    // In-app notice only. The creator email below is the one live message.
    await this.notifyStudentOpportunityUpdate(opportunity, {
      title: 'Opportunity live',
      message: opportunity.isStudentCreated
        ? 'Your opportunity has passed admin review and is now live on CIEL. You can begin your report from your dashboard.'
        : 'Your opportunity has passed admin review and is now live on CIEL. Students can now discover and apply to it.',
      emailSubject: 'Your opportunity is now live',
      skipStatusEmail: true,
    });

    const creator = await this.getOpportunityCreatorContact(opportunity);
    if (creator?.email) {
      try {
        await this.mailService.sendOpportunityLiveStartReportEmail({
          to: creator.email,
          creatorName: creator.name || 'there',
          projectTitle: opportunity.title,
          partnerName: this.liveEmailPartnerName(opportunity),
          requiredHours: this.liveEmailRequiredHours(opportunity),
          projectPeriod: this.liveEmailProjectPeriod(opportunity),
          reportPath: this.liveEmailReportPath(creator.role, opportunity.id),
          publicCode: communityServicePublicCode(
            opportunity.id,
            opportunity.createdAt,
          ),
          isStudentCreator: opportunity.isStudentCreated === true,
        });
      } catch (error) {
        console.warn(
          'Failed to send opportunity live start-report email',
          {
            opportunityId: opportunity.id,
            to: creator.email,
            error: (error as Error).message,
          },
        );
      }
    } else {
      console.warn(
        'Admin approved but creator email missing — start-report email skipped',
        { opportunityId: opportunity.id, creatorId: opportunity.creatorId },
      );
    }

    if (!opportunity.isStudentCreated) return;

    try {
      await this.mailService.sendAdminStudentMayStartReport(
        opportunity.title || 'Project',
        opportunity.id,
        creator?.name || creator?.email || 'Student',
      );
    } catch (error) {
      console.warn(
        'Failed to send admin start-report notice',
        (error as Error).message,
      );
    }
  }

  private liveEmailPartnerName(opportunity: Opportunity): string {
    const supervision = opportunity.supervision as
      | { partner_org_name?: string; external_partner_org_name?: string }
      | undefined;
    const partnerOrg = opportunity.partner_organization as
      | { organization_name?: string; name?: string }
      | undefined;
    const collab = opportunity.external_partner_collaboration as
      | { organization_name?: string }
      | undefined;
    const executing = opportunity.executing_context as
      | { partner?: { organization_name?: string } }
      | undefined;
    const name = [
      supervision?.partner_org_name,
      supervision?.external_partner_org_name,
      collab?.organization_name,
      partnerOrg?.organization_name,
      partnerOrg?.name,
      executing?.partner?.organization_name,
    ].find((value) => typeof value === 'string' && value.trim());
    return name?.trim() || '—';
  }

  private liveEmailRequiredHours(opportunity: Opportunity): string {
    const timeline = opportunity.timeline as
      | { expected_hours?: number | string; required_hours?: number | string }
      | undefined;
    const raw = timeline?.expected_hours ?? timeline?.required_hours;
    if (raw == null || String(raw).trim() === '') return '—';
    return `${String(raw).trim()} hours per student`;
  }

  private liveEmailProjectPeriod(opportunity: Opportunity): string {
    const timeline = opportunity.timeline as
      | { start_date?: string; end_date?: string }
      | undefined;
    const start = this.formatLiveEmailDate(timeline?.start_date);
    const end = this.formatLiveEmailDate(timeline?.end_date);
    if (start && end) return `${start} – ${end}`;
    return start || end || '—';
  }

  private formatLiveEmailDate(value?: string): string {
    const raw = (value || '').trim();
    if (!raw) return '';
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return raw;
    return parsed.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  }

  private liveEmailReportPath(role: string | undefined, opportunityId: string): string {
    const id = encodeURIComponent(opportunityId);
    if (!role || role === UserRole.STUDENT) {
      return `/dashboard/student/report?projectId=${id}`;
    }
    if (role === UserRole.FACULTY) {
      return '/dashboard/faculty/community-service';
    }
    return '/dashboard/partner/community-service';
  }

  async create(userId: string, createOpportunityDto: CreateOpportunityDto) {
    if (createOpportunityDto?.draft === true) {
      return this.saveCreatorOpportunityDraft(userId, null, createOpportunityDto);
    }
    const user = await this.usersRepository.findOne({
      where: { id: userId },
      relations: ['organization'],
    });
    if (!user) {
      throw new ForbiddenException('User not found');
    }
    if (!OPPORTUNITY_CREATOR_ROLES.includes(user.role)) {
      throw new ForbiddenException(
        'Your account role is not allowed to create opportunities',
      );
    }
    this.ensureProfileComplete(user);
    if (!createOpportunityDto.title?.trim()) {
      throw new BadRequestException('Title is required');
    }
    if (
      !(createOpportunityDto.objectives as { description?: unknown })
        ?.description ||
      !String(
        (createOpportunityDto.objectives as { description?: unknown })
          .description,
      ).trim()
    ) {
      throw new BadRequestException('objectives.description is required');
    }
    createOpportunityDto.safety_declaration =
      this.resolveSafetyDeclarationPayload(createOpportunityDto);
    createOpportunityDto.safety_declaration = this.normalizeSafetyDeclaration(
      createOpportunityDto.safety_declaration,
    );

    this.sanitizeAndBoundContent(createOpportunityDto);
    this.validateSupervision(createOpportunityDto.supervision);
    this.validateOrganizationContacts(createOpportunityDto);
    this.validateSafetyDeclaration(createOpportunityDto.safety_declaration);
    this.validateSubmissionConfirmations(
      createOpportunityDto.submission_confirmations,
    );
    this.validateParticipationScope(createOpportunityDto.participation_scope);
    this.validateNestedContactEmails(createOpportunityDto);
    this.validateExternalPartner(
      createOpportunityDto.external_partner_collaboration,
    );
    this.validateLocation(
      createOpportunityDto.mode,
      createOpportunityDto.location,
    );
    this.validateTimeline(createOpportunityDto.timeline, { requireDates: true });
    await this.assertNoOwnDuplicateTitle(user.id, createOpportunityDto.title);

    const isFaculty = user.role === UserRole.FACULTY;
    const isCielAdmin = user.role === UserRole.SUPER_ADMIN;
    const org = await this.organizationsService.getMyOrganization(userId);

    if (!org && !isFaculty && !isCielAdmin) {
      throw new ForbiddenException(
        'User must belong to an organization to create opportunities',
      );
    }

    // Idempotency for retried / double-clicked submits: same creator + org + identical payload
    // inside a short window returns the row already created (no second row, no second emails).
    // A session advisory lock on a pinned connection (same pattern as the student flow) makes the
    // check-then-insert atomic per creator.
    const { draft: _fpDraft, ...fingerprintBody } =
      createOpportunityDto as CreateOpportunityDto & Record<string, unknown>;
    const fingerprint = createPayloadFingerprint({
      creatorId: user.id,
      organizationId: org?.id ?? null,
      body: fingerprintBody,
    });
    const lockKey = `create_creator_opportunity:${user.id}`;
    const lockRunner =
      this.opportunitiesRepository.manager.connection.createQueryRunner();
    try {
      await lockRunner.connect();
      await lockRunner.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
      try {
        const recent = await this.opportunitiesRepository
          .createQueryBuilder('o')
          .where('o.creatorId = :cid', { cid: user.id })
          .andWhere('o.createFingerprint = :fp', { fp: fingerprint })
          .andWhere('o.createdAt >= :since', {
            since: new Date(Date.now() - CREATE_DEDUPE_WINDOW_MS),
          })
          .andWhere('o.status NOT IN (:...ignored)', {
            ignored: CREATE_DEDUPE_IGNORED_STATUSES,
          })
          .orderBy('o.createdAt', 'DESC')
          .getOne();
        if (recent) return recent;
        return await this.finishCreatingCreatorOpportunity(
          user,
          org,
          createOpportunityDto,
          fingerprint,
        );
      } finally {
        await lockRunner.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]);
      }
    } finally {
      await lockRunner.release();
    }
  }

  private async finishCreatingCreatorOpportunity(
    user: User,
    org: { id: string } | null,
    createOpportunityDto: CreateOpportunityDto,
    createFingerprint: string,
  ) {
    const userId = user.id;
    const isFaculty = user.role === UserRole.FACULTY;
    const isCielAdmin = user.role === UserRole.SUPER_ADMIN;

    const hasExecContactEmail = !!this.normalizeEmail(
      typeof createOpportunityDto.executing_organization?.official_email ===
        'string'
        ? createOpportunityDto.executing_organization.official_email
        : undefined,
    );
    const needsExecutingOrgVerification =
      this.hasAdditionalPartnerOrganization(createOpportunityDto) &&
      hasExecContactEmail;
    const executionVerificationToken = needsExecutingOrgVerification
      ? randomUUID()
      : null;
    /** Partner gate for faculty-authored posts (same heuristics as student flow, but only when a valid partner email exists). */
    let facultyPartnerToken: string | null = null;
    /** NGO/Partner Organization creator optionally links a faculty as an academic contact
     * ("Academic / faculty link" section) — when they do, that faculty's approval becomes a real
     * required gate, same as it would be for a student- or faculty-created opportunity.
     * This gate is independent of executing-org portal confirm: both can be required; exec runs
     * first (`pending_execution`), then faculty, then partner/admin. */
    const namedFacultyEmail = this.resolveFacultyEmail(createOpportunityDto);
    const creatorEmail = this.normalizeEmail(user.email);
    const orgCreatorFacultyEmail = isCielAdmin
      ? namedFacultyEmail && namedFacultyEmail !== creatorEmail
        ? namedFacultyEmail
        : null
      : !isFaculty
        ? namedFacultyEmail
        : null;
    const orgCreatorFacultyToken = orgCreatorFacultyEmail ? randomUUID() : null;
    // Admin queue (findAllPending) lists only pending_approval. Faculty-created opps used to default to
    // pending_execution when admin_approval_required was false, so they never appeared for CIEL Admin.
    let initialStatus: string;
    if (needsExecutingOrgVerification) {
      initialStatus = 'pending_execution';
    } else if (isFaculty) {
      const wantsPartner =
        this.studentOpportunityRequiresPartner(createOpportunityDto);
      const partnerContact = wantsPartner
        ? this.resolvePartnerEmail(createOpportunityDto)
        : null;
      const requiresPartnerGate = !!(wantsPartner && partnerContact);
      facultyPartnerToken = requiresPartnerGate ? randomUUID() : null;
      initialStatus = requiresPartnerGate
        ? 'pending_partner'
        : 'pending_approval';
    } else if (isCielAdmin) {
      const wantsPartner =
        this.studentOpportunityRequiresPartner(createOpportunityDto);
      const partnerContact = wantsPartner
        ? this.resolvePartnerEmail(createOpportunityDto)
        : null;
      const requiresPartnerGate = !!(wantsPartner && partnerContact);
      facultyPartnerToken = requiresPartnerGate ? randomUUID() : null;
      // Placeholder — `initCielAdminCreated` overwrites with live / pending_partner / pending_faculty.
      initialStatus = facultyPartnerToken
        ? 'pending_partner'
        : orgCreatorFacultyToken
          ? 'pending_faculty'
          : 'active';
    } else if (orgCreatorFacultyToken) {
      initialStatus = 'pending_faculty';
    } else {
      // CIEL PK review is always required for org-created opportunities (NGO/Partner/Corporate) —
      // there is no creator role here that gets to skip it, so this must never be a client-trusted
      // flag. A client-supplied `admin_approval_required: false` used to route these straight to
      // `pending_execution` with no further stage, silently orphaning the row (never publishable,
      // never visible for CIEL PK to act on).
      initialStatus = 'pending_approval';
    }

    /** Distinct partner_organization contact must acknowledge (even when executing-org portal step runs first). */
    const needsPartnerOrgAck =
      this.shouldRequirePartnerOrganizationAck(createOpportunityDto);
    let resolvedPartnerToken: string | null =
      (isFaculty || isCielAdmin) &&
      !needsExecutingOrgVerification &&
      facultyPartnerToken
        ? facultyPartnerToken
        : null;
    if (needsPartnerOrgAck && !resolvedPartnerToken) {
      resolvedPartnerToken = randomUUID();
    }

    const { draft: _orgDraftFlag, ...createFields } = createOpportunityDto;
    // Strip client-controlled approval/live fields so a crafted payload cannot skip faculty/admin.
    const {
      admin_approved: _clientAdminApproved,
      admin_approval_required: _clientAdminRequired,
      workflowStage: _clientWorkflow,
      workflow_stage: _clientWorkflowSnake,
      faculty_verified: _clientFacultyVerified,
      facultyApprovalStatus: _clientFacultyStatus,
      partnerApprovalStatus: _clientPartnerStatus,
      adminApprovalStatus: _clientAdminStatus,
      status: _clientStatus,
      isStudentCreated: _clientIsStudentCreated,
      partnerVerified: _clientPartnerVerified,
      execution_verified: _clientExecVerified,
      ...safeCreateFields
    } = createFields as CreateOpportunityDto & Record<string, unknown>;
    const payload: DeepPartial<Opportunity> = {
      ...safeCreateFields,
      organizationId: org?.id || null,
      facultyId: user.role === UserRole.FACULTY ? user.id : null,
      creatorId: user.id,
      createFingerprint,
      status: initialStatus,
      admin_approved: false,
      execution_verification_token: executionVerificationToken,
      execution_verified: !executionVerificationToken,
      execution_verification_status: executionVerificationToken
        ? 'pending_execution'
        : 'execution_verified',
      sdg: createOpportunityDto.sdg_info?.sdg_id || 'SDG', // Fallback
      ...(resolvedPartnerToken
        ? {
            partnerToken: resolvedPartnerToken,
            partnerVerified: false,
            requiresPartnerApproval: true,
            partnerApprovalStatus: LINE_STATUS.PENDING,
            ...(isFaculty
              ? {
                  facultyApprovalStatus: LINE_STATUS.APPROVED,
                  adminApprovalStatus: LINE_STATUS.PENDING,
                }
              : {}),
          }
        : {}),
      ...(!isFaculty
        ? orgCreatorFacultyToken
          ? {
              faculty_verification_token: orgCreatorFacultyToken,
              faculty_verification_status: 'pending_faculty',
              faculty_verified: false,
              facultyApprovalStatus: LINE_STATUS.PENDING,
            }
          : { facultyApprovalStatus: LINE_STATUS.NOT_APPLICABLE }
        : {}),
    };

    const opportunity = this.opportunitiesRepository.create(payload);
    if (isFaculty) {
      // Always init faculty workflow lines (even when executing-org confirm runs first).
      this.opportunityWorkflow.initFacultyCreated(
        opportunity,
        !!resolvedPartnerToken,
      );
      if (needsExecutingOrgVerification) {
        opportunity.status = 'pending_execution';
        opportunity.workflowStage = null;
      }
    } else if (isCielAdmin) {
      this.opportunityWorkflow.initCielAdminCreated(opportunity, {
        requiresPartner: !!resolvedPartnerToken,
        requiresFaculty: !!orgCreatorFacultyToken,
      });
      if (needsExecutingOrgVerification) {
        opportunity.status = 'pending_execution';
        opportunity.workflowStage = null;
        // initCielAdminCreated may have briefly marked the row live when no partner/faculty
        // was named — keep the self-approved admin *line* so exec confirm can finish live,
        // but clear the public live flag until that portal step clears.
        opportunity.admin_approved = false;
      }
    } else {
      // Partner / NGO / Corporate org creator — always initializes CIEL PK admin as required.
      this.opportunityWorkflow.initOrgCreated(opportunity, {
        requiresPartner: !!resolvedPartnerToken,
        requiresFaculty: !!orgCreatorFacultyToken,
        needsExecutingOrg: needsExecutingOrgVerification,
      });
    }

    const saved = await this.opportunitiesRepository.save(opportunity);

    // Faculty magic-link email only when the row is actually waiting on faculty —
    // not while executing-org portal confirm still blocks that stage.
    if (
      orgCreatorFacultyToken &&
      (saved.status === 'pending_faculty' ||
        saved.workflowStage === WORKFLOW_STAGE.PENDING_FACULTY)
    ) {
      await this.notifyFacultyForStudentOpportunityVerification(saved);
    }

    // Notify executing-org contact: sign in and confirm from opportunity detail (no public token link).
    if (
      executionVerificationToken &&
      createOpportunityDto.executing_organization?.official_email
    ) {
      const verifyBase = (
        process.env.FRONTEND_URL ||
        process.env.APP_URL ||
        ''
      ).replace(/\/+$/, '');
      const nextPath = `/dashboard/partner/requests/${saved.id}`;
      const signInPath = `/login?next=${encodeURIComponent(nextPath)}`;
      const portalLink = verifyBase ? `${verifyBase}${signInPath}` : signInPath;
      try {
        await this.mailService.sendExecutingOrganizationVerificationEmail(
          createOpportunityDto.executing_organization.official_email,
          saved.title,
          portalLink,
        );
      } catch (e) {
        console.warn(
          'Failed to send executing org verification email',
          e.message,
        );
      }
    }

    // Informational notice only when there is no magic-link partner gate for this row.
    const partnerEmail =
      createOpportunityDto.partner_organization?.official_email;
    if (partnerEmail && !resolvedPartnerToken) {
      try {
        await this.mailService.sendPartnerOpportunityNotice(
          partnerEmail,
          saved.title,
        );
      } catch (e) {
        console.warn('Failed to send partner org email', e.message);
      }
    }

    if (resolvedPartnerToken) {
      const waitingOnFaculty =
        saved.workflowStage === WORKFLOW_STAGE.PENDING_FACULTY ||
        saved.status === 'pending_faculty';
      const pe = this.resolvePartnerEmail(createOpportunityDto);
      if (pe && !waitingOnFaculty) {
        try {
          const verifyDetails = this.buildOpportunityVerificationEmailDetails(
            saved,
            {
              facultyAuthorName: resolveDisplayNameForProfile(user),
              facultyAuthorEmail: user.email || undefined,
            },
          );
          await this.mailService.sendPartnerVerification(
            pe,
            saved.title,
            resolvedPartnerToken,
            verifyDetails,
            {
              path: '/verify/partner',
              returnTo: this.getPartnerApprovalReturnTo(saved.id),
            },
          );
        } catch (e) {
          console.warn(
            'Failed to send partner verification email for opportunity',
            (e as Error).message,
          );
        }
      }
    }

    // Only email CIEL PK when the row is actually ready for final admin review —
    // not while faculty / partner / executing-org gates are still open.
    if (
      !saved.admin_approved &&
      this.isOpportunityReadyForAdminFinalApprove(saved)
    ) {
      await this.sendAdminReviewEmail(saved, 'new submission');
    }

    // Never expose the internal dedupe hash in the response.
    delete saved.createFingerprint;
    return saved;
  }

  async findSimilarStudentCreatedOpportunities(
    title: string,
    universityName: string,
    options?: {
      excludeOpportunityId?: string;
      limit?: number;
      requestingUserId?: string;
    },
  ) {
    const trimmedTitle = String(title || '').trim();
    const uniNorm = String(universityName || '')
      .trim()
      .toLowerCase();
    if (trimmedTitle.length < 6) {
      return [];
    }

    const excludeId = options?.excludeOpportunityId?.trim() || '';
    const limit = Math.min(Math.max(options?.limit ?? 6, 1), 12);
    const targetNorm = normalizeOpportunityTitleForMatch(trimmedTitle);

    const deadStatuses = ['rejected', 'cancelled', 'archived'];
    // Narrow in SQL first (not a draft + shares a significant word with the title) so the 300-row
    // window below can't silently push older real duplicates out of reach on a large platform.
    const targetWords = targetNorm
      .split(' ')
      .filter((w) => w.length > 2)
      .slice(0, 6);
    const candidatesQb = this.opportunitiesRepository
      .createQueryBuilder('o')
      .where('o.isStudentCreated = :isc', { isc: true })
      .andWhere("(o.status IS NULL OR o.status != 'draft')");
    if (targetWords.length > 0) {
      candidatesQb.andWhere(
        new Brackets((qb) => {
          targetWords.forEach((w, i) => {
            qb.orWhere(`LOWER(o.title) LIKE :tw${i}`, {
              [`tw${i}`]: `%${w.replace(/[%_]/g, '')}%`,
            });
          });
        }),
      );
    }
    const candidates = await candidatesQb
      .andWhere('(o.workflowStage IS NULL OR o.workflowStage != :rej)', {
        rej: WORKFLOW_STAGE.REJECTED,
      })
      .andWhere('(o.status IS NULL OR o.status NOT IN (:...dead))', {
        dead: deadStatuses,
      })
      .orderBy('o.createdAt', 'DESC')
      .take(300)
      .getMany();

    const matches: Array<{
      id: string;
      title: string;
      status: string | null;
      workflow_stage: string | null;
      created_at: string;
      match_strength: 'exact' | 'similar';
    }> = [];

    for (const opp of candidates) {
      if (excludeId && opp.id === excludeId) continue;
      // A draft is not a live listing. Including the owner's own draft would block Next-save
      // from later submitting that same opportunity as a duplicate of itself.
      if (String(opp.status || '').toLowerCase() === 'draft') {
        continue;
      }
      if (!opportunityMatchesUniversity(opp, uniNorm)) continue;
      if (!opportunityTitlesAreSimilar(trimmedTitle, opp.title || '')) continue;

      const otherNorm = normalizeOpportunityTitleForMatch(opp.title || '');
      matches.push({
        id: opp.id,
        title: opp.title,
        status: this.getApiOpportunityStatus(opp),
        workflow_stage: opp.workflowStage ?? null,
        created_at: opp.createdAt?.toISOString?.() ?? new Date().toISOString(),
        match_strength: otherNorm === targetNorm ? 'exact' : 'similar',
      });
      if (matches.length >= limit) break;
    }

    matches.sort((a, b) => {
      if (a.match_strength !== b.match_strength) {
        return a.match_strength === 'exact' ? -1 : 1;
      }
      return b.created_at.localeCompare(a.created_at);
    });

    return matches;
  }

  async createStudentOpportunity(userId: string, dto: CreateOpportunityDto) {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
      relations: ['organization'],
    });
    if (!user) throw new ForbiddenException('User not found');
    this.ensureProfileComplete(user);
    purifyStudentOpportunityContent(dto);
    dto.safety_declaration = this.resolveSafetyDeclarationPayload(dto);
    dto.safety_declaration = this.normalizeSafetyDeclaration(
      dto.safety_declaration,
    );
    const privateCandidate = isPrivateCandidateDto(dto);
    applyCanonicalPrivateCandidatePhone(dto, { required: true });
    if (
      !(dto.objectives as { description?: unknown })?.description ||
      !String(
        (dto.objectives as { description?: unknown }).description,
      ).trim()
    ) {
      throw new BadRequestException('objectives.description is required');
    }
    // validation rules for student flow
    if (!privateCandidate) {
      if (!dto.supervision?.contact)
        throw new BadRequestException(
          'Faculty email (supervision.contact) is required',
        );
      if (!dto.supervision?.faculty_department)
        throw new BadRequestException('faculty_department is required');
    }
    if (!dto.executing_context?.type) {
      if (privateCandidate) {
        dto.executing_context = {
          ...(typeof dto.executing_context === 'object' && dto.executing_context
            ? dto.executing_context
            : {}),
          type: 'independent',
          student_pathway: 'private',
          independent_community_activity: {
            activity_site_description: 'Private / independent candidate',
          },
        };
      } else {
        throw new BadRequestException('executing_context.type is required');
      }
    }
    this.validateSafetyDeclaration(dto.safety_declaration);
    this.validateSubmissionConfirmations(dto.submission_confirmations);
    this.validateLocation(dto.mode, dto.location);
    this.validateTimeline(dto.timeline, { requireDates: true });
    this.validateParticipationScope(dto.participation_scope);

    // A student-created opportunity must stay scoped to the student's own university
    // (all departments, or specific departments) — never another university, and never
    // "open to all universities". The client-supplied participation_scope/restricted_universities
    // are advisory only; the real gate is the student's own profile university, enforced here
    // regardless of what the request claims.
    if (!privateCandidate) {
      const ownUniversity =
        user.university?.trim() || user.institution?.trim() || '';
      if (!ownUniversity) {
        throw new BadRequestException(
          'Your profile is missing a university — update your profile before creating an opportunity.',
        );
      }
      const allowedStudentScopeRules = [
        'own_university_only',
        'own_university_departments',
      ];
      const requestedRule = String(
        dto.participation_scope?.rule || '',
      ).toLowerCase();
      if (
        dto.participation_scope &&
        !allowedStudentScopeRules.includes(requestedRule)
      ) {
        throw new BadRequestException(
          'Students may only scope an opportunity to their own university — either all departments or specific departments. Broader scopes require faculty, partner, or CIEL PK.',
        );
      }
      if (dto.participation_scope) {
        dto.participation_scope.creator_university_name = ownUniversity;
        dto.participation_scope.university_names = [ownUniversity];
      }
      dto.restricted_universities = [ownUniversity];
    }
    if (!privateCandidate) {
      this.validateSupervision(dto.supervision);
    } else if (dto.supervision) {
      if (
        dto.supervision.external_partner_email &&
        !this.isValidEmail(dto.supervision.external_partner_email)
      ) {
        throw new BadRequestException(
          'supervision.external_partner_email must be a valid email',
        );
      }
      if (
        dto.supervision.partner_email &&
        !this.isValidEmail(dto.supervision.partner_email)
      ) {
        throw new BadRequestException(
          'supervision.partner_email must be a valid email',
        );
      }
    }
    const responsibilitiesLen =
      typeof dto.activity_details?.student_responsibilities === 'string'
        ? dto.activity_details.student_responsibilities.length
        : 0;
    if (responsibilitiesLen > STUDENT_RESPONSIBILITIES_MAX_LENGTH) {
      throw new BadRequestException(
        `Detailed plan is too long (${responsibilitiesLen} characters). Please submit a concise bullet summary (max ${STUDENT_RESPONSIBILITIES_MAX_LENGTH} characters). Upload the full roadmap separately if needed.`,
      );
    }
    if (dto.external_partner_collaboration) {
      this.validateExternalPartner(dto.external_partner_collaboration);
    }

    if (dto.executing_context.type === 'partner') {
      const pe = this.resolvePartnerEmail(dto);
      if (!pe) {
        throw new BadRequestException(
          'Partner context requires a partner contact email (external_partner_collaboration.official_email, executing_context.partner.official_email, or supervision partner fields).',
        );
      }
    } else if (dto.executing_context.type === 'independent') {
      const ind = dto.executing_context.independent_community_activity || {};
      if (!privateCandidate && !ind.activity_site_description)
        throw new BadRequestException(
          'independent activity_site_description required',
        );
    }

    const openAllParticipation =
      String(dto.participation_scope?.rule || '').toLowerCase() ===
      'open_all_universities';
    const restricted =
      dto.restricted_universities && dto.restricted_universities.length > 0
        ? dto.restricted_universities
        : openAllParticipation || privateCandidate
          ? []
          : dto.participation_scope?.creator_university_name
            ? [dto.participation_scope.creator_university_name]
            : [];

    const requiresPartner = this.studentOpportunityRequiresPartner(dto);
    const partnerEmail = requiresPartner ? this.resolvePartnerEmail(dto) : null;
    if (requiresPartner && !partnerEmail) {
      throw new BadRequestException(
        'Partner approval is required for this submission but no valid partner email was found. Provide official_email in external_partner_collaboration, executing_context.partner, supervision.partner_email / external_partner_email, or partner_organization.',
      );
    }

    const creatorUniversity =
      dto.participation_scope?.creator_university_name?.trim() ||
      user.university?.trim() ||
      user.institution?.trim() ||
      '';
    // Postgres session-level advisory lock, scoped to this student — serializes a double-click or
    // multi-tab double-submit so two near-simultaneous requests can't both pass the duplicate-title
    // check before either INSERT lands. Released in the `finally` below no matter how this method
    // exits (including the ConflictException thrown right after acquiring it).
    //
    // Session-level locks belong to ONE connection: lock and unlock must run on the same one.
    // Going through `manager.query` twice draws two arbitrary connections from the pool, so under
    // load the unlock could hit a different session (a silent no-op) and leave the lock held by a
    // pooled connection — that student's next create would then block behind it. A dedicated
    // query runner pins both statements to a single connection.
    const lockKey = `create_student_opportunity:${user.id}`;
    const lockRunner =
      this.opportunitiesRepository.manager.connection.createQueryRunner();
    let locked = false;
    try {
      await lockRunner.connect();
      await lockRunner.query('SELECT pg_advisory_lock(hashtext($1))', [
        lockKey,
      ]);
      locked = true;
      if (!privateCandidate) {
        const similarOnCreate =
          await this.findSimilarStudentCreatedOpportunities(
            dto.title || '',
            creatorUniversity,
            { requestingUserId: user.id },
          );
        if (similarOnCreate.length > 0) {
          throw new ConflictException({
            message:
              'Disclaimer: A project with a similar title already exists at your university. Only one team lead should create the listing. Other team members must join via Apply Now on the existing opportunity instead of creating another copy.',
            code: 'SIMILAR_STUDENT_OPPORTUNITY_EXISTS',
            similarOpportunities: similarOnCreate,
          });
        }
      }
      return await this.finishCreatingStudentOpportunity(
        dto,
        user,
        privateCandidate,
        requiresPartner,
        partnerEmail,
        restricted,
        openAllParticipation,
      );
    } finally {
      try {
        if (locked) {
          await lockRunner.query('SELECT pg_advisory_unlock(hashtext($1))', [
            lockKey,
          ]);
        }
      } finally {
        await lockRunner.release();
      }
    }
  }

  private async finishCreatingStudentOpportunity(
    dto: CreateOpportunityDto,
    user: User,
    privateCandidate: boolean,
    requiresPartner: boolean,
    partnerEmail: string | null,
    restricted: string[],
    openAllParticipation: boolean,
  ) {
    const partnerToken = requiresPartner && partnerEmail ? randomUUID() : null;

    let organizationId: string | null = null;
    /** Placeholder / partner org rows created by THIS call — removed again if the opportunity save fails. */
    let createdOrganizationId: string | null = null;
    if (dto.supervision?.partner_org_name) {
      const newOrganization = this.organizationsRepository.create({
        name: dto.supervision.partner_org_name,
        contactName: dto.supervision.partner_contact_person || '',
        contactEmail: dto.supervision.partner_email || '',
        orgType: 'OTHER',
        verificationStatus: 'unclaimed_student_initiated',
      });
      const savedOrg = await this.organizationsRepository.save(newOrganization);
      organizationId = savedOrg.id;
      createdOrganizationId = savedOrg.id;
    }

    if (!organizationId) {
      organizationId =
        await this.createPlaceholderOrganizationForStudentOpportunity(
          dto.title || '',
        );
      createdOrganizationId = organizationId;
    }

    // Everything from here to the opportunity INSERT can fail; don't leave an orphan
    // "unclaimed_student_initiated" organization behind when it does (students retry a lot).
    let saved: Opportunity;
    try {

      let resolvedFacultyId: string | null = null;
      if (dto.supervision?.contact) {
        const facultyUser = await this.usersRepository.findOne({
          where: {
            email: dto.supervision.contact.trim().toLowerCase(),
            role: UserRole.FACULTY,
          },
        });
        if (facultyUser) {
          resolvedFacultyId = facultyUser.id;
        }
      }

      const { draft: _studentDraftFlag, ...createFields } = dto;
      // Strip client-controlled approval/live fields so a crafted payload cannot skip faculty/admin.
      const {
        admin_approved: _clientAdminApproved,
        admin_approval_required: _clientAdminRequired,
        workflowStage: _clientWorkflow,
        workflow_stage: _clientWorkflowSnake,
        faculty_verified: _clientFacultyVerified,
        facultyApprovalStatus: _clientFacultyStatus,
        partnerApprovalStatus: _clientPartnerStatus,
        adminApprovalStatus: _clientAdminStatus,
        status: _clientStatus,
        isStudentCreated: _clientIsStudentCreated,
        ...safeCreateFields
      } = createFields as CreateOpportunityDto & Record<string, unknown>;
      const payload: DeepPartial<Opportunity> = {
        ...safeCreateFields,
        organizationId,
        facultyId: privateCandidate ? null : resolvedFacultyId,
        creatorId: user.id,
        status: privateCandidate
          ? requiresPartner
            ? 'pending_partner'
            : 'pending_approval'
          : 'pending_faculty',
        sdg: dto.sdg_info?.sdg_id || 'SDG',
        restricted_universities: restricted,
        visibility:
          dto.visibility ||
          (privateCandidate && openAllParticipation ? 'public' : 'restricted'),
        faculty_verification_status: privateCandidate
          ? 'not_required'
          : 'pending_faculty',
        faculty_verified: privateCandidate,
        faculty_verification_token: privateCandidate ? undefined : randomUUID(),
        isStudentCreated: true,
        admin_approved: false,
        requiresPartnerApproval: requiresPartner,
        partnerToken: partnerToken ?? undefined,
        partnerVerified: !requiresPartner,
      };

      const opportunity = this.opportunitiesRepository.create(payload);
      if (privateCandidate) {
        this.opportunityWorkflow.initStudentPrivateCandidate(
          opportunity,
          requiresPartner,
        );
      } else {
        this.opportunityWorkflow.initStudentCreated(opportunity, requiresPartner);
      }
      saved = await this.opportunitiesRepository.save(opportunity);
    } catch (e) {
      if (createdOrganizationId) {
        try {
          await this.organizationsRepository.delete(createdOrganizationId);
        } catch (cleanupErr) {
          console.warn(
            'Failed to remove placeholder organization after a failed student opportunity save',
            (cleanupErr as Error).message,
          );
        }
      }
      throw e;
    }

    const studentVerifyDetails = this.buildOpportunityVerificationEmailDetails(
      saved,
      {
        studentName: resolveDisplayNameForProfile(user),
        studentUniversity: user.university || user.institution || undefined,
      },
    );

    if (!privateCandidate) {
      const facultyTo =
        this.getFacultyEmailFromOpportunity(saved) ||
        this.normalizeEmail(dto.supervision?.contact);
      if (!facultyTo || !saved.faculty_verification_token) {
        console.warn(
          'Faculty verification email skipped on student create: missing faculty email or token',
          {
            opportunityId: saved.id,
            hasEmail: !!facultyTo,
            hasToken: !!saved.faculty_verification_token,
          },
        );
      } else {
        const sendFaculty = () =>
          this.mailService.sendFacultyStudentOpportunityVerification(
            facultyTo,
            saved.title,
            saved.faculty_verification_token!,
            studentVerifyDetails,
            {
              path: '/verify/faculty',
              returnTo: this.getFacultyApprovalReturnTo(saved.id),
            },
          );
        try {
          await sendFaculty();
        } catch (e) {
          console.warn(
            'Failed to send faculty verification email (will retry once in background)',
            (e as Error).message,
            { opportunityId: saved.id, to: facultyTo },
          );
          // MailService already retried transient SMTP; one delayed pass catches brief outages
          // without failing the student create response.
          setTimeout(() => {
            sendFaculty().catch((retryErr) =>
              console.warn(
                'Background faculty verification email retry failed',
                (retryErr as Error).message,
                { opportunityId: saved.id, to: facultyTo },
              ),
            );
          }, 12_000);
        }
      }
    }

    // Private-candidate has no faculty gate, so partner is next immediately.
    // Regular student listings wait until faculty approves (handleFacultyApprovedSideEffects).
    if (privateCandidate && partnerEmail && partnerToken) {
      const sendPartner = () =>
        this.mailService.sendPartnerVerification(
          partnerEmail,
          saved.title,
          partnerToken,
          studentVerifyDetails,
          {
            path: '/verify/partner',
            returnTo: this.getPartnerApprovalReturnTo(saved.id),
          },
        );
      try {
        await sendPartner();
      } catch (e) {
        console.warn(
          'Failed to send partner verification email (will retry once in background)',
          (e as Error).message,
        );
        setTimeout(() => {
          sendPartner().catch((retryErr) =>
            console.warn(
              'Background partner verification email retry failed',
              (retryErr as Error).message,
            ),
          );
        }, 12_000);
      }
    }

    return { success: true, data: saved };
  }

  async update(
    userId: string,
    updateOpportunityDto: UpdateOpportunityDto,
    organizationId?: string,
  ) {
    if (updateOpportunityDto?.draft === true) {
      return this.saveCreatorOpportunityDraft(
        userId,
        updateOpportunityDto.id,
        updateOpportunityDto,
      );
    }
    const opportunity = await this.opportunitiesRepository.findOne({
      where: { id: updateOpportunityDto.id },
    });
    if (!opportunity) {
      throw new NotFoundException('Opportunity not found');
    }

    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new ForbiddenException('User not found');
    }

    const isFacultyOwner =
      user.role === UserRole.FACULTY &&
      opportunity.creatorId === userId &&
      (opportunity.facultyId === userId || opportunity.facultyId == null);

    /** Student creator editing their own listing — has no organization membership, so the
     * org-match check below doesn't apply to them (mirrors the faculty-owner bypass). */
    const isStudentOwner =
      opportunity.isStudentCreated && opportunity.creatorId === userId;

    const isCielAdminOwner =
      user.role === UserRole.SUPER_ADMIN && opportunity.creatorId === userId;

    // Same lifecycle rules as the student edit route (StudentsService.updateStudentOpportunity):
    // this generic endpoint must not be a way around them — a student could otherwise rewrite
    // their own LIVE listing without re-review, or resurrect a permanently rejected one.
    if (isStudentOwner) {
      if (
        opportunity.admin_approved ||
        (opportunity.workflowStage === WORKFLOW_STAGE.LIVE &&
          opportunity.status !== 'draft') ||
        this.publicLiveStatuses.includes(
          String(opportunity.status || '').toLowerCase(),
        )
      ) {
        throw new BadRequestException('Approved opportunities cannot be updated');
      }
      // CIEL PK / faculty rejections are terminal ("permanently rejected" everywhere the student is
      // told). A partner-only rejection of a private-candidate listing remains resubmittable here
      // (see the `studentNeedsResubmit` flow below).
      if (
        opportunity.workflowStage === WORKFLOW_STAGE.REJECTED &&
        (opportunity.adminApprovalStatus === LINE_STATUS.REJECTED ||
          opportunity.facultyApprovalStatus === LINE_STATUS.REJECTED)
      ) {
        throw new BadRequestException(
          'This opportunity was permanently rejected and cannot be edited. Submit a new opportunity if needed.',
        );
      }
    }

    let orgId = organizationId;
    if (!orgId) {
      const org = await this.organizationsService.getMyOrganization(userId);
      orgId = org?.id;
    }

    if (!isFacultyOwner && !isStudentOwner && !isCielAdminOwner) {
      if (!orgId) {
        throw new ForbiddenException(
          'User must belong to an organization to update opportunities',
        );
      }
      if (opportunity.organizationId !== orgId) {
        throw new ForbiddenException(
          'You do not have access to this opportunity',
        );
      }
    }

    const rejectedResubmitSnapshot = {
      wasRejected:
        opportunity.status === 'rejected' ||
        opportunity.workflowStage === WORKFLOW_STAGE.REJECTED ||
        opportunity.adminApprovalStatus === LINE_STATUS.REJECTED ||
        opportunity.partnerApprovalStatus === LINE_STATUS.REJECTED,
      partnerLineRejected:
        opportunity.partnerApprovalStatus === LINE_STATUS.REJECTED,
      /** Snapshot before patch — student pipeline must never use NGO resubmit logic. */
      isStudentCreated: opportunity.isStudentCreated,
      wasLive: opportunity.workflowStage === WORKFLOW_STAGE.LIVE,
      wasRevisionRequested:
        opportunity.workflowStage === WORKFLOW_STAGE.REVISION ||
        opportunity.status === WORKFLOW_STAGE.REVISION ||
        opportunity.adminApprovalStatus === LINE_STATUS.REVISION_REQUESTED ||
        opportunity.partnerApprovalStatus === LINE_STATUS.REVISION_REQUESTED,
      /** Whether ANY line was ever approved — not just "is it live right now". Once CIEL PK
       * requests a revision, `workflowStage` moves off `live` even though the partner line may
       * still legitimately read `approved`; a blind full reset must not discard that. */
      everHadApprovedLine:
        opportunity.workflowStage === WORKFLOW_STAGE.LIVE ||
        opportunity.status === 'active' ||
        opportunity.partnerApprovalStatus === LINE_STATUS.APPROVED ||
        opportunity.adminApprovalStatus === LINE_STATUS.APPROVED,
      /** For the scoped faculty resubmit below — only the partner line, specifically. */
      partnerLineFlagged:
        opportunity.partnerApprovalStatus === LINE_STATUS.REJECTED ||
        opportunity.partnerApprovalStatus === LINE_STATUS.REVISION_REQUESTED,
      partnerEmailBefore: this.resolvePartnerEmailFromOpportunity(opportunity),
      requiresPartnerBefore:
        this.studentOpportunityRequiresPartner(
          opportunity as unknown as CreateOpportunityDto,
        ) && !!this.resolvePartnerEmailFromOpportunity(opportunity),
    };
    /** A student's own edit must also resume the pipeline out of "revision requested" — not just
     * "rejected" — otherwise a revision-requested opportunity never re-enters any reviewer's queue
     * once the student saves their fix. */
    const studentNeedsResubmit =
      rejectedResubmitSnapshot.wasRejected ||
      opportunity.workflowStage === WORKFLOW_STAGE.REVISION ||
      opportunity.status === WORKFLOW_STAGE.REVISION ||
      opportunity.facultyApprovalStatus === LINE_STATUS.REVISION_REQUESTED ||
      opportunity.partnerApprovalStatus === LINE_STATUS.REVISION_REQUESTED ||
      opportunity.adminApprovalStatus === LINE_STATUS.REVISION_REQUESTED;
    const studentResubmitBefore =
      this.snapshotStudentOpportunityResubmit(opportunity);

    // Student owners: no editing once approved/live, and they can never widen who may see/apply.
    // (Rejected / revision listings stay editable here — that is the resubmit path.)
    if (isStudentOwner) {
      const live =
        opportunity.admin_approved ||
        opportunity.status === 'active' ||
        opportunity.workflowStage === WORKFLOW_STAGE.LIVE;
      if (live) {
        throw new BadRequestException('Approved opportunities cannot be updated');
      }
    }

    const isLiveBefore =
      opportunity.admin_approved === true ||
      opportunity.workflowStage === WORKFLOW_STAGE.LIVE ||
      opportunity.status === 'active';
    const materialBefore = this.liveMaterialSignature(opportunity);
    const facultyEmailBefore = this.getFacultyEmailFromOpportunity(opportunity);

    const { id: _dtoId, draft: _draftFlag, ...rawPatch } =
      updateOpportunityDto as UpdateOpportunityDto & { id: string };
    // PATCH /opportunities/:id passes the raw body (no DTO whitelist), and POST /update's DTO
    // still exposes `status` — strip every server-controlled column so an edit can never
    // self-approve, republish, reassign ownership or forge verification tokens. Then allow-list
    // wizard fields so an untyped PATCH cannot copy unknown keys either.
    const stripped = stripServerControlledFields(rawPatch) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const key of UPDATE_PERSIST_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(stripped, key)) continue;
      if (stripped[key] === undefined) continue;
      if (isStudentOwner && (key === 'participation_scope' || key === 'restricted_universities')) {
        continue;
      }
      patch[key] = stripped[key];
    }
    this.sanitizeAndBoundContent(patch as never);
    // Edits must satisfy the same rules as create for every key they touch.
    this.validateEditPatch(patch);
    Object.assign(opportunity, patch);
    const liveMaterialReReview =
      isLiveBefore &&
      !isCielAdminOwner &&
      this.liveMaterialSignature(opportunity) !== materialBefore;
    // Only re-check location.pin when this edit is actually touching mode/location — a pre-fix
    // legacy record with no pin must still be editable for unrelated fields (title, dates, ...),
    // not permanently stuck because it predates this rule. New records are already gated at
    // create() time; this just stops an edit from actively making a pin worse (e.g. clearing it).
    if (patch.mode !== undefined || patch.location !== undefined) {
      this.validateLocation(opportunity.mode, opportunity.location);
    }
    if (patch.timeline !== undefined) {
      this.validateTimeline(opportunity.timeline, { requireDates: true });
    }
    if (
      patch.objectives !== undefined &&
      !String(
        (opportunity.objectives as { description?: unknown } | null)
          ?.description ?? '',
      ).trim()
    ) {
      throw new BadRequestException('objectives.description is required');
    }

    if (updateOpportunityDto.sdg_info) {
      opportunity.sdg = updateOpportunityDto.sdg_info.sdg_id || opportunity.sdg;
    }

    // Faculty edit/resubmit: force opportunity back into review lanes for fresh approval —
    // but only when it actually needs one. A published (live) opportunity that was never
    // rejected/revision-requested must stay live through a routine edit (fixing a typo, updating
    // a date); otherwise every faculty edit would silently unpublish an approved opportunity and
    // send it back through the whole approval chain again.
    const facultyEditNeedsFreshApproval =
      !rejectedResubmitSnapshot.wasLive ||
      rejectedResubmitSnapshot.wasRejected ||
      rejectedResubmitSnapshot.wasRevisionRequested ||
      // ...but a live listing whose audience / location / SDG / stakeholder contacts changed is no
      // longer what was approved, so it goes back through partner + CIEL PK review.
      liveMaterialReReview;
    if (
      isFacultyOwner &&
      !opportunity.isStudentCreated &&
      facultyEditNeedsFreshApproval
    ) {
      const requiresPartnerApproval =
        this.studentOpportunityRequiresPartner(
          opportunity as unknown as CreateOpportunityDto,
        ) && !!this.resolvePartnerEmailFromOpportunity(opportunity);

      opportunity.admin_approved = false;
      opportunity.rejectionReason = null;
      if (
        rejectedResubmitSnapshot.wasRejected ||
        rejectedResubmitSnapshot.wasRevisionRequested
      ) {
        opportunity.version = (opportunity.version || 1) + 1;
      }

      if (!rejectedResubmitSnapshot.everHadApprovedLine) {
        // Nothing has ever been approved yet (still in the initial review pipeline) — a full
        // recompute is safe because there is no prior approval that could be wrongly discarded.
        this.opportunityWorkflow.initFacultyCreated(
          opportunity,
          requiresPartnerApproval,
        );
        opportunity.partnerVerified = !requiresPartnerApproval;
        if (requiresPartnerApproval) {
          // New partner review round -> fresh link; the previous one stops resolving.
          // Also covers a partner added while editing a still-unapproved opportunity.
          opportunity.partnerToken = randomUUID();
        }
      } else {
        // Was previously live/approved and is now resubmitting after a rejection or revision
        // request — only rewind the specific line that actually needs re-review. An already
        // -approved partner line must not be forced back to pending just because CIEL PK (or the
        // faculty's own edit) touched the opportunity after a sibling line was flagged.
        const partnerEmailNow = this.resolvePartnerEmailFromOpportunity(opportunity);
        const partnerEmailChanged =
          this.normalizeEmail(
            rejectedResubmitSnapshot.partnerEmailBefore || '',
          ) !== this.normalizeEmail(partnerEmailNow || '');
        const partnerRequirementChanged =
          rejectedResubmitSnapshot.requiresPartnerBefore !==
          requiresPartnerApproval;
        const partnerNeedsReReview =
          requiresPartnerApproval &&
          (rejectedResubmitSnapshot.partnerLineFlagged ||
            partnerRequirementChanged ||
            partnerEmailChanged ||
            !opportunity.partnerVerified ||
            opportunity.partnerApprovalStatus !== LINE_STATUS.APPROVED);

        if (partnerNeedsReReview) {
          opportunity.requiresPartnerApproval = true;
          opportunity.partnerApprovalStatus = LINE_STATUS.PENDING;
          opportunity.partnerVerified = false;
          // Every re-review round gets a fresh link; the previous one stops resolving.
          opportunity.partnerToken = randomUUID();
          opportunity.adminApprovalStatus = LINE_STATUS.PENDING;
          opportunity.workflowStage = WORKFLOW_STAGE.PENDING_PARTNER;
          opportunity.status = 'pending_partner';
        } else {
          opportunity.requiresPartnerApproval = requiresPartnerApproval;
          if (!requiresPartnerApproval) {
            opportunity.partnerApprovalStatus = LINE_STATUS.NOT_APPLICABLE;
            opportunity.partnerVerified = true;
          }
          // Partner line is fine (already approved, or not required) — only CIEL PK's admin
          // line needs a fresh look.
          opportunity.adminApprovalStatus = LINE_STATUS.PENDING;
          opportunity.workflowStage = WORKFLOW_STAGE.PENDING_ADMIN;
          opportunity.status = 'pending_approval';
        }
      }

      if (
        opportunity.execution_verification_token &&
        !opportunity.execution_verified
      ) {
        opportunity.status = 'pending_execution';
        opportunity.execution_verification_status = 'pending_execution';
        opportunity.adminApprovalStatus = LINE_STATUS.PENDING;
      }

      // Re-review needs a fresh notification too — this branch used to silently rewind the
      // opportunity's approval lane with no email to whoever needs to act on it next.
      const editExecBlocking =
        !!opportunity.execution_verification_token &&
        !opportunity.execution_verified;
      if (
        opportunity.workflowStage === WORKFLOW_STAGE.PENDING_PARTNER &&
        opportunity.partnerToken &&
        !editExecBlocking
      ) {
        const partnerEmail = this.resolvePartnerEmailFromOpportunity(opportunity);
        if (partnerEmail) {
          try {
            const verifyDetails = this.buildOpportunityVerificationEmailDetails(
              opportunity,
              {
                facultyAuthorName: resolveDisplayNameForProfile(user),
                facultyAuthorEmail: user.email || undefined,
              },
            );
            await this.mailService.sendPartnerVerification(
              partnerEmail,
              opportunity.title,
              opportunity.partnerToken,
              verifyDetails,
              {
                path: '/verify/partner',
                returnTo: this.getPartnerApprovalReturnTo(opportunity.id),
                introText:
                  `The faculty supervisor updated <strong>${this.escHtml(opportunity.title)}</strong> and it needs your review again. ` +
                  'Please review the partner execution scope to continue this opportunity in CIEL.',
                ctaLabel: 'Review partner approval',
              },
            );
          } catch (e) {
            console.warn(
              'Failed to send partner verification email for faculty resubmission',
              (e as Error).message,
            );
          }
        }
      } else if (
        opportunity.status === 'pending_approval' &&
        !opportunity.admin_approved &&
        !editExecBlocking
      ) {
        await this.sendAdminReviewEmail(opportunity, 'faculty resubmission');
      }
    }

    // Student creator edit/resubmit: after rejection OR revision, saving edits sends it back into
    // the review pipeline — via the same stage-aware logic used for admin-driven contact edits, so
    // a private-candidate listing (no faculty line at all) doesn't get wrongly forced into
    // pending_faculty the way a blind initStudentCreated() call would.
    if (isStudentOwner && studentNeedsResubmit) {
      opportunity.rejectionReason = null;
      opportunity.version = (opportunity.version || 1) + 1;
      await this.applyStudentCreatedOpportunityResubmit(
        opportunity,
        studentResubmitBefore,
      );
    }

    // Partner / NGO org member: after a rejection OR a revision request (CIEL PK, partner or
    // linked faculty), saving edits resubmits into the review queue that flagged it. A revision
    // request used to be ignored here, leaving the row parked in `revision` forever.
    const isPartnerOrgMemberUpdate =
      !isFacultyOwner &&
      !!orgId &&
      opportunity.organizationId === orgId &&
      !rejectedResubmitSnapshot.isStudentCreated;

    let notifyFacultyAfterOrgResubmit = false;
    let notifyPartnerAfterOrgResubmit = false;
    // Org members resubmit after rejection AND after a revision request (it used to leave a
    // revision-requested listing stuck), and a material edit of a live listing is re-reviewed.
    const orgMemberResubmit =
      rejectedResubmitSnapshot.wasRejected ||
      rejectedResubmitSnapshot.wasRevisionRequested ||
      liveMaterialReReview;
    if (orgMemberResubmit && isPartnerOrgMemberUpdate) {
      opportunity.rejectionReason = null;
      opportunity.admin_approved = false;
      opportunity.version = (opportunity.version || 1) + 1;

      const execBlocking =
        !!opportunity.execution_verification_token &&
        !opportunity.execution_verified;
      // The linked faculty's own reject / revision must send the row back to that faculty — never
      // straight to CIEL PK, which can neither approve it (faculty line still flagged) nor act on
      // the faculty's behalf, so the row would be stuck for everyone.
      const needsFacultyReverify =
        (opportunity.facultyApprovalStatus === LINE_STATUS.REJECTED ||
          opportunity.facultyApprovalStatus === LINE_STATUS.REVISION_REQUESTED) &&
        !!this.getFacultyEmailFromOpportunity(opportunity);
      const partnerEmailNow = this.resolvePartnerEmailFromOpportunity(opportunity);
      const partnerContactChanged =
        this.normalizeEmail(rejectedResubmitSnapshot.partnerEmailBefore || '') !==
        this.normalizeEmail(partnerEmailNow || '');
      const needsPartnerReverify =
        opportunity.requiresPartnerApproval &&
        (rejectedResubmitSnapshot.partnerLineRejected ||
          opportunity.partnerApprovalStatus === LINE_STATUS.REJECTED ||
          opportunity.partnerApprovalStatus === LINE_STATUS.REVISION_REQUESTED ||
          rejectedResubmitSnapshot.partnerLineFlagged ||
          partnerContactChanged);

      if (needsFacultyReverify) {
        opportunity.facultyApprovalStatus = LINE_STATUS.PENDING;
        opportunity.faculty_verified = false;
        opportunity.faculty_verification_status = WORKFLOW_STAGE.PENDING_FACULTY;
        opportunity.faculty_verification_token = randomUUID();
        opportunity.adminApprovalStatus = LINE_STATUS.PENDING;
        if (execBlocking) {
          opportunity.status = 'pending_execution';
          opportunity.execution_verification_status = 'pending_execution';
          opportunity.workflowStage = null;
        } else {
          opportunity.status = 'pending_faculty';
          opportunity.workflowStage = WORKFLOW_STAGE.PENDING_FACULTY;
          notifyFacultyAfterOrgResubmit = true;
        }
      } else if (needsPartnerReverify) {
        opportunity.partnerApprovalStatus = LINE_STATUS.PENDING;
        opportunity.partnerVerified = false;
        // Fresh link for the new review round (expiry is re-stamped by the token-expiry
        // subscriber); the token from the rejected / revised round stops resolving.
        opportunity.partnerToken = randomUUID();
        opportunity.workflowStage = WORKFLOW_STAGE.PENDING_PARTNER;
        opportunity.status = 'pending_partner';
        opportunity.adminApprovalStatus = LINE_STATUS.PENDING;
        notifyPartnerAfterOrgResubmit = true;
      } else if (execBlocking) {
        opportunity.status = 'pending_execution';
        opportunity.execution_verification_status = 'pending_execution';
        opportunity.workflowStage = null;
        opportunity.adminApprovalStatus = LINE_STATUS.PENDING;
      } else {
        opportunity.status = 'pending_approval';
        opportunity.workflowStage = WORKFLOW_STAGE.PENDING_ADMIN;
        opportunity.adminApprovalStatus = LINE_STATUS.PENDING;
      }

      if (
        opportunity.status === 'pending_approval' ||
        opportunity.status === 'pending_execution'
      ) {
        await this.sendAdminReviewEmail(
          opportunity,
          liveMaterialReReview
            ? 'material edit of a live opportunity'
            : 'partner resubmission after rejection',
        );
      }
    }

    // CIEL PK admin editing their own listing: adding / changing the partner or faculty contact
    // must open the same gates create() would (token + email), otherwise the new stakeholder is
    // recorded but never asked to approve.
    if (isCielAdminOwner) {
      const partnerNow = this.resolvePartnerEmailFromOpportunity(opportunity);
      const facultyNow = this.getFacultyEmailFromOpportunity(opportunity);
      const adminEmail = this.normalizeEmail(user.email);
      const partnerChanged =
        this.normalizeEmail(rejectedResubmitSnapshot.partnerEmailBefore || '') !==
        this.normalizeEmail(partnerNow || '');
      const facultyChanged =
        this.normalizeEmail(facultyEmailBefore || '') !==
        this.normalizeEmail(facultyNow || '');
      if (partnerChanged || facultyChanged) {
        const requiresPartner =
          this.studentOpportunityRequiresPartner(
            opportunity as unknown as CreateOpportunityDto,
          ) && !!partnerNow;
        const requiresFaculty = !!facultyNow && facultyNow !== adminEmail;
        if (requiresPartner && !opportunity.partnerToken) {
          opportunity.partnerToken = randomUUID();
        } else if (requiresPartner && partnerChanged) {
          opportunity.partnerToken = randomUUID();
        }
        if (requiresFaculty && (facultyChanged || !opportunity.faculty_verification_token)) {
          opportunity.faculty_verification_token = randomUUID();
        }
        this.opportunityWorkflow.initCielAdminCreated(opportunity, {
          requiresPartner,
          requiresFaculty,
        });
        const saved = await this.opportunitiesRepository.save(opportunity);
        if (
          requiresFaculty &&
          (saved.status === 'pending_faculty' ||
            saved.workflowStage === WORKFLOW_STAGE.PENDING_FACULTY)
        ) {
          await this.notifyFacultyForStudentOpportunityVerification(saved);
        } else if (
          requiresPartner &&
          partnerNow &&
          saved.partnerToken &&
          saved.workflowStage === WORKFLOW_STAGE.PENDING_PARTNER
        ) {
          try {
            await this.mailService.sendPartnerVerification(
              partnerNow,
              saved.title,
              saved.partnerToken,
              this.buildOpportunityVerificationEmailDetails(saved, {
                facultyAuthorName: resolveDisplayNameForProfile(user),
                facultyAuthorEmail: user.email || undefined,
              }),
              {
                path: '/verify/partner',
                returnTo: this.getPartnerApprovalReturnTo(saved.id),
              },
            );
          } catch (e) {
            console.warn(
              'Failed to send partner verification after admin edit',
              (e as Error).message,
            );
          }
        }
        return saved;
      }
    }

    const savedOpportunity = await this.opportunitiesRepository.save(opportunity);
    if (notifyFacultyAfterOrgResubmit) {
      await this.notifyFacultyForStudentOpportunityVerification(savedOpportunity);
    }
    if (notifyPartnerAfterOrgResubmit) {
      // sendPartnerApprovalEmail swallows mail errors (returns false) — a flaky SMTP never
      // fails the creator's save.
      await this.sendPartnerApprovalEmail(
        savedOpportunity,
        `The organization updated <strong>${this.escHtml(savedOpportunity.title)}</strong> after your earlier feedback and it needs your review again. ` +
          'Please review the partner execution scope to continue this opportunity in CIEL.',
      );
    }
    return savedOpportunity;
  }

  /**
   * Faculty dashboard: opportunities this user created, is linked as `facultyId`,
   * is listed on supervision / partner_organization official_email, or appears on an application
   * as primary/secondary faculty email (verifier flow).
   */
  async findMineForFaculty(
    userId: string,
    options?: { authoredOnly?: boolean },
  ) {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new ForbiddenException('User not found');
    }
    if (user.role !== UserRole.FACULTY) {
      throw new ForbiddenException('Only faculty can access this list');
    }

    const email = this.normalizeEmail(user.email);
    const idSet = new Set<string>();

    if (options?.authoredOnly) {
      /** Faculty create sets `creatorId` to the faculty user (student posts use the student id). */
      const authored = await this.opportunitiesRepository
        .createQueryBuilder('o')
        .select('o.id')
        .where('("o"."creatorId")::text = :uid', { uid: userId })
        .getMany();
      for (const o of authored) {
        idSet.add(o.id);
      }
    } else {
      const ownedOrLinked = await this.opportunitiesRepository
        .createQueryBuilder('o')
        .select('o.id')
        // camelCase columns are quoted in DB; unquoted o.facultyId → facultyid (42703). Cast both as text for uuid/text param mix (42883).
        .where(
          '("o"."creatorId")::text = :uid OR ("o"."facultyId")::text = :uid',
          { uid: userId },
        )
        .getMany();
      for (const o of ownedOrLinked) {
        idSet.add(o.id);
      }
    }

    if (!options?.authoredOnly && email) {
      const appRepo = this.opportunitiesRepository.manager.getRepository(
        OpportunityApplication,
      );
      const appRows = await appRepo
        .createQueryBuilder('app')
        .select('app.opportunityId', 'opportunityId')
        .where(
          "(LOWER(TRIM(app.primaryFacultyEmail)) = :email OR LOWER(TRIM(COALESCE(app.secondaryFacultyEmail, ''))) = :email)",
          { email },
        )
        .getRawMany();
      for (const r of appRows) {
        const oid = (r as { opportunityId?: string }).opportunityId;
        if (oid) {
          idSet.add(oid);
        }
      }

      const supOrPartnerLinked = await this.opportunitiesRepository
        .createQueryBuilder('o')
        .select('o.id')
        .where(
          new Brackets((qb) => {
            qb.where(
              `LOWER(TRIM(COALESCE(o.supervision->>'contact', ''))) = :email`,
              { email },
            )
              .orWhere(
                `LOWER(TRIM(COALESCE(o.supervision->>'official_email', ''))) = :email`,
                {
                  email,
                },
              )
              .orWhere(
                `LOWER(TRIM(COALESCE(o.partner_organization->>'official_email', ''))) = :email`,
                {
                  email,
                },
              );
          }),
        )
        .getMany();
      for (const row of supOrPartnerLinked) {
        idSet.add(row.id);
      }
    }

    if (idSet.size === 0) {
      const empty: unknown[] = [];
      return { items: empty, opportunities: empty, rows: empty };
    }

    const rows = await this.opportunitiesRepository.find({
      where: { id: In([...idSet]) },
      relations: ['organization'],
      order: { createdAt: 'DESC' },
    });

    const items = await Promise.all(
      rows.map(async (opp) => {
        const occupiedSeats = await this.getOccupiedSeats(opp.id);
        const volunteersRequired = opp.timeline?.volunteers_required || 0;
        return {
          id: opp.id,
          _id: opp.id,
          opportunity_id: opp.id,
          title: opp.title,
          status: this.getApiOpportunityStatus(opp),
          requires_partner_approval: opp.requiresPartnerApproval,
          ...this.getWorkflowResponseFields(opp),
          created_at: opp.createdAt,
          mode: opp.mode,
          sdg: opp.sdg_info?.sdg_id || opp.sdg,
          applicants_count: occupiedSeats,
          remaining_seats: Math.max(0, volunteersRequired - occupiedSeats),
          volunteers_required: volunteersRequired,
          expected_hours: Number(opp.timeline?.expected_hours) || 0,
          organization_name: opp.organization?.name || null,
          partner_name:
            (typeof opp.partner_organization?.organization_name === 'string' &&
              opp.partner_organization.organization_name) ||
            (typeof opp.partner_organization?.name === 'string' &&
              opp.partner_organization.name) ||
            (typeof opp.external_partner_collaboration?.organization_name ===
              'string' &&
              opp.external_partner_collaboration.organization_name) ||
            null,
          // Lets the "Pending Partner" status line name the actual person, same contact
          // resolution used on the student "mine" list.
          partner_contact_name:
            (typeof opp.partner_organization?.contact_person === 'string' &&
              opp.partner_organization.contact_person.trim()) ||
            (typeof opp.partner_organization?.contact_person_name ===
              'string' &&
              opp.partner_organization.contact_person_name.trim()) ||
            (typeof opp.supervision?.partner_contact_person === 'string' &&
              opp.supervision.partner_contact_person.trim()) ||
            null,
          partner_contact_email: this.resolvePartnerEmailFromOpportunity(opp),
          admin_approved: opp.admin_approved === true,
          rejection_reason: opp.rejectionReason ?? null,
        };
      }),
    );

    return { items, opportunities: items, rows: items };
  }

  /** Student dashboard: opportunities this student created — powers "My Drafts" and the
   * Community Service Workspace approval-stage tracker. Optional `status` narrows to one status
   * (e.g. `draft`); omitted returns everything the student has created, newest first. */
  async findMineForStudent(userId: string, options?: { status?: string }) {
    const where: Record<string, unknown> = {
      creatorId: userId,
      isStudentCreated: true,
    };
    if (options?.status) {
      where.status = options.status;
    }
    const rows = await this.opportunitiesRepository.find({
      where: where as any,
      order: { updatedAt: 'DESC' },
    });

    const items = rows.map((opp) => {
      const sup =
        (opp.supervision as Record<string, unknown> | null | undefined) ??
        undefined;
      const po =
        (opp.partner_organization as
          | Record<string, unknown>
          | null
          | undefined) ?? undefined;
      const facultyName =
        (sup &&
          typeof sup.supervisor_name === 'string' &&
          sup.supervisor_name.trim()) ||
        null;
      const partnerName =
        (po &&
          typeof po.contact_person === 'string' &&
          po.contact_person.trim()) ||
        (po &&
          typeof po.contact_person_name === 'string' &&
          po.contact_person_name.trim()) ||
        (sup &&
          typeof sup.partner_contact_person === 'string' &&
          sup.partner_contact_person.trim()) ||
        null;
      return {
        id: opp.id,
        title: opp.title,
        status: this.getApiOpportunityStatus(opp),
        ...this.getWorkflowResponseFields(opp),
        requires_partner_approval: opp.requiresPartnerApproval,
        admin_approved: opp.admin_approved === true,
        rejection_reason: opp.rejectionReason ?? null,
        created_at: opp.createdAt,
        updated_at: opp.updatedAt,
        // Lets the student's reminder buttons address the actual pending approver by name/email
        // instead of an empty mailto: — same contact resolution used everywhere else on this entity.
        faculty_contact_name: facultyName,
        faculty_contact_email: this.getFacultyEmailFromOpportunity(opp),
        faculty_contact_phone: (() => {
          const w = sup?.whatsapp_e164;
          const f = sup?.faculty_whatsapp;
          if (typeof w === 'string' && w.trim()) return w.trim();
          if (typeof f === 'string' && f.trim()) return f.trim();
          return null;
        })(),
        partner_contact_name: partnerName,
        partner_contact_email: this.resolvePartnerEmailFromOpportunity(opp),
        partner_contact_phone: (() => {
          const a = sup?.partner_whatsapp_e164;
          const b = sup?.partner_phone;
          const c = po?.whatsapp;
          const d = po?.phone;
          for (const v of [a, b, c, d]) {
            if (typeof v === 'string' && v.trim()) return v.trim();
          }
          return null;
        })(),
      };
    });

    return { success: true, data: items };
  }

  /**
   * Lightweight save for a student's in-progress opportunity draft — deliberately skips the
   * strict validation `createStudentOpportunity` enforces (faculty email, safety declarations,
   * etc.) since a draft is by definition incomplete. Never sends verification emails. Creates a
   * new `status: 'draft'` row on first save (no `id`), then updates that same row on every
   * subsequent save so the student always resumes into one record, not duplicates.
   */
  async saveStudentOpportunityDraft(
    userId: string,
    id: string | null,
    dto: Record<string, unknown>,
  ) {
    return this.persistOpportunityDraft(userId, id, dto, { isStudentCreated: true });
  }

  /**
   * Faculty, partner, NGO, and university wizards. Same incomplete-save rules as the student
   * draft: no approval emails, status stays `draft`, and a later full create is what starts review.
   */
  async saveCreatorOpportunityDraft(
    userId: string,
    id: string | null,
    dto: Record<string, unknown> | CreateOpportunityDto | UpdateOpportunityDto,
  ) {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) throw new ForbiddenException('User not found');
    if (user.role === UserRole.STUDENT) {
      return this.saveStudentOpportunityDraft(userId, id, dto as Record<string, unknown>);
    }
    const org = await this.organizationsService.getMyOrganization(userId);
    const isFaculty = user.role === UserRole.FACULTY;
    return this.persistOpportunityDraft(userId, id, dto as Record<string, unknown>, {
      isStudentCreated: false,
      facultyId: isFaculty ? user.id : null,
      organizationId: org?.id ?? null,
    });
  }

  private async persistOpportunityDraft(
    userId: string,
    id: string | null,
    dto: Record<string, unknown>,
    ownership: {
      isStudentCreated: boolean;
      facultyId?: string | null;
      organizationId?: string | null;
    },
  ) {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) throw new ForbiddenException('User not found');

    const {
      draft: _draftFlag,
      id: _dtoId,
      ...rawFields
    } = dto as Record<string, unknown> & { draft?: unknown; id?: unknown };
    // `POST /student/opportunity/:id` hands the raw request body to this method (no DTO whitelist),
    // so a draft save must never be able to write approval / ownership / token columns.
    const fields = pickDraftPersistFields(
      stripServerControlledFields(rawFields) as Record<string, unknown>,
    );
    this.sanitizeAndBoundContent(fields as never);
    applyCanonicalPrivateCandidatePhone(fields, { required: false });
    const title =
      typeof fields.title === 'string' && fields.title.trim()
        ? fields.title.trim()
        : 'Untitled opportunity';
    const sdgFromInfo = (fields as { sdg_info?: { sdg_id?: string } }).sdg_info
      ?.sdg_id;
    const sdg =
      typeof sdgFromInfo === 'string' && sdgFromInfo.trim()
        ? sdgFromInfo.trim()
        : 'SDG';

    try {
      if (id) {
        const opportunity = await this.opportunitiesRepository.findOne({
          where: { id },
        });
        if (!opportunity) throw new NotFoundException('Draft not found');
        if (opportunity.creatorId !== userId) {
          throw new ForbiddenException('You do not have access to this draft');
        }
        // Draft-saving only applies while the record is still a draft — otherwise a
        // `{draft:true}` call would silently demote a submitted/approved/live opportunity
        // back to draft and pull it off Browse.
        if (String(opportunity.status || '').toLowerCase() !== 'draft') {
          throw new BadRequestException(
            'This opportunity has already been submitted and can no longer be saved as a draft',
          );
        }
        Object.assign(opportunity, fields, {
          title,
          status: 'draft',
          sdg: opportunity.sdg || sdg,
        });
        const saved = await this.opportunitiesRepository.save(opportunity);
        return { success: true, data: saved };
      }

      const payload: DeepPartial<Opportunity> = {
        ...fields,
        title,
        creatorId: user.id,
        status: 'draft',
        isStudentCreated: ownership.isStudentCreated,
        visibility: 'restricted',
        ...(ownership.facultyId !== undefined
          ? { facultyId: ownership.facultyId }
          : {}),
        ...(ownership.organizationId !== undefined
          ? { organizationId: ownership.organizationId }
          : {}),
        // `sdg` is a required (NOT NULL, no default) column kept for backward compatibility, but the
        // wizard only ever sends the SDG selection nested under `sdg_info.sdg_id` — never a top-level
        // `sdg` field — and a draft is saved long before the creator reaches that step. Without this
        // fallback the very first "Save Draft" click fails outright with a NOT NULL violation, since
        // `fields` never carries a `sdg` key at all. Mirrors the same fallback `createStudentOpportunity`
        // already applies for a full submit.
        sdg,
      };
      const opportunity = this.opportunitiesRepository.create(payload);
      const saved = await this.opportunitiesRepository.save(opportunity);
      return { success: true, data: saved };
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException ||
        error instanceof ForbiddenException
      ) {
        throw error;
      }
      const detail =
        error instanceof QueryFailedError
          ? this.extractQueryFailedDetail(error)
          : error instanceof Error
            ? error.message
            : '';
      throw new BadRequestException(
        detail
          ? `Could not save this draft (${detail})`
          : 'Could not save this draft',
      );
    }
  }

  async findAll(userId: string, filters: any) {
    const org = await this.organizationsService.getMyOrganization(userId);
    const query =
      this.opportunitiesRepository.createQueryBuilder('opportunity');

    if (filters?.created_by === 'me' || filters?.creator_id === 'me') {
      query.andWhere('("opportunity"."creatorId")::text = :creatorMe', {
        creatorMe: userId,
      });
    }

    // An unscoped list (no `partner_id`, not `created_by=me`) is a directory browse. Only CIEL PK
    // admin may see the whole pipeline; everyone else gets the same set the public directory
    // exposes — otherwise any signed-in user (a student, say) could enumerate other people's
    // drafts, pending and rejected submissions.
    const isScopedList =
      filters?.created_by === 'me' ||
      filters?.creator_id === 'me' ||
      !!filters?.partner_id;
    let redactContacts = false;
    if (!isScopedList) {
      const requester = await this.usersRepository.findOne({
        where: { id: userId },
        select: ['id', 'role'],
      });
      if (requester?.role !== UserRole.SUPER_ADMIN) {
        redactContacts = true;
        query
          .andWhere('opportunity.admin_approved = :liveApproved', {
            liveApproved: true,
          })
          .andWhere("LOWER(COALESCE(opportunity.status, '')) <> :draftOnly", {
            draftOnly: 'draft',
          })
          .andWhere(
            '(opportunity.status IN (:...liveStatuses) OR opportunity.workflowStage = :liveStage)',
            {
              liveStatuses: this.publicLiveStatuses,
              liveStage: WORKFLOW_STAGE.LIVE,
            },
          );
      }
    }

    let filterOrgId: string | null = null;
    // Email-based fallback for student-created opportunities that list this partner's email
    // in JSON fields but may not yet have the partner's organizationId set.
    let filterPartnerEmail: string | null = null;

    if (filters.partner_id === 'me') {
      if (org) filterOrgId = org.id;
      // Resolve requesting user's email for the email-based OR match
      const meUser = await this.usersRepository.findOne({
        where: { id: userId },
        select: ['email'],
      });
      const candidate = (meUser?.email || '').trim().toLowerCase();
      filterPartnerEmail = candidate || null;
    } else if (filters.partner_id && filters.partner_id !== 'me') {
      let resolvedOrgId: string | null = null;
      // Check if it's already an org ID
      try {
        const checkOrg = await this.organizationsService.findOne(
          filters.partner_id,
        );
        resolvedOrgId = checkOrg.id;
      } catch (e) {
        // Not an org ID, maybe it's a User ID?
        const checkUserOrg = await this.organizationsService.getMyOrganization(
          filters.partner_id,
        );
        if (checkUserOrg) {
          resolvedOrgId = checkUserOrg.id;
        }
      }

      if (resolvedOrgId) {
        // An explicit partner_id may only ever resolve to the caller's own organisation —
        // otherwise it enumerates another organisation's opportunities.
        const requester = await this.usersRepository.findOne({
          where: { id: userId },
          select: ['id', 'role'],
        });
        const isAdminCaller = requester?.role === UserRole.SUPER_ADMIN;
        const ownsResolvedOrg = !!org && org.id === resolvedOrgId;
        if (!isAdminCaller && !ownsResolvedOrg) {
          throw new ForbiddenException(
            "You are not allowed to list another organisation's opportunities",
          );
        }
        filterOrgId = resolvedOrgId;
      } else {
        // partner_id was explicitly provided but didn't resolve to any real org/user —
        // never silently fall through to an unfiltered, unscoped listing.
        throw new NotFoundException(
          'Organisation not found for the given partner_id',
        );
      }
    }

    /** Never return the full catalogue when explicitly scoped as this partner (`me`) but we could not resolve org or email. */
    if (filters.partner_id === 'me' && !filterOrgId && !filterPartnerEmail) {
      return [];
    }

    const useUniversityScope =
      filters.partner_id === 'me' &&
      org &&
      this.facultyUniversityScope.isUniversityOrganization(org);

    const orgNameNorm = org?.name
      ? this.facultyUniversityScope.normalizeOrgName(org.name)
      : '';
    const matchNamedOrg = orgNameNorm.length >= 3;
    const namedOrgSql = this.partnerOrgNameMatchSql();
    const namedOrgParams = matchNamedOrg
      ? this.partnerOrgNameMatchParams(orgNameNorm)
      : {};

    /** Partner / executing-organization contact emails — the same identities the detail read and
     * the approve / confirm actions accept (see collectPartnerContactEmails). */
    const contactEmailSql = [
      `opportunity.external_partner_collaboration->>'official_email'`,
      `opportunity.supervision->>'external_partner_email'`,
      `opportunity.supervision->>'partner_email'`,
      `opportunity.executing_context->'partner'->>'official_email'`,
      `opportunity.partner_organization->>'official_email'`,
      `opportunity.executing_organization->>'official_email'`,
    ]
      .map((expr) => `LOWER(TRIM(COALESCE(${expr}, ''))) = :pe`)
      .join(' OR ');

    if (useUniversityScope) {
      const uniIds =
        await this.facultyUniversityScope.resolveOpportunityIdsForUniversityOrganization(
          org.id,
        );
      // A university login can ALSO be named as the partner / executing contact by email.
      const uniParts: string[] = [];
      const uniParams: Record<string, unknown> = {};
      if (uniIds.length) {
        uniParts.push('opportunity.id IN (:...uniIds)');
        uniParams.uniIds = uniIds;
      }
      if (matchNamedOrg) {
        uniParts.push(namedOrgSql);
        Object.assign(uniParams, namedOrgParams);
      }
      if (filterPartnerEmail) {
        uniParts.push(`(${contactEmailSql})`);
        uniParams.pe = filterPartnerEmail;
      }
      if (!uniParts.length) return [];
      query.andWhere(`(${uniParts.join(' OR ')})`, uniParams);
    } else if (filterOrgId && filterPartnerEmail) {
      // Org-owned rows, student rows that name this login email, or student rows that name this organisation.
      query.andWhere(
        `(opportunity."organizationId" = :orgId` +
          ` OR ${contactEmailSql}` +
          (matchNamedOrg ? ` OR ${namedOrgSql}` : '') +
          `)`,
        {
          orgId: filterOrgId,
          pe: filterPartnerEmail,
          ...namedOrgParams,
        },
      );
    } else if (filterOrgId) {
      query.andWhere(
        `(opportunity."organizationId" = :orgId` +
          (matchNamedOrg ? ` OR ${namedOrgSql}` : '') +
          `)`,
        {
          orgId: filterOrgId,
          ...namedOrgParams,
        },
      );
    } else if (filterPartnerEmail) {
      query.andWhere(
        `(${contactEmailSql}` +
          (matchNamedOrg ? ` OR ${namedOrgSql}` : '') +
          `)`,
        {
          pe: filterPartnerEmail,
          ...namedOrgParams,
        },
      );
    }

    if (filters.status) {
      query.andWhere('opportunity.status = :status', {
        status: filters.status,
      });
    }

    if (filters.limit) {
      query.take(filters.limit);
    }

    const opportunities = await query.getMany();

    const rows = await Promise.all(
      opportunities.map(async (opp) => {
        const occupiedSeats = await this.getOccupiedSeats(opp.id);
        const volunteersRequired = opp.timeline?.volunteers_required || 0;
        const orgFallback = !opp.organizationId
          ? await this.getFacultyOrgFallback(opp.facultyId)
          : null;
        // Partner queues: tell the UI which of the listed rows THIS login may actually review /
        // manage, using the very same identity rules the actions enforce.
        const viewerAccess =
          filters?.partner_id === 'me'
            ? {
                is_org_owner:
                  !!org && !!opp.organizationId && opp.organizationId === org.id,
                can_partner_review: await this.partnerReviewIdentityMatches(
                  opp,
                  filterPartnerEmail || '',
                  org?.id ?? null,
                  userId,
                  org?.name ? [org.name] : [],
                ),
                is_executing_contact:
                  !!filterPartnerEmail &&
                  this.collectExecutingOrgEmails(opp).includes(
                    filterPartnerEmail,
                  ),
              }
            : undefined;

        return {
          ...opp,
          ...(viewerAccess ? { viewer_access: viewerAccess } : {}),
          status: this.getApiOpportunityStatus(opp),
          requires_partner_approval: opp.requiresPartnerApproval,
          location: opp.location,
          start_date: opp.timeline?.start_date,
          end_date: opp.timeline?.end_date,
          from_time: opp.timeline?.from_time,
          to_time: opp.timeline?.to_time,
          dates: opp.timeline ? { end: opp.timeline.end_date } : null,
          capacity: opp.timeline
            ? {
                volunteers: volunteersRequired,
                remaining_seats: Math.max(
                  0,
                  volunteersRequired - occupiedSeats,
                ),
              }
            : null,
          applicants_count: occupiedSeats,
          participation_scope: opp.participation_scope,
          executing_context: opp.executing_context,
          executing_organization: opp.executing_organization,
          partner_organization: opp.partner_organization,
          safety_supervision_declaration: opp.safety_supervision_declaration,
          safety_declaration: opp.safety_declaration,
          visibility_and_academic_linkage: opp.visibility_and_academic_linkage,
          submission_confirmations: opp.submission_confirmations,
          external_partner_collaboration: opp.external_partner_collaboration,
          academic_linkage: opp.academic_linkage,
          organization: opp.organization || orgFallback,
          ...this.getWorkflowResponseFields(opp),
        };
      }),
    );
    return redactContacts ? redactOpportunityContactDetails(rows) : rows;
  }

  async getPublicOpportunities(filters: any = {}) {
    // Admin-approved opportunities that are "live" for students: either legacy status in the
    // public set, or workflow live (legacy faculty flow can keep status `pending_execution` until
    // executing org verifies — same rows already surface as live in authenticated APIs).
    const orgFilter: { organizationId?: string } = {};
    if (filters.partner_id) {
      let filterOrgId = filters.partner_id;
      const checkUserOrg = await this.organizationsService.getMyOrganization(
        filters.partner_id,
      );
      if (checkUserOrg) {
        filterOrgId = checkUserOrg.id;
      }
      orgFilter.organizationId = filterOrgId;
    }

    const opportunities = await this.opportunitiesRepository.find({
      where: [
        {
          admin_approved: true,
          status: In(this.publicLiveStatuses),
          ...orgFilter,
        },
        {
          admin_approved: true,
          workflowStage: WORKFLOW_STAGE.LIVE,
          ...orgFilter,
        },
      ],
      relations: ['organization'],
      order: { createdAt: 'DESC' },
    });
    const visibleOpportunities = opportunities.filter((opp) =>
      this.isPubliclyVisibleOpportunity(opp),
    );

    // We need to count participants for each opportunity
    const opportunitiesWithCounts = await Promise.all(
      visibleOpportunities.map(async (opp) => {
        const occupiedSeats = await this.getOccupiedSeats(opp.id);
        const orgFallback = !opp.organizationId
          ? await this.getFacultyOrgFallback(opp.facultyId)
          : null;
        return this.buildPublicOpportunityPayload(
          opp,
          occupiedSeats,
          orgFallback,
        );
      }),
    );

    // Anonymous directory: never expose supervisor / partner contact details.
    return redactOpportunityContactDetails(opportunitiesWithCounts);
  }

  async getPublicOpportunityById(id: string) {
    const trimmed = (id || '').trim();
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        trimmed,
      )
    ) {
      throw new NotFoundException('Opportunity not found or not public');
    }
    const opp = await this.opportunitiesRepository.findOne({
      where: [
        {
          id: trimmed,
          admin_approved: true,
          status: In(this.publicLiveStatuses),
        },
        {
          id: trimmed,
          admin_approved: true,
          workflowStage: WORKFLOW_STAGE.LIVE,
        },
      ],
      relations: ['organization'],
    });

    if (!opp) {
      throw new NotFoundException('Opportunity not found or not public');
    }
    if (!this.isPubliclyVisibleOpportunity(opp)) {
      throw new NotFoundException('Opportunity not found or not public');
    }

    const occupiedSeats = await this.getOccupiedSeats(opp.id);
    const orgFallback = !opp.organizationId
      ? await this.getFacultyOrgFallback(opp.facultyId)
      : null;
    return redactOpportunityContactDetails(
      this.buildPublicOpportunityPayload(opp, occupiedSeats, orgFallback, true),
    );
  }

  async findOne(id: string) {
    return this.opportunitiesRepository.findOne({
      where: { id },
      relations: ['organization'],
    });
  }

  /**
   * True when the viewer is the owner/admin or a designated reviewer (assigned faculty, supervision
   * or partner contact email, owning partner org) — i.e. may see the record in ANY workflow status
   * together with the creator's contact details. Mirrors the identity rules already used by
   * `assertFacultySupervisorForStudentOpportunity` / `assertPartnerCanReviewOpportunity`, minus the
   * status assertions (this is read access, not an approval action).
   */
  private async isPrivilegedOpportunityViewer(
    opp: Opportunity,
    viewer: OpportunityDetailViewer,
  ): Promise<boolean> {
    if (!viewer) return false;
    if (viewer.role === UserRole.SUPER_ADMIN) return true;
    if (
      viewer.id &&
      opp.creatorId &&
      String(opp.creatorId) === String(viewer.id)
    )
      return true;
    if (
      viewer.id &&
      opp.facultyId &&
      String(opp.facultyId) === String(viewer.id)
    )
      return true;
    if (
      viewer.organizationId &&
      opp.organizationId &&
      viewer.organizationId === opp.organizationId
    ) {
      return true;
    }

    if (
      viewer.role === UserRole.FACULTY &&
      (await this.isDelegatedFacultyForOpportunity(opp.id, viewer.id))
    ) {
      return true;
    }

    const email = this.normalizeEmail(viewer.email);
    if (!email) return false;

    // Every reviewer identity the lists match on: supervisor / faculty-link emails, ALL partner
    // contact emails, and the executing-organization contact (who must open the record to confirm).
    const candidates = [
      ...this.collectFacultyReviewerEmails(opp),
      ...this.collectPartnerContactEmails(opp),
      ...this.collectExecutingOrgEmails(opp),
    ];
    if (candidates.includes(email)) return true;

    if (
      await this.namedPartnerOrgMatches(
        opp,
        viewer.organizationId,
        viewer.id,
      )
    ) {
      return true;
    }

    // Faculty reviewing join applications are linked through the application, not the opportunity.
    const appRepo = this.opportunitiesRepository.manager.getRepository(
      OpportunityApplication,
    );
    const linkedApplications = await appRepo
      .createQueryBuilder('app')
      .where('app.opportunityId = :oid', { oid: opp.id })
      .andWhere(
        "(LOWER(TRIM(COALESCE(app.primaryFacultyEmail, ''))) = :email OR LOWER(TRIM(COALESCE(app.secondaryFacultyEmail, ''))) = :email)",
        { email },
      )
      .getCount();
    return linkedApplications > 0;
  }

  /** Mirror of the edit gate in `update()` (owner shortcuts, else same organisation). */
  private viewerMayEditOpportunity(
    opp: Opportunity,
    viewer: OpportunityDetailViewer,
  ): boolean {
    if (!viewer?.id) return false;
    const isOwner = !!opp.creatorId && String(opp.creatorId) === String(viewer.id);
    if (viewer.role === UserRole.FACULTY) {
      if (isOwner && (opp.facultyId === viewer.id || opp.facultyId == null))
        return true;
    }
    if (isOwner && opp.isStudentCreated) return true;
    if (isOwner && viewer.role === UserRole.SUPER_ADMIN) return true;
    return (
      !!viewer.organizationId &&
      !!opp.organizationId &&
      viewer.organizationId === opp.organizationId
    );
  }

  /** True when the viewer's organisation is a university whose dashboard scope contains the record. */
  private async isInViewerUniversityScope(
    opportunityId: string,
    viewer: OpportunityDetailViewer,
  ): Promise<boolean> {
    if (!viewer?.organizationId) return false;
    let org: { id: string; orgType?: string | null } | null = null;
    try {
      org = await this.organizationsService.findOne(viewer.organizationId);
    } catch {
      return false;
    }
    if (!org || !this.facultyUniversityScope.isUniversityOrganization(org as any))
      return false;
    const ids =
      await this.facultyUniversityScope.resolveOpportunityIdsForUniversityOrganization(
        org.id,
      );
    return ids.includes(opportunityId);
  }

  /**
   * THE visibility rule for reading one opportunity by id (shared by `POST /opportunities/detail`
   * and `GET /student/projects/:id`): privileged reviewer/owner/admin, else public-live, else a
   * project the viewer joined / applied to / sees through university scope. Anything else -> 404.
   * Returns whether the viewer is privileged (may see contact details).
   */
  async assertViewerMayOpenOpportunity(
    opportunity: Opportunity,
    viewer: OpportunityDetailViewer,
  ): Promise<{ privileged: boolean }> {
    const privileged = await this.isPrivilegedOpportunityViewer(
      opportunity,
      viewer,
    );

    if (!privileged) {
      const isPublic =
        opportunity.admin_approved === true &&
        (this.publicLiveStatuses.includes(opportunity.status) ||
          opportunity.workflowStage === WORKFLOW_STAGE.LIVE) &&
        this.isPubliclyVisibleOpportunity(opportunity);

      // Students keep access to projects they actually joined even once those leave the public
      // directory (completed/closed) — My Projects reads this same endpoint.
      const isParticipant = viewer?.id
        ? (await this.participationRepository.count({
            where: { projectId: opportunity.id, studentId: viewer.id },
          })) > 0
        : false;

      // A student's own pending join request is listed on My Projects too (pipeline-only rows),
      // so it must stay openable after the listing leaves the public directory.
      const hasOwnApplication =
        !isPublic && !isParticipant && viewer?.id
          ? (await this.opportunitiesRepository.manager
              .getRepository(OpportunityApplication)
              .count({
                where: {
                  opportunityId: opportunity.id,
                  studentUserId: viewer.id,
                  withdrawnAt: IsNull(),
                },
              })) > 0
          : false;

      // University dashboards list every opportunity in the university's scope (its students'
      // listings, participations and applications). They may open those records — contact details
      // stay redacted like any non-reviewer, and no action is granted.
      const inUniversityScope =
        !isPublic && !isParticipant && !hasOwnApplication
          ? await this.isInViewerUniversityScope(opportunity.id, viewer)
          : false;

      if (!isPublic && !isParticipant && !hasOwnApplication && !inUniversityScope) {
        throw new NotFoundException('Opportunity not found');
      }
    }
    return { privileged };
  }

  /**
   * `POST /opportunities/detail`. Full record + creator contact for the owner/admin/designated
   * reviewer; drafts and other non-public records are hidden from everyone else, and a plain
   * authenticated browser of a live opportunity gets the record without the creator's email/phone.
   */
  async findOneWithCreator(id: string, viewer: OpportunityDetailViewer) {
    const opportunity = await this.findOne(id);
    if (!opportunity) return null;

    const { privileged } = await this.assertViewerMayOpenOpportunity(
      opportunity,
      viewer,
    );

    const creator = opportunity.creatorId
      ? await this.usersRepository.findOne({
          where: { id: opportunity.creatorId },
          select: ['id', 'name', 'email', 'phone'],
        })
      : null;

    const result = {
      ...opportunity,
      creator: creator
        ? {
            id: creator.id,
            name: creator.name,
            // Creator PII is owner/reviewer/admin only.
            email: privileged ? creator.email : null,
            phone: privileged ? (creator.phone ?? null) : null,
          }
        : null,
      // What THIS viewer may actually do with the record, so the UI never offers a button the
      // API would refuse (e.g. "Edit" to an executing-org contact or a university observer).
      viewer_access: { can_edit: this.viewerMayEditOpportunity(opportunity, viewer) },
    };
    // Supervisor / partner / executing-org contact details are for the owner, designated
    // reviewers and admin only — a plain viewer of a live opportunity does not get them.
    return privileged ? result : redactOpportunityContactDetails(result);
  }

  // Admin methods
  /** Admin approvals UI queue filter (`GET /admin/opportunities/approval-queue?queue=`). */
  private adminPendingQueueWhere(): Brackets {
    return new Brackets((qb) => {
      qb.where(
        new Brackets((inner) => {
          inner
            .where('opportunity.status = :st', { st: 'pending_approval' })
            .andWhere(
              '(opportunity.admin_approved = :aa OR opportunity.admin_approved IS NULL)',
              { aa: false },
            );
        }),
      )
        .orWhere(
          new Brackets((inner) => {
            inner
              .where('opportunity.isStudentCreated = :isc', { isc: true })
              .andWhere(
                '(opportunity.admin_approved = :aa OR opportunity.admin_approved IS NULL)',
                { aa: false },
              )
              .andWhere('opportunity.status IN (:...early)', {
                early: [
                  'pending_faculty',
                  'pending_partner',
                  'pending_verification',
                ],
              });
          }),
        )
        .orWhere(
          new Brackets((inner) => {
            inner
              .where('opportunity.isStudentCreated = :isc2', { isc2: false })
              .andWhere(
                '(opportunity.admin_approved = :aa2 OR opportunity.admin_approved IS NULL)',
                { aa2: false },
              )
              .andWhere(
                '(opportunity.adminApprovalStatus IS NULL OR opportunity.adminApprovalStatus NOT IN (:...cielSelfApproved))',
                {
                  cielSelfApproved: [
                    LINE_STATUS.APPROVED,
                    LINE_STATUS.NOT_REQUIRED,
                  ],
                },
              )
              .andWhere('opportunity.status IN (:...partnerOrg)', {
                partnerOrg: ['pending_execution', 'pending_partner'],
              });
          }),
        );
    });
  }

  private normalizeAdminApprovalQueue(
    queue?: string,
  ): 'pending' | 'approved' | 'rejected' | 'revision' | 'draft' | 'all' {
    const q = (queue || 'pending').trim().toLowerCase();
    if (q === 'approved' || q === 'live') return 'approved';
    if (q === 'rejected') return 'rejected';
    if (q === 'revision' || q === 'revise') return 'revision';
    if (q === 'draft' || q === 'drafts') return 'draft';
    if (q === 'all') return 'all';
    return 'pending';
  }

  async findAdminApprovalQueue(queue?: string, limit = 500) {
    const normalizedQueue = this.normalizeAdminApprovalQueue(queue);
    const take = Math.min(Math.max(Number(limit) || 500, 1), 500);

    const qb = this.opportunitiesRepository
      .createQueryBuilder('opportunity')
      .leftJoinAndSelect('opportunity.organization', 'organization');

    if (normalizedQueue === 'pending') {
      qb.where(this.adminPendingQueueWhere());
    } else if (normalizedQueue === 'approved') {
      qb.where('opportunity.admin_approved = :aa', { aa: true }).andWhere(
        'opportunity.workflowStage = :live',
        { live: WORKFLOW_STAGE.LIVE },
      );
    } else if (normalizedQueue === 'rejected') {
      qb.where('opportunity.workflowStage = :rej', {
        rej: WORKFLOW_STAGE.REJECTED,
      });
    } else if (normalizedQueue === 'revision') {
      qb.where('opportunity.workflowStage = :rev', {
        rev: WORKFLOW_STAGE.REVISION,
      });
    } else if (normalizedQueue === 'draft') {
      qb.where("LOWER(COALESCE(opportunity.status, '')) = :draftSt", {
        draftSt: 'draft',
      });
    } else {
      qb.where(
        new Brackets((outer) => {
          outer
            .where(this.adminPendingQueueWhere())
            .orWhere(
              new Brackets((inner) => {
                inner
                  .where('opportunity.admin_approved = :aaAll', { aaAll: true })
                  .andWhere('opportunity.workflowStage = :liveAll', {
                    liveAll: WORKFLOW_STAGE.LIVE,
                  });
              }),
            )
            .orWhere('opportunity.workflowStage = :rejAll', {
              rejAll: WORKFLOW_STAGE.REJECTED,
            })
            .orWhere('opportunity.workflowStage = :revAll', {
              revAll: WORKFLOW_STAGE.REVISION,
            })
            .orWhere("LOWER(COALESCE(opportunity.status, '')) = :draftAll", {
              draftAll: 'draft',
            });
        }),
      );
    }

    const opportunities = await qb
      .orderBy('opportunity.updatedAt', 'DESC')
      .addOrderBy('opportunity.createdAt', 'DESC')
      .take(take)
      .getMany();

    return this.mapOpportunitiesForAdminQueue(opportunities);
  }

  async findAllPending() {
    return this.findAdminApprovalQueue('pending', 500);
  }

  private async mapOpportunitiesForAdminQueue(opportunities: Opportunity[]) {
    const creatorIds = [
      ...new Set(opportunities.map((o) => o.creatorId).filter(Boolean)),
    ] as string[];
    const creators =
      creatorIds.length > 0
        ? await this.usersRepository.find({
            where: { id: In(creatorIds) },
            select: [
              'id',
              'name',
              'email',
              'phone',
              'university',
              'institution',
              'department',
              'major',
              'city',
              'registrationNumber',
            ],
          })
        : [];
    const creatorById = new Map(creators.map((c) => [c.id, c]));

    return Promise.all(
      opportunities.map(async (opp) => {
        const occupiedSeats = await this.getOccupiedSeats(opp.id);
        const volunteersRequired = opp.timeline?.volunteers_required || 0;
        const orgFallback = !opp.organizationId
          ? await this.getFacultyOrgFallback(opp.facultyId)
          : null;
        const creator = opp.creatorId
          ? (creatorById.get(opp.creatorId) ?? null)
          : null;

        const {
          faculty_verification_token: _ft,
          partnerToken: _pt,
          liaisonToken: _lt,
          execution_verification_token: _et,
          ...oppRest
        } = opp;

        const { flow_status, admin_can_approve } =
          this.describeAdminQueueFlow(opp);

        return {
          ...oppRest,
          status: this.getApiOpportunityStatus(opp),
          start_date: opp.timeline?.start_date,
          end_date: opp.timeline?.end_date,
          from_time: opp.timeline?.from_time,
          to_time: opp.timeline?.to_time,
          remaining_seats: Math.max(0, volunteersRequired - occupiedSeats),
          participant_count: occupiedSeats,
          participation_scope: opp.participation_scope,
          supervision: opp.supervision,
          executing_context: opp.executing_context,
          executing_organization: opp.executing_organization,
          partner_organization: opp.partner_organization,
          safety_supervision_declaration: opp.safety_supervision_declaration,
          safety_declaration: opp.safety_declaration,
          visibility_and_academic_linkage: opp.visibility_and_academic_linkage,
          submission_confirmations: opp.submission_confirmations,
          external_partner_collaboration: opp.external_partner_collaboration,
          academic_linkage: opp.academic_linkage,
          execution_verified: opp.execution_verified,
          admin_approved: opp.admin_approved,
          ...this.getWorkflowResponseFields(opp),
          flow_status,
          admin_can_approve,
          is_student_created: opp.isStudentCreated,
          organization: opp.organization || orgFallback,
          creator: creator
            ? {
                id: creator.id,
                name: creator.name,
                email: creator.email,
                phone: creator.phone,
                university: creator.university,
                institution: creator.institution,
                department: creator.department,
                major: creator.major,
                city: creator.city,
                registration_number: creator.registrationNumber,
              }
            : null,
        };
      }),
    );
  }

  /**
   * Exceptional reopen of the 60-day reporting window (Faculty / CIEL PK Admin).
   * Sets timeline.reporting_window_reopened_until (inclusive).
   */
  async reopenReportingWindow(id: string, until: string) {
    const opp = await this.findOne(id);
    if (!opp) throw new NotFoundException('Opportunity not found');
    const untilDay = toDateOnlyString(until);
    if (!untilDay) {
      throw new BadRequestException(
        'Provide reporting_window_reopened_until as YYYY-MM-DD.',
      );
    }
    const end = getProjectEndDate(opp.timeline);
    if (!end) {
      throw new BadRequestException(
        'This opportunity has no project end date — set project dates before reopening reporting.',
      );
    }
    const defaultClose = addDaysToDateOnly(end, REPORTING_WINDOW_DAYS);
    if (defaultClose && compareDateOnly(untilDay, defaultClose) < 0) {
      throw new BadRequestException(
        `Reopen date must be on or after the default reporting close date (${defaultClose}).`,
      );
    }
    const timeline = {
      ...asTimeline(opp.timeline),
      reporting_window_reopened_until: untilDay,
    };
    opp.timeline = timeline;
    return this.opportunitiesRepository.save(opp);
  }

  async approve(id: string, actor?: ApprovalActor) {
    const opp = await this.findOne(id);
    if (!opp) throw new NotFoundException('Opportunity not found');
    // Idempotent: repeated approve (double-click, retried request) must not re-run side effects / emails.
    if (
      opp.admin_approved === true &&
      opp.workflowStage === WORKFLOW_STAGE.LIVE
    ) {
      // Backfill legacy rows approved before status was set to active on admin approve.
      if (opp.status === 'pending_execution') {
        opp.status = 'active';
        return this.opportunitiesRepository.save(opp);
      }
      return opp;
    }
    if (!this.isOpportunityReadyForAdminFinalApprove(opp)) {
      throw new BadRequestException(
        'CIEL final approval is only available after faculty and partner steps (when applicable) are completed.',
      );
    }
    this.opportunityWorkflow.afterAdminApproved(opp, actor);
    const saved = await this.opportunitiesRepository.save(opp);
    await this.handleAdminApprovedSideEffects(saved);
    return saved;
  }

  /** Lightweight admin status toggle from the projects list dropdown — a raw `status` field set,
   * deliberately distinct from approve/reject/revise above (which encode the full admin-approval
   * workflow with its own preconditions, notifications and idempotency rules). */
  async setStatus(id: string, status: string) {
    // Going live for the first time / rejecting / requesting changes must use approve/reject/revise
    // so workflow fields stay consistent. `active` here is reopen/republish of an already-approved listing.
    const allowed = ['closed', 'draft', 'active'];
    if (!allowed.includes(status)) {
      throw new BadRequestException(
        `Invalid status. Must be one of: ${allowed.join(', ')}. Use approve, reject or revise to change the approval state.`,
      );
    }
    const opp = await this.findOne(id);
    if (!opp) throw new NotFoundException('Opportunity not found');
    if (opp.status === status) return opp;
    if (status === 'active') {
      return this.reopenApprovedListing(opp);
    }
    opp.status = status;
    // The approval trail (admin_approved / workflowStage) is deliberately untouched: closing an
    // approved listing is a lifecycle change, not an un-approval, and approve() stays idempotent.
    return this.opportunitiesRepository.save(opp);
  }

  /**
   * Super Admin reopen/republish: `closed` or `draft` → `active` without re-running
   * faculty/partner/admin approval. Rejected/revision rows stay on their own workflows.
   */
  private async reopenApprovedListing(opp: Opportunity) {
    const current = String(opp.status || '').toLowerCase();
    if (!['closed', 'draft'].includes(current)) {
      throw new BadRequestException(
        'Only a closed or draft listing can be reopened this way. Use Approve to publish a new listing.',
      );
    }
    if (opp.admin_approved !== true) {
      throw new BadRequestException(
        'This listing is not CIEL-approved yet. Use Approve to publish it.',
      );
    }
    if (
      opp.workflowStage === WORKFLOW_STAGE.REJECTED ||
      String(opp.status || '').toLowerCase() === 'rejected'
    ) {
      throw new BadRequestException(
        'A rejected opportunity cannot be reopened. The creator must submit a new listing.',
      );
    }
    if (opp.workflowStage === WORKFLOW_STAGE.REVISION) {
      throw new BadRequestException(
        'This listing is in revision. The creator must resubmit before it can go live.',
      );
    }
    opp.status = 'active';
    return this.opportunitiesRepository.save(opp);
  }

  /**
   * Super Admin directory controls. Distinct from Close (`status=closed`, drops from live lists)
   * and Draft (`status=draft`, unpublished). Hidden listings stay in admin + enrolled My Projects.
   * Expired listings stay on Explore/Browse with apply closed.
   * Deliberately stage-agnostic (unlike `reopenApprovedListing`, which gates on approval/stage):
   * hide/expire never changes `status`/`workflowStage`, so an admin can hide or expire a listing
   * regardless of where it sits in the approval pipeline without that being a workflow transition.
   */
  async setDirectoryControl(
    id: string,
    patch: { hidden?: boolean; expired?: boolean },
  ) {
    if (patch.hidden === undefined && patch.expired === undefined) {
      throw new BadRequestException('Provide hidden and/or expired.');
    }
    const opp = await this.findOne(id);
    if (!opp) throw new NotFoundException('Opportunity not found');
    if (patch.hidden !== undefined) opp.admin_hidden = patch.hidden === true;
    if (patch.expired !== undefined) opp.admin_expired = patch.expired === true;
    const saved = await this.opportunitiesRepository.save(opp);
    return {
      success: true,
      data: {
        id: saved.id,
        ...this.getDirectoryControlFields(saved),
      },
    };
  }

  async reject(id: string, rawReason: string, actor?: ApprovalActor) {
    const reason = this.requireDecisionReason(rawReason);
    const opp = await this.findOne(id);
    if (!opp) throw new NotFoundException('Opportunity not found');
    // Idempotent: repeated reject must not duplicate approval history or emails.
    if (opp.workflowStage === WORKFLOW_STAGE.REJECTED) return opp;
    this.opportunityWorkflow.afterAdminRejected(opp, reason, actor);
    const saved = await this.opportunitiesRepository.save(opp);
    // Faculty creators used to get no notification at all here, unlike revise() below — reject is
    // just as final for them as for a student creator, so they need to hear about it too.
    await this.notifyStudentOpportunityUpdate(saved, {
      title: 'Opportunity closed',
      message:
        'Your opportunity was permanently rejected during admin review and can no longer be edited.',
      emailSubject: 'Your opportunity was permanently rejected',
      reason,
    });
    return saved;
  }

  async revise(id: string, rawReason: string, actor?: ApprovalActor) {
    const reason = this.requireDecisionReason(rawReason);
    const opp = await this.findOne(id);
    if (!opp) throw new NotFoundException('Opportunity not found');
    if (opp.workflowStage === WORKFLOW_STAGE.REJECTED) {
      throw new BadRequestException(
        'This opportunity was permanently rejected and cannot be sent back for revision.',
      );
    }
    // Idempotent for a retried identical request.
    if (
      opp.workflowStage === WORKFLOW_STAGE.REVISION &&
      opp.adminApprovalStatus === LINE_STATUS.REVISION_REQUESTED &&
      (opp.rejectionReason ?? '') === reason
    ) {
      return opp;
    }
    this.opportunityWorkflow.afterAdminRevision(opp, reason, actor);
    const saved = await this.opportunitiesRepository.save(opp);
    await this.notifyStudentOpportunityUpdate(saved, {
      title: 'Revision requested',
      message:
        'CIEL admin asked you to update your opportunity. Open your dashboard, make the changes, and save to resubmit.',
      emailSubject: 'Please revise your opportunity',
      reason,
    });
    return saved;
  }

  /** Blocks a non-admin delete once anyone other than the requester has enrolled, applied or reported. */
  private async assertNoOtherStudentsDependOnOpportunity(
    opportunityId: string,
    requestingUserId: string,
  ) {
    const manager = this.opportunitiesRepository.manager;

    const participations = await this.participationRepository.find({
      where: { projectId: opportunityId },
    });
    const applications = await manager
      .getRepository(OpportunityApplication)
      .find({
        where: { opportunityId },
      });
    const reports = await manager.getRepository(StudentReport).find({
      where: [{ opportunityId }, { project_id: opportunityId }],
    });

    const foreign =
      participations.filter((p) => p.studentId !== requestingUserId).length +
      applications.filter((a) => a.studentUserId !== requestingUserId).length +
      reports.filter((r) => r.studentId !== requestingUserId).length;

    if (foreign > 0) {
      throw new BadRequestException(
        'Other students have already enrolled, applied or reported on this opportunity, so it can no longer be deleted. Ask CIEL PK admin to close or remove it instead.',
      );
    }
  }

  async remove(id: string, requestingUserId?: string) {
    const opportunity = await this.opportunitiesRepository.findOne({
      where: { id },
    });
    if (!opportunity) {
      throw new NotFoundException(`Opportunity with ID "${id}" not found`);
    }

    if (requestingUserId) {
      const requester = await this.usersRepository.findOne({
        where: { id: requestingUserId },
      });
      const isCreator = opportunity.creatorId === requestingUserId;
      const isAdmin = requester?.role === UserRole.SUPER_ADMIN;
      if (!isCreator && !isAdmin) {
        throw new ForbiddenException(
          'You do not have permission to delete this opportunity',
        );
      }
      // `deleteOpportunityChildren` cascades participations, attendance logs, applications and
      // student reports for EVERY student on the listing — not just the creator's own rows. A
      // student creator deleting their own listing must therefore never be able to wipe other
      // people's verified hours or submitted reports; only CIEL admin may force that.
      if (!isAdmin) {
        await this.assertNoOtherStudentsDependOnOpportunity(
          id,
          requestingUserId,
        );
      }
    }

    try {
      const deleted = await this.opportunitiesRepository.manager.transaction(
        async (manager) => {
          const deletedChildren = await this.deleteOpportunityChildren(
            manager,
            id,
          );
          const result = await manager.delete(Opportunity, { id });

          if ((result.affected ?? 0) === 0) {
            throw new NotFoundException(
              `Opportunity with ID "${id}" not found`,
            );
          }

          return deletedChildren;
        },
      );

      return {
        success: true,
        message: 'Opportunity deleted successfully',
        data: {
          id,
          deleted,
        },
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }

      if (
        error instanceof QueryFailedError ||
        (error instanceof Error &&
          /foreign key|constraint/i.test(error.message))
      ) {
        throw new ConflictException(
          this.buildOpportunityDeleteConflictMessage(id, error),
        );
      }

      throw error;
    }
  }

  // Partner methods for managing applicants
  async getApplicantsForOpportunity(
    opportunityId: string,
    organizationId: string,
  ) {
    const opportunity = await this.opportunitiesRepository.findOne({
      where: { id: opportunityId },
    });

    if (!opportunity) {
      throw new NotFoundException('Opportunity not found');
    }

    if (opportunity.organizationId !== organizationId) {
      throw new ForbiddenException(
        'You do not have access to this opportunity',
      );
    }

    const participants = await this.participationRepository.find({
      where: { projectId: opportunityId },
      relations: ['student'],
      order: { createdAt: 'DESC' },
    });

    // Group by Application ID to show team structure if needed, or just list everyone
    return await Promise.all(
      participants.map(async (p) => ({
        id: p.id,
        studentName: p.fullName || p.student?.name || 'Unknown',
        university: p.universityName || p.student?.institution || 'N/A',
        email: p.email || p.student?.email || 'N/A',
        status: p.status,
        appliedAt: p.createdAt,
        avatar: p.student?.avatar || null,
        participation_type: p.participationMode,
        isTeamLead: p.isTeamLead,
        teamMembers:
          p.isTeamLead && p.applicationId
            ? (
                await this.participationRepository.find({
                  where: { applicationId: p.applicationId, isTeamLead: false },
                })
              ).map((m) => ({
                id: m.id,
                name: m.fullName,
                email: m.email,
                university: m.universityName,
                role: 'Member',
                is_verified: true,
              }))
            : [],
      })),
    );
  }

  async getOrganizationParticipants(organizationId: string) {
    const participants = await this.participationRepository.find({
      where: {
        project: { organizationId },
        status: In(['accepted', 'approved', 'verified', 'finalized']),
      },
      relations: ['student', 'project'],
      order: { createdAt: 'DESC' },
    });

    return participants.map((p) => ({
      id: p.id,
      name: p.fullName || p.student?.name || 'Unknown student',
      opportunity: p.project?.title || 'Unknown Opportunity',
      joinedDate: p.createdAt.toLocaleDateString(),
      hours: 0,
      status:
        p.status === 'accepted'
          ? 'Active'
          : p.status === 'verified'
            ? 'Completed'
            : p.status,
      participation_type: p.participationMode,
      is_leader: p.isTeamLead,
    }));
  }

  async updateApplicantStatus(
    applicantId: string,
    status: string,
    organizationId: string,
  ) {
    const participant = await this.participationRepository.findOne({
      where: { id: applicantId },
      relations: ['project', 'student'],
    });

    if (!participant) {
      throw new NotFoundException('Applicant not found');
    }

    if (participant.project.organizationId !== organizationId) {
      throw new ForbiddenException('You do not have access to this applicant');
    }

    participant.status = status;
    await this.participationRepository.save(participant);

    return { success: true, message: 'Applicant status updated successfully' };
  }

  /**
   * Fully public read — no login, no identity check. The partner contact clicks the emailed link
   * before ever creating a CIEL account, so this must resolve strictly by `partnerToken` (never
   * the faculty/liaison tokens) and return only opportunity-summary data, never participant lists
   * or other students' information.
   */
  async getPublicPartnerVerificationPreview(rawToken: string) {
    const token = this.normalizeVerificationToken(rawToken);
    const opportunity = await this.opportunitiesRepository.findOne({
      where: { partnerToken: token },
    });
    if (!opportunity) {
      throw new NotFoundException('Invalid or expired verification link.');
    }
    this.assertVerificationLinkNotExpired(opportunity.partnerTokenExpiresAt);
    return {
      title: opportunity.title,
      alreadyVerified: !!opportunity.partnerVerified,
      // "Request revision" is only a valid action for student-created opportunities — see
      // afterPartnerRevision/decideOpportunityViaPartnerToken. Exposed so the public flashcard can
      // hide that button rather than let the reviewer hit a 400 after picking it.
      isStudentCreated: !!opportunity.isStudentCreated,
      detail: buildOpportunityDetailView(opportunity),
    };
  }

  /**
   * Public, token-scoped reject/revision — the anonymous partnerToken counterpart to
   * partnerDashboardReject/partnerDashboardRevise, for the same no-login "flashcard" flow that
   * verifyOpportunityToken's approve path already serves at /verify/partner. Possession of the
   * emailed partnerToken is the partner's credential here (same design as the existing approve
   * path) — there is no authenticated partner identity to run an email/org ownership check
   * against, so this only re-checks that the token still resolves and the opportunity isn't
   * already decided.
   */
  async decideOpportunityViaPartnerToken(
    rawToken: string,
    action: 'reject' | 'revision',
    rawReason?: string,
  ) {
    const token = this.normalizeVerificationToken(rawToken);
    const reason = this.normalizeDecisionReason(rawReason);
    if (action !== 'reject' && action !== 'revision') {
      throw new BadRequestException('action must be "reject" or "revision"');
    }
    const opportunity = await this.opportunitiesRepository.findOne({
      where: { partnerToken: token },
    });
    if (!opportunity) {
      throw new NotFoundException('Invalid or expired verification link.');
    }
    this.assertVerificationLinkNotExpired(opportunity.partnerTokenExpiresAt);
    if (opportunity.partnerVerified) {
      throw new BadRequestException(
        'This opportunity was already verified via this link.',
      );
    }
    // `partnerVerified` only guards the approve path — a rejection also leaves it `false`, so a
    // stale/replayed link could otherwise resurrect an already permanently-closed opportunity.
    if (
      opportunity.workflowStage === WORKFLOW_STAGE.REJECTED ||
      opportunity.status === 'rejected'
    ) {
      throw new BadRequestException(
        'This opportunity has already been closed and can no longer be actioned via this link.',
      );
    }
    // Not decidable when already in revision (duplicate history), draft/closed, or already live.
    this.assertOpenForTokenAction(opportunity);
    // The partner step is only actionable while the partner line is genuinely open. A leaked or
    // old link must not be able to reject / send back an opportunity that is already live,
    // already approved by this partner, or already approved by CIEL PK.
    if (
      opportunity.admin_approved ||
      opportunity.workflowStage === WORKFLOW_STAGE.LIVE ||
      opportunity.status === 'active' ||
      opportunity.status === 'live' ||
      opportunity.partnerApprovalStatus === LINE_STATUS.APPROVED
    ) {
      throw new BadRequestException(
        'This opportunity is already approved, so this link can no longer be used to change it.',
      );
    }
    // No authenticated identity here — possession of the emailed token is the credential — so the
    // audit trail names the resolved partner contact email rather than a user id.
    const linkActor: ApprovalActor = {
      id: null,
      name: this.resolvePartnerEmailFromOpportunity(opportunity) || 'Partner (via link)',
    };
    if (action === 'reject') {
      this.opportunityWorkflow.afterPartnerRejected(opportunity, reason, linkActor);
    } else {
      this.opportunityWorkflow.afterPartnerRevision(opportunity, reason, linkActor);
    }
    const saved = await this.opportunitiesRepository.save(opportunity);

    await this.notifyStudentOpportunityUpdate(saved, {
      title: action === 'reject' ? 'Opportunity closed' : 'Revision requested',
      message:
        action === 'reject'
          ? 'Your opportunity was permanently rejected during partner review and can no longer be edited.'
          : 'Your partner organization asked you to update your opportunity. Save your changes to resubmit for review.',
      emailSubject:
        action === 'reject'
          ? 'Your opportunity was permanently rejected'
          : 'Partner requested revisions on your opportunity',
      reason,
    });

    return {
      success: true,
      message:
        action === 'reject'
          ? 'This opportunity has been rejected.'
          : 'A revision request has been sent to the student.',
      data: {
        title: saved.title,
        status: this.getApiOpportunityStatus(saved),
      },
    };
  }

  /**
   * Public faculty review card. The emailed faculty token is the credential — no login.
   * Returns only the opportunity content the flashcard renders, never tokens or participant lists.
   */
  async getPublicFacultyVerificationPreview(rawToken: string) {
    const token = this.normalizeVerificationToken(rawToken);
    const opportunity = await this.opportunitiesRepository.findOne({
      where: { faculty_verification_token: token },
    });
    if (!opportunity) {
      throw new NotFoundException('Invalid or expired verification link.');
    }
    this.assertVerificationLinkNotExpired(opportunity.facultyTokenExpiresAt);
    const alreadyVerified = opportunity.isStudentCreated
      ? !!opportunity.faculty_verified
      : opportunity.facultyApprovalStatus === LINE_STATUS.APPROVED;
    const closed = this.isClosedForTokenAction(opportunity);
    return {
      title: opportunity.title,
      alreadyVerified,
      closed,
      canDecide: !alreadyVerified && !closed && this.isAwaitingFacultyDashboardReview(opportunity),
      isStudentCreated: !!opportunity.isStudentCreated,
      record: {
        title: opportunity.title,
        types: opportunity.types,
        mode: opportunity.mode,
        location: opportunity.location,
        timeline: opportunity.timeline,
        objectives: opportunity.objectives,
        activity_details: opportunity.activity_details,
        supervision: opportunity.supervision,
        sdg_info: opportunity.sdg_info,
        secondary_sdgs: opportunity.secondary_sdgs,
        verification_method: opportunity.verification_method,
        visibility: opportunity.visibility,
      },
    };
  }

  /**
   * Anonymous faculty reject/revision. Same workflow methods as the logged-in faculty dashboard,
   * scoped to the emailed faculty token. Approve stays on verifyOpportunityToken.
   */
  async decideOpportunityViaFacultyToken(
    rawToken: string,
    action: 'reject' | 'revision',
    rawReason?: string,
  ) {
    const token = this.normalizeVerificationToken(rawToken);
    const reason = this.normalizeDecisionReason(rawReason);
    if (action !== 'reject' && action !== 'revision') {
      throw new BadRequestException('action must be "reject" or "revision"');
    }
    const opportunity = await this.opportunitiesRepository.findOne({
      where: { faculty_verification_token: token },
    });
    if (!opportunity) {
      throw new NotFoundException('Invalid or expired verification link.');
    }
    this.assertVerificationLinkNotExpired(opportunity.facultyTokenExpiresAt);
    const alreadyVerified = opportunity.isStudentCreated
      ? !!opportunity.faculty_verified
      : opportunity.facultyApprovalStatus === LINE_STATUS.APPROVED;
    if (alreadyVerified) {
      throw new BadRequestException(
        'This opportunity was already verified via this link.',
      );
    }
    if (
      opportunity.workflowStage === WORKFLOW_STAGE.REJECTED ||
      opportunity.status === 'rejected'
    ) {
      throw new BadRequestException(
        'This opportunity has already been closed and can no longer be actioned via this link.',
      );
    }
    this.assertOpenForTokenAction(opportunity);
    if (!this.isAwaitingFacultyDashboardReview(opportunity)) {
      throw new BadRequestException(
        'This opportunity is not awaiting faculty approval',
      );
    }
    const linkActor: ApprovalActor = {
      id: null,
      name: this.resolveFacultyEmail(opportunity) || 'Faculty (via link)',
    };
    if (action === 'reject') {
      this.opportunityWorkflow.afterFacultyRejected(opportunity, reason, linkActor);
    } else {
      this.opportunityWorkflow.afterFacultyRevision(opportunity, reason, linkActor);
    }
    await this.assignFacultyIdFromSupervisionIfMissing(opportunity);
    const saved = await this.opportunitiesRepository.save(opportunity);

    if (saved.isStudentCreated && saved.creatorId) {
      if (action === 'reject') {
        try {
          await this.notificationsService.createApprovalNotification(
            saved.creatorId,
            'Opportunity closed',
            'Your opportunity was permanently rejected during faculty review and can no longer be edited.',
          );
        } catch (e) {
          console.warn(
            'Failed to create faculty rejection notification',
            (e as Error).message,
          );
        }
        const student = await this.usersRepository.findOne({
          where: { id: saved.creatorId },
          select: ['email', 'name'],
        });
        if (student?.email) {
          try {
            await this.mailService.sendStudentOpportunityRejectedByFaculty(
              student.email,
              saved.title,
              reason,
            );
          } catch (e) {
            console.warn(
              'Failed to send student faculty-rejection email',
              (e as Error).message,
            );
          }
        }
      } else {
        await this.notifyStudentOpportunityUpdate(saved, {
          title: 'Revision requested',
          message:
            'Your faculty supervisor asked you to update your opportunity. Save your changes to resubmit for review.',
          emailSubject: 'Faculty requested revisions on your opportunity',
          reason,
        });
      }
    }

    return {
      success: true,
      message:
        action === 'reject'
          ? 'This opportunity has been rejected.'
          : 'A revision request has been sent back to the creator.',
      data: {
        title: saved.title,
        status: this.getApiOpportunityStatus(saved),
      },
    };
  }

  async verifyOpportunityToken(
    rawToken: string,
    user?: { id: string; email: string; role: string },
  ) {
    const token = this.normalizeVerificationToken(rawToken);
    const opportunity = await this.opportunitiesRepository.findOne({
      where: [
        { faculty_verification_token: token },
        { liaisonToken: token },
        { partnerToken: token },
      ],
    });

    if (!opportunity) {
      throw new NotFoundException('Invalid or expired verification token.');
    }

    this.assertVerificationIdentityIfRequired(opportunity, token, user);
    if (opportunity.partnerToken === token) {
      this.assertVerificationLinkNotExpired(opportunity.partnerTokenExpiresAt);
    }

    // Faculty magic link — isolated from partner/liaison tokens (wrong link cannot approve as partner).
    if (opportunity.faculty_verification_token === token) {
      return this.verifyFaculty(token, user);
    }

    // Student-created partner: same verify URL as legacy partner, but only after faculty approval.
    if (opportunity.isStudentCreated && opportunity.partnerToken === token) {
      if (opportunity.partnerVerified) {
        return {
          success: true,
          message: 'Partner verification was already completed.',
          data: {
            title: opportunity.title,
            status: this.getApiOpportunityStatus(opportunity),
            workflow_stage: opportunity.workflowStage,
          },
        };
      }
      this.assertOpenForTokenAction(opportunity);
      if (
        !opportunity.faculty_verified ||
        opportunity.status !== 'pending_partner'
      ) {
        throw new BadRequestException(
          'Partner verification is only available after the faculty supervisor has approved this opportunity.',
        );
      }
      this.opportunityWorkflow.afterPartnerVerified(opportunity, {
        id: null,
        name: this.resolvePartnerEmailFromOpportunity(opportunity) || 'Partner (via link)',
      });
      await this.assignFacultyIdFromSupervisionIfMissing(opportunity);
      await this.opportunitiesRepository.save(opportunity);
      await this.handlePartnerApprovedSideEffects(opportunity);
      return {
        success: true,
        data: {
          title: opportunity.title,
          isFullyVerified: false,
          status: this.getApiOpportunityStatus(opportunity),
          workflow_stage: opportunity.workflowStage,
        },
        message:
          'Partner verification successful. The opportunity will now be reviewed by CIEL Admin.',
      };
    }

    let verifiedRole = '';

    if (opportunity.liaisonToken === token && !opportunity.liaisonVerified) {
      this.assertOpenForTokenAction(opportunity);
      opportunity.liaisonVerified = true;
      verifiedRole = 'Liaison';

      // Legacy POST /student/opportunity: liaison email acted as faculty approval but never advanced workflow.
      if (
        opportunity.creatorId &&
        !opportunity.isStudentCreated &&
        opportunity.status === 'pending_verification'
      ) {
        opportunity.requiresPartnerApproval = !!(
          opportunity.partnerToken && !opportunity.partnerVerified
        );
        opportunity.isStudentCreated = true;
        this.opportunityWorkflow.initStudentCreated(
          opportunity,
          opportunity.requiresPartnerApproval,
        );
        this.opportunityWorkflow.afterFacultyVerified(opportunity, {
          id: null,
          name: this.resolveFacultyEmail(opportunity) || 'Faculty (via link)',
        });
        await this.assignFacultyIdFromSupervisionIfMissing(opportunity);
        await this.opportunitiesRepository.save(opportunity);
        await this.handleFacultyApprovedSideEffects(opportunity);
        return {
          success: true,
          data: {
            title: opportunity.title,
            isFullyVerified: false,
            status: this.getApiOpportunityStatus(opportunity),
            workflow_stage: opportunity.workflowStage,
          },
          message:
            'Faculty verification successful. The project will continue in the approval workflow.',
        };
      }
      await this.assignFacultyIdFromSupervisionIfMissing(opportunity);
    } else if (
      opportunity.partnerToken === token &&
      !opportunity.partnerVerified &&
      !opportunity.isStudentCreated
    ) {
      this.assertOpenForTokenAction(opportunity);
      if (
        opportunity.workflowStage === WORKFLOW_STAGE.LIVE ||
        opportunity.status === 'active' ||
        opportunity.status === 'live'
      ) {
        throw new BadRequestException(
          'This opportunity is already live and can no longer be actioned via this link.',
        );
      }
      this.opportunityWorkflow.afterFacultyCreatedPartnerVerified(opportunity, {
        id: null,
        name: this.resolvePartnerEmailFromOpportunity(opportunity) || 'Partner (via link)',
      });
      verifiedRole = 'Partner';
      await this.assignFacultyIdFromSupervisionIfMissing(opportunity);
      await this.opportunitiesRepository.save(opportunity);
      await this.handlePartnerApprovedSideEffects(opportunity);
      const nowLive = this.getApiOpportunityStatus(opportunity) === 'live';
      return {
        success: true,
        data: {
          title: opportunity.title,
          isFullyVerified: nowLive,
          status: this.getApiOpportunityStatus(opportunity),
          workflow_stage: opportunity.workflowStage,
        },
        message: nowLive
          ? 'Partner verification successful. The opportunity is now published.'
          : 'Partner verification successful. The opportunity will now be reviewed by CIEL Admin.',
      };
    } else {
      return {
        success: true,
        message: 'This component of the project has already been verified.',
      };
    }

    // Check if both are now verified. Only the legacy pending_verification row may self-activate
    // here; any other stage must go through its own workflow gate (never skip CIEL admin).
    if (
      opportunity.liaisonVerified &&
      opportunity.partnerVerified &&
      opportunity.status === 'pending_verification'
    ) {
      opportunity.status = 'active';
    }

    await this.assignFacultyIdFromSupervisionIfMissing(opportunity);
    await this.opportunitiesRepository.save(opportunity);

    return {
      success: true,
      data: {
        title: opportunity.title,
        isFullyVerified: this.getApiOpportunityStatus(opportunity) === 'live',
      },
      message: `${verifiedRole} verification successful.`,
    };
  }

  async verifyExecutingOrganizationForUser(
    userId: string,
    jwtEmail: string | undefined,
    opportunityId: string,
  ) {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
      select: ['id', 'email'],
    });
    const actorEmail = this.normalizeEmail(user?.email || jwtEmail);
    if (!actorEmail) {
      throw new ForbiddenException(
        'Your account must have an email to confirm execution details.',
      );
    }

    const opp = await this.findOne(opportunityId);
    if (!opp) {
      throw new NotFoundException('Opportunity not found');
    }

    if (!opp.execution_verification_token) {
      throw new BadRequestException(
        'This opportunity does not require executing-organization confirmation in the portal.',
      );
    }

    if (
      !opp.execution_verified &&
      (this.isClosedForTokenAction(opp) ||
        opp.workflowStage === WORKFLOW_STAGE.LIVE ||
        opp.status === 'active')
    ) {
      throw new BadRequestException(
        'This opportunity is not awaiting executing-organization confirmation.',
      );
    }

    if (opp.execution_verified) {
      return {
        success: true,
        message: 'Executing organization was already verified.',
        data: {
          id: opp.id,
          status: opp.status,
          workflow_stage: opp.workflowStage,
        },
      };
    }

    const exec = opp.executing_organization as {
      official_email?: string;
      officialEmail?: string;
    } | null;
    const expected = this.normalizeEmail(
      typeof exec?.official_email === 'string'
        ? exec.official_email
        : typeof exec?.officialEmail === 'string'
          ? exec.officialEmail
          : undefined,
    );
    if (!expected || expected !== actorEmail) {
      throw new ForbiddenException(
        'Only the official executing-organization contact (the email on file) can confirm this step. Sign in with that CIEL account.',
      );
    }

    opp.execution_verified = true;
    opp.execution_verification_status = 'execution_verified';
    const facultyStillPending =
      opp.facultyApprovalStatus === LINE_STATUS.PENDING ||
      (!!opp.faculty_verification_token && !opp.faculty_verified);
    if (facultyStillPending) {
      opp.status = 'pending_faculty';
      opp.workflowStage = WORKFLOW_STAGE.PENDING_FACULTY;
    } else if (opp.requiresPartnerApproval && !opp.partnerVerified) {
      opp.status = 'pending_partner';
      opp.workflowStage = WORKFLOW_STAGE.PENDING_PARTNER;
      if (
        !opp.partnerApprovalStatus ||
        opp.partnerApprovalStatus === LINE_STATUS.NOT_APPLICABLE
      ) {
        opp.partnerApprovalStatus = LINE_STATUS.PENDING;
      }
    } else if (
      opp.admin_approved ||
      opp.adminApprovalStatus === LINE_STATUS.APPROVED ||
      opp.adminApprovalStatus === LINE_STATUS.NOT_REQUIRED
    ) {
      this.opportunityWorkflow.afterAdminApproved(opp, {
        id: user?.id ?? null,
        name: actorEmail,
      });
    } else {
      opp.status = 'pending_approval';
      if (
        !opp.workflowStage ||
        opp.workflowStage === WORKFLOW_STAGE.PENDING_ADMIN
      ) {
        opp.workflowStage = WORKFLOW_STAGE.PENDING_ADMIN;
      }
      if (
        !opp.adminApprovalStatus ||
        opp.adminApprovalStatus === LINE_STATUS.NOT_APPLICABLE
      ) {
        opp.adminApprovalStatus = LINE_STATUS.PENDING;
      }
    }
    await this.opportunitiesRepository.save(opp);
    if (opp.workflowStage === WORKFLOW_STAGE.PENDING_FACULTY) {
      if (!opp.faculty_verification_token) {
        opp.faculty_verification_token = randomUUID();
        await this.opportunitiesRepository.save(opp);
      }
      await this.notifyFacultyForStudentOpportunityVerification(opp);
    } else if (opp.workflowStage === WORKFLOW_STAGE.PENDING_PARTNER) {
      await this.sendPartnerApprovalEmail(opp);
    } else if (
      !opp.admin_approved &&
      opp.workflowStage === WORKFLOW_STAGE.PENDING_ADMIN
    ) {
      await this.sendAdminReviewEmail(
        opp,
        'executing organization verification',
      );
    }
    return {
      success: true,
      message: 'Executing organization verified.',
      data: {
        id: opp.id,
        status: opp.status,
        workflow_stage: opp.workflowStage,
      },
    };
  }

  async verifyFaculty(
    rawToken: string,
    user?: { id: string; email: string; role: string },
  ) {
    const token = this.normalizeVerificationToken(rawToken);
    const opp = await this.opportunitiesRepository.findOne({
      where: { faculty_verification_token: token },
    });
    if (!opp)
      throw new NotFoundException(
        'Invalid or expired faculty verification token',
      );
    this.assertVerificationLinkNotExpired(opp.facultyTokenExpiresAt);
    this.assertVerificationIdentityIfRequired(opp, token, user);
    const alreadyDone = opp.isStudentCreated
      ? opp.faculty_verified
      : opp.facultyApprovalStatus === LINE_STATUS.APPROVED;
    if (
      !alreadyDone &&
      (this.isClosedForTokenAction(opp) ||
        !this.isAwaitingFacultyDashboardReview(opp))
    ) {
      throw new BadRequestException(
        'This opportunity is not awaiting faculty approval',
      );
    }
    if (alreadyDone) {
      return {
        success: true,
        message: 'Faculty verification was already completed.',
        data: {
          id: opp.id,
          status: this.getApiOpportunityStatus(opp),
          workflow_stage: opp.workflowStage,
        },
      };
    }
    this.opportunityWorkflow.afterFacultyVerified(opp, {
      id: user?.id ?? null,
      name: user?.email || this.resolveFacultyEmail(opp) || 'Faculty (via link)',
    });
    await this.assignFacultyIdFromSupervisionIfMissing(opp);
    await this.opportunitiesRepository.save(opp);
    await this.handleFacultyApprovedSideEffects(opp);
    return {
      success: true,
      message: 'Faculty verification successful',
      data: {
        id: opp.id,
        status: this.getApiOpportunityStatus(opp),
        workflow_stage: opp.workflowStage,
      },
    };
  }

  /**
   * Faculty dashboard: must match assigned facultyId OR supervision.contact / official_email /
   * partner_organization.official_email (institutional partner contact using a faculty account).
   * Does not assert opportunity.status — see facultyDashboardApprove/Reject for pipeline vs application.
   */
  /** True when this faculty user is the admin-assigned liaison ("University scope") for the
   * university organization the opportunity belongs to — the same set the faculty approvals
   * list shows them, so the rows they can see are also rows they can open and act on. */
  private async isDelegatedFacultyForOpportunity(
    opportunityId: string,
    facultyUserId?: string,
  ): Promise<boolean> {
    if (!facultyUserId) return false;
    const orgId =
      await this.facultyUniversityScope.getDelegatedOrganizationId(
        facultyUserId,
      );
    if (!orgId) return false;
    const ids =
      await this.facultyUniversityScope.resolveOpportunityIdsForUniversityOrganization(
        orgId,
      );
    return ids.includes(opportunityId);
  }

  private async assertFacultySupervisorForStudentOpportunity(
    opp: Opportunity,
    facultyUserId: string,
    facultyEmail: string,
  ) {
    const po = opp.partner_organization as Record<string, unknown> | undefined;
    const partnerOfficial = this.normalizeEmail(
      typeof po?.official_email === 'string' ? po.official_email : undefined,
    );
    // ANY faculty email on the record (not just the first non-empty one): the approvals list
    // matches the supervision contact, the official email and the faculty-link representative.
    const linkedFacultyEmails = this.collectFacultyReviewerEmails(opp);
    const fe = this.normalizeEmail(facultyEmail);
    const idOk = !!opp.facultyId && opp.facultyId === facultyUserId;
    const emailOk =
      (!!fe && linkedFacultyEmails.includes(fe)) ||
      (!!partnerOfficial && !!fe && partnerOfficial === fe);
    if (
      !idOk &&
      !emailOk &&
      !(await this.isDelegatedFacultyForOpportunity(opp.id, facultyUserId))
    ) {
      throw new ForbiddenException(
        'You are not the assigned faculty supervisor for this opportunity',
      );
    }
  }

  /** Ownership only — no business-state assertions. Safe to call before an idempotency
   * short-circuit (e.g. partnerDashboardApprove's "already approved" return), unlike the fuller
   * assertPartnerCanReviewOpportunity below, whose "still awaiting review" check would reject a
   * legitimate double-click on an opportunity this same partner already approved. */
  /** Letters and digits only, so "FELLAH" matches "Fellah Khalid" and "FELLAH,". */
  private foldPartnerOrgName(name: string): string {
    return this.facultyUniversityScope
      .normalizeOrgName(name)
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Exact name, or the registered name as a whole word inside the name the student typed. */
  private orgNamesReferToSamePartner(candidate: string, target: string): boolean {
    const left = this.foldPartnerOrgName(candidate);
    const right = this.foldPartnerOrgName(target);
    if (!left || !right || right.length < 3) return false;
    if (left === right) return true;
    if (right.length < 4) return false;
    return (
      left.startsWith(`${right} `) ||
      left.endsWith(` ${right}`) ||
      left.includes(` ${right} `)
    );
  }

  private partnerOrgNameMatchSql(): string {
    const exprs = [
      `opportunity.external_partner_collaboration->>'organization_name'`,
      `opportunity.external_partner_collaboration->>'contact_person'`,
      `opportunity.partner_organization->>'organization_name'`,
      `opportunity.partner_organization->>'name'`,
      `opportunity.partner_organization->>'contact_person'`,
      `opportunity.partner_organization->>'contact_person_name'`,
      `opportunity.supervision->>'partner_org_name'`,
      `opportunity.supervision->>'external_partner_org_name'`,
      `opportunity.supervision->>'partner_contact_person'`,
      `opportunity.supervision->>'external_partner_contact_person'`,
      `opportunity.executing_context->'partner'->>'organization_name'`,
      `opportunity.executing_context->'partner'->>'contact_person'`,
    ];
    const folded = (expr: string) =>
      `regexp_replace(LOWER(TRIM(COALESCE(${expr}, ''))), '[^a-z0-9]+', ' ', 'g')`;
    return `(${exprs
      .map(
        (expr) => `(
          ${folded(expr)} = :orgName
          OR ${folded(expr)} LIKE :orgNamePrefix
          OR ${folded(expr)} LIKE :orgNameSuffix
          OR ${folded(expr)} LIKE :orgNameMiddle
        )`,
      )
      .join(' OR ')})`;
  }

  private partnerOrgNameMatchParams(orgNameNorm: string): Record<string, string> {
    const folded = this.foldPartnerOrgName(orgNameNorm);
    const token = folded.length >= 4;
    return {
      orgName: folded,
      // Length under 4 stays exact-only: the LIKE patterns cannot match.
      orgNamePrefix: token ? `${folded} %` : '\u0000',
      orgNameSuffix: token ? `% ${folded}` : '\u0000',
      orgNameMiddle: token ? `% ${folded} %` : '\u0000',
    };
  }

  /** True when the opportunity names this organisation, even if the contact email is a different person. */
  private async namedPartnerOrgMatches(
    opp: Opportunity,
    organizationId?: string | null,
    userId?: string | null,
    preloadedOrgNames?: string[],
  ): Promise<boolean> {
    const orgNames: string[] = preloadedOrgNames ? [...preloadedOrgNames] : [];
    if (!preloadedOrgNames && userId) {
      try {
        const mine = await this.organizationsService.getMyOrganization(userId);
        if (mine?.name) orgNames.push(mine.name);
      } catch {
        /* login is not linked to an organisation */
      }
    }
    if (!preloadedOrgNames && organizationId) {
      try {
        const org = await this.organizationsService.findOne(organizationId);
        if (org?.name) orgNames.push(org.name);
      } catch {
        /* token org id is missing or stale */
      }
    }
    if (!orgNames.length) return false;
    const collab = opp.external_partner_collaboration as
      | { organization_name?: string; contact_person?: string }
      | undefined;
    const po = opp.partner_organization as
      | {
          organization_name?: string;
          name?: string;
          contact_person?: string;
          contact_person_name?: string;
        }
      | undefined;
    const sup = opp.supervision as
      | {
          partner_org_name?: string;
          external_partner_org_name?: string;
          partner_contact_person?: string;
          external_partner_contact_person?: string;
        }
      | undefined;
    const ctx = opp.executing_context as
      | { partner?: { organization_name?: string; contact_person?: string } }
      | undefined;
    const candidates = [
      collab?.organization_name,
      collab?.contact_person,
      po?.organization_name,
      po?.name,
      po?.contact_person,
      po?.contact_person_name,
      sup?.partner_org_name,
      sup?.external_partner_org_name,
      sup?.partner_contact_person,
      sup?.external_partner_contact_person,
      ctx?.partner?.organization_name,
      ctx?.partner?.contact_person,
    ];
    return orgNames.some((orgName) =>
      candidates.some(
        (raw) =>
          typeof raw === 'string' &&
          this.orgNamesReferToSamePartner(raw, orgName),
      ),
    );
  }

  /** Non-throwing form of the partner-reviewer identity gate (see assertPartnerOwnsOpportunity). */
  private async partnerReviewIdentityMatches(
    opp: Opportunity,
    partnerEmail: string,
    organizationId?: string | null,
    userId?: string | null,
    preloadedOrgNames?: string[],
  ): Promise<boolean> {
    // Any partner contact email the creator entered — the partner list matches all of them.
    const actorEmail = this.normalizeEmail(partnerEmail);
    const emailMatches =
      !!actorEmail && this.collectPartnerContactEmails(opp).includes(actorEmail);
    // On a student-created row `organizationId` is the *host partner's* organisation, so its
    // members are the reviewers. On an org/faculty/admin-created row it is the CREATOR's own
    // organisation — accepting it would let the creator (or a colleague) acknowledge the distinct
    // partner / collaboration gate that exists precisely so someone else confirms it.
    const organizationMatches =
      opp.isStudentCreated === true &&
      !!organizationId &&
      !!opp.organizationId &&
      organizationId === opp.organizationId;
    if (emailMatches || organizationMatches) return true;
    return this.namedPartnerOrgMatches(
      opp,
      organizationId,
      userId,
      preloadedOrgNames,
    );
  }

  private async assertPartnerOwnsOpportunity(
    opp: Opportunity,
    partnerEmail: string,
    organizationId?: string | null,
    userId?: string | null,
  ) {
    if (
      !(await this.partnerReviewIdentityMatches(
        opp,
        partnerEmail,
        organizationId,
        userId,
      ))
    ) {
      throw new ForbiddenException(
        'You are not the assigned partner reviewer for this opportunity',
      );
    }
  }

  private async assertPartnerCanReviewOpportunity(
    opp: Opportunity,
    partnerEmail: string,
    organizationId?: string | null,
    userId?: string | null,
  ) {
    await this.assertPartnerOwnsOpportunity(
      opp,
      partnerEmail,
      organizationId,
      userId,
    );

    if (opp.isStudentCreated) {
      if (!opp.faculty_verified) {
        throw new BadRequestException(
          'Partner verification is only available after faculty approval.',
        );
      }
      if (!this.isAwaitingPartnerDashboardReview(opp)) {
        throw new BadRequestException(
          'This opportunity is not awaiting partner approval.',
        );
      }
      return;
    }

    if (!this.isAwaitingPartnerDashboardReview(opp)) {
      throw new BadRequestException(
        'This opportunity is not awaiting partner approval.',
      );
    }
  }

  /**
   * Partner approve/reject and Faculty Hub `partner_ack` — true when the partner line is still open
   * (covers `pending_execution` + null workflow where execution org is still pending but partner may act).
   */
  isAwaitingPartnerDashboardReview(opp: Opportunity): boolean {
    if (String(opp.status || '').toLowerCase() === 'draft') {
      return false;
    }
    if (!opp.requiresPartnerApproval || opp.partnerVerified) {
      return false;
    }
    const pas = opp.partnerApprovalStatus;
    if (
      pas === LINE_STATUS.APPROVED ||
      pas === LINE_STATUS.REJECTED ||
      pas === LINE_STATUS.SKIPPED
    ) {
      return false;
    }
    if (opp.workflowStage === WORKFLOW_STAGE.PENDING_PARTNER) {
      return true;
    }
    if (
      opp.status === 'pending_partner' ||
      opp.status === 'pending_execution'
    ) {
      return true;
    }
    if (pas === LINE_STATUS.PENDING || pas == null || pas === '') {
      return true;
    }
    return false;
  }

  private isAwaitingFacultyDashboardReview(opp: Opportunity): boolean {
    if (String(opp.status || '').toLowerCase() === 'draft') return false;
    if (!opp.creatorId || opp.faculty_verified || opp.admin_approved)
      return false;
    if (
      opp.workflowStage === WORKFLOW_STAGE.LIVE ||
      opp.status === 'active' ||
      opp.status === 'live'
    ) {
      return false;
    }
    return (
      opp.workflowStage === WORKFLOW_STAGE.PENDING_FACULTY ||
      opp.status === 'pending_faculty' ||
      opp.status === 'pending_verification' ||
      opp.facultyApprovalStatus === LINE_STATUS.PENDING ||
      opp.faculty_verification_status === WORKFLOW_STAGE.PENDING_FACULTY
    );
  }

  async facultyDashboardApprove(
    opportunityId: string,
    facultyUserId: string,
    facultyEmail: string,
    facultyName?: string,
  ) {
    const opp = await this.findOne(opportunityId);
    if (!opp) throw new NotFoundException('Opportunity not found');
    await this.assertFacultySupervisorForStudentOpportunity(
      opp,
      facultyUserId,
      facultyEmail,
    );

    const oppAwaitingFaculty = this.isAwaitingFacultyDashboardReview(opp);
    const pendingApp =
      await this.opportunityApplicationsService.findActionablePendingFacultyApplicationForDashboard(
        opportunityId,
        facultyEmail,
        facultyUserId,
      );

    if (!oppAwaitingFaculty && !pendingApp) {
      throw new BadRequestException(
        'This opportunity is not awaiting faculty approval',
      );
    }

    if (oppAwaitingFaculty) {
      this.opportunityWorkflow.afterFacultyVerified(opp, {
        id: facultyUserId,
        name: facultyName,
      });
      await this.assignFacultyIdFromSupervisionIfMissing(opp);
      const saved = await this.opportunitiesRepository.save(opp);
      const mail = await this.handleFacultyApprovedSideEffects(saved);
      return Object.assign(saved, {
        partner_email_sent: mail.partnerEmailSent,
        partner_email: mail.partnerEmail,
      });
    }

    await this.opportunityApplicationsService.facultyApprove(
      pendingApp!.id,
      facultyEmail,
      facultyUserId,
    );
    const refreshed = await this.findOne(opportunityId);
    if (!refreshed) throw new NotFoundException('Opportunity not found');
    return refreshed;
  }

  async facultyDashboardReject(
    opportunityId: string,
    facultyUserId: string,
    facultyEmail: string,
    reason?: string,
    facultyName?: string,
  ) {
    const opp = await this.findOne(opportunityId);
    if (!opp) throw new NotFoundException('Opportunity not found');
    await this.assertFacultySupervisorForStudentOpportunity(
      opp,
      facultyUserId,
      facultyEmail,
    );

    const oppAwaitingFaculty = this.isAwaitingFacultyDashboardReview(opp);
    const pendingApp =
      await this.opportunityApplicationsService.findActionablePendingFacultyApplicationForDashboard(
        opportunityId,
        facultyEmail,
        facultyUserId,
      );

    if (!oppAwaitingFaculty && !pendingApp) {
      throw new BadRequestException(
        'This opportunity is not awaiting faculty approval',
      );
    }

    if (oppAwaitingFaculty) {
      this.opportunityWorkflow.afterFacultyRejected(opp, reason, {
        id: facultyUserId,
        name: facultyName,
      });
      await this.assignFacultyIdFromSupervisionIfMissing(opp);
    } else {
      await this.opportunityApplicationsService.facultyReject(
        pendingApp!.id,
        facultyEmail,
        facultyUserId,
        reason || '',
      );
      return (await this.findOne(opportunityId))!;
    }

    const saved = await this.opportunitiesRepository.save(opp);
    if (opp.isStudentCreated && opp.creatorId) {
      try {
        await this.notificationsService.createApprovalNotification(
          opp.creatorId,
          'Opportunity closed',
          'Your opportunity was permanently rejected during faculty review and can no longer be edited.',
        );
      } catch (e) {
        console.warn(
          'Failed to create faculty rejection notification',
          (e as Error).message,
        );
      }
    }
    if (opp.isStudentCreated && opp.creatorId) {
      const student = await this.usersRepository.findOne({
        where: { id: opp.creatorId },
        select: ['email', 'name'],
      });
      if (student?.email) {
        try {
          await this.mailService.sendStudentOpportunityRejectedByFaculty(
            student.email,
            saved.title,
            reason,
          );
        } catch (e) {
          console.warn(
            'Failed to send student faculty-rejection email',
            (e as Error).message,
          );
        }
      }
    }
    return saved;
  }

  async facultyDashboardRevise(
    opportunityId: string,
    facultyUserId: string,
    facultyEmail: string,
    reason?: string,
    facultyName?: string,
  ) {
    const opp = await this.findOne(opportunityId);
    if (!opp) throw new NotFoundException('Opportunity not found');
    await this.assertFacultySupervisorForStudentOpportunity(
      opp,
      facultyUserId,
      facultyEmail,
    );

    const oppAwaitingFaculty = this.isAwaitingFacultyDashboardReview(opp);
    if (!oppAwaitingFaculty) {
      throw new BadRequestException(
        'This opportunity is not awaiting faculty approval',
      );
    }

    this.opportunityWorkflow.afterFacultyRevision(opp, reason, {
      id: facultyUserId,
      name: facultyName,
    });
    await this.assignFacultyIdFromSupervisionIfMissing(opp);
    const saved = await this.opportunitiesRepository.save(opp);

    if (saved.isStudentCreated) {
      await this.notifyStudentOpportunityUpdate(saved, {
        title: 'Revision requested',
        message:
          'Your faculty supervisor asked you to update your opportunity. Save your changes to resubmit for review.',
        emailSubject: 'Faculty requested revisions on your opportunity',
        reason,
      });
    }
    return saved;
  }

  async partnerDashboardApprove(
    opportunityId: string,
    partner: {
      email: string;
      organizationId?: string | null;
      id?: string | null;
      name?: string | null;
    },
  ) {
    const opp = await this.findOne(opportunityId);
    if (!opp) throw new NotFoundException('Opportunity not found');

    // Ownership must be checked before the idempotency short-circuit below — otherwise any
    // authenticated partner/faculty user could probe another partner's already-approved
    // opportunities by calling approve again and reading back the (unchanged) result. Ownership
    // only, not the full assertion (which also demands "still awaiting review" and would wrongly
    // reject the correct partner's own legitimate double-click on an already-approved opportunity).
    await this.assertPartnerOwnsOpportunity(
      opp,
      partner.email,
      partner.organizationId,
      partner.id,
    );

    if (
      opp.partnerApprovalStatus === 'approved' &&
      opp.workflowStage === WORKFLOW_STAGE.PENDING_ADMIN
    ) {
      return opp;
    }

    await this.assertPartnerCanReviewOpportunity(
      opp,
      partner.email,
      partner.organizationId,
      partner.id,
    );
    const actor: ApprovalActor = { id: partner.id, name: partner.name };
    if (opp.isStudentCreated) {
      this.opportunityWorkflow.afterPartnerVerified(opp, actor);
    } else {
      this.opportunityWorkflow.afterFacultyCreatedPartnerVerified(opp, actor);
    }
    const saved = await this.opportunitiesRepository.save(opp);
    await this.handlePartnerApprovedSideEffects(saved);
    return saved;
  }

  async partnerDashboardReject(
    opportunityId: string,
    partner: {
      email: string;
      organizationId?: string | null;
      id?: string | null;
      name?: string | null;
    },
    reason?: string,
  ) {
    const opp = await this.findOne(opportunityId);
    if (!opp) throw new NotFoundException('Opportunity not found');

    await this.assertPartnerCanReviewOpportunity(
      opp,
      partner.email,
      partner.organizationId,
      partner.id,
    );
    this.opportunityWorkflow.afterPartnerRejected(opp, reason, {
      id: partner.id,
      name: partner.name,
    });
    const saved = await this.opportunitiesRepository.save(opp);

    if (saved.isStudentCreated) {
      await this.notifyStudentOpportunityUpdate(saved, {
        title: 'Opportunity closed',
        message:
          'Your opportunity was permanently rejected during partner review and can no longer be edited.',
        emailSubject: 'Your opportunity was permanently rejected',
        reason,
      });
    }

    return saved;
  }

  async partnerDashboardRevise(
    opportunityId: string,
    partner: {
      email: string;
      organizationId?: string | null;
      id?: string | null;
      name?: string | null;
    },
    reason?: string,
  ) {
    const opp = await this.findOne(opportunityId);
    if (!opp) throw new NotFoundException('Opportunity not found');

    await this.assertPartnerCanReviewOpportunity(
      opp,
      partner.email,
      partner.organizationId,
      partner.id,
    );

    this.opportunityWorkflow.afterPartnerRevision(opp, reason, {
      id: partner.id,
      name: partner.name,
    });
    const saved = await this.opportunitiesRepository.save(opp);

    await this.notifyStudentOpportunityUpdate(saved, {
      title: 'Revision requested',
      message:
        'Your partner organization asked you to update your opportunity. Save your changes to resubmit for review.',
      emailSubject: 'Partner requested revisions on your opportunity',
      reason,
    });

    return saved;
  }

  /**
   * Admin Project Tracker: update faculty supervisor and/or partner contact fields on the
   * opportunity JSON, rebind facultyId, reconcile approval queues when still pending, and
   * refresh pending attendance assignees without unpublishing live listings.
   */
  async adminUpdateOpportunityContacts(
    opportunityId: string,
    dto: AdminSetOpportunityContactsDto,
  ) {
    const hasFaculty =
      dto.faculty_supervisor_name !== undefined ||
      dto.faculty_supervisor_email !== undefined;
    const hasPartner =
      dto.partner_organization_name !== undefined ||
      dto.partner_contact_person !== undefined ||
      dto.partner_contact_email !== undefined;
    if (!hasFaculty && !hasPartner) {
      throw new BadRequestException(
        'Provide at least one faculty or partner field to update.',
      );
    }

    const opp = await this.opportunitiesRepository.findOne({
      where: { id: opportunityId },
      relations: ['organization'],
    });
    if (!opp) throw new NotFoundException('Opportunity not found');

    const before = this.snapshotStudentOpportunityResubmit(opp);
    const previousFacultyUserId = opp.facultyId ?? null;

    if (hasFaculty) {
      const sup = {
        ...((opp.supervision as Record<string, unknown>) || {}),
      };
      if (dto.faculty_supervisor_name !== undefined) {
        sup.supervisor_name = dto.faculty_supervisor_name.trim();
      }
      if (dto.faculty_supervisor_email !== undefined) {
        const email = dto.faculty_supervisor_email.trim();
        if (email && !this.isValidEmail(email)) {
          throw new BadRequestException('Invalid faculty supervisor email.');
        }
        sup.contact = email;
      }
      opp.supervision = sup;
    }

    if (hasPartner) {
      const po = {
        ...((opp.partner_organization as Record<string, unknown>) || {}),
      };
      const sup = {
        ...((opp.supervision as Record<string, unknown>) || {}),
      };
      if (dto.partner_organization_name !== undefined) {
        const name = dto.partner_organization_name.trim();
        po.organization_name = name;
        sup.partner_org_name = name;
      }
      if (dto.partner_contact_person !== undefined) {
        const person = dto.partner_contact_person.trim();
        po.contact_person = person;
        sup.partner_contact_person = person;
      }
      if (dto.partner_contact_email !== undefined) {
        const email = dto.partner_contact_email.trim();
        if (email && !this.isValidEmail(email)) {
          throw new BadRequestException('Invalid partner contact email.');
        }
        po.official_email = email;
        sup.partner_email = email;
      }
      opp.partner_organization = po;
      opp.supervision = sup;
    }

    const facultyEmailNow = this.getFacultyEmailFromOpportunity(opp);
    const facultyEmailChanged =
      this.normalizeEmail(before.facultyEmail || '') !==
      this.normalizeEmail(facultyEmailNow || '');

    opp.requiresPartnerApproval = this.studentCreatedPayloadRequiresPartner(
      opp as unknown as CreateOpportunityDto,
    );

    if (hasFaculty) {
      await this.syncOpportunityFacultyIdToSupervisionEmail(opp);
    }

    if (!opp.admin_approved) {
      await this.applyStudentCreatedOpportunityResubmit(opp, before);
    }

    await this.opportunitiesRepository.save(opp);

    const refreshed = await this.opportunitiesRepository.findOne({
      where: { id: opportunityId },
      relations: ['organization'],
    });
    if (refreshed) {
      const propagation = await this.propagateContactChangeBindings(
        opportunityId,
        {
          oldFacultyEmail: before.facultyEmail,
          newFacultyEmail: facultyEmailNow,
          oldFacultyUserId: previousFacultyUserId,
          newFacultyUserId: refreshed.facultyId ?? null,
          facultyEmailChanged,
        },
      );
      await this.engagementService.reconcilePendingAttendanceAfterOpportunityContactChange(
        refreshed,
      );

      const supervision = refreshed.supervision as
        | Record<string, unknown>
        | undefined;
      const partnerOrg = refreshed.partner_organization as
        | Record<string, unknown>
        | undefined;

      return {
        success: true,
        data: {
          faculty_supervisor_name:
            typeof supervision?.supervisor_name === 'string'
              ? supervision.supervisor_name.trim()
              : null,
          faculty_supervisor_email:
            typeof supervision?.contact === 'string'
              ? supervision.contact.trim()
              : null,
          partner_organization_name:
            typeof partnerOrg?.organization_name === 'string'
              ? partnerOrg.organization_name.trim()
              : typeof supervision?.partner_org_name === 'string'
                ? supervision.partner_org_name.trim()
                : null,
          partner_contact_email:
            typeof partnerOrg?.official_email === 'string'
              ? partnerOrg.official_email.trim()
              : typeof supervision?.partner_email === 'string'
                ? supervision.partner_email.trim()
                : null,
          partner_contact_person:
            typeof partnerOrg?.contact_person === 'string'
              ? partnerOrg.contact_person.trim()
              : typeof supervision?.partner_contact_person === 'string'
                ? supervision.partner_contact_person.trim()
                : null,
          attendance_routing_override:
            refreshed.attendanceRoutingOverride ?? 'auto',
          faculty_user_id: refreshed.facultyId ?? null,
          faculty_account_linked: !!refreshed.facultyId,
          propagation,
        },
      };
    }

    return {
      success: true,
      data: {
        faculty_supervisor_name: null,
        faculty_supervisor_email: null,
        partner_organization_name: null,
        partner_contact_email: null,
        partner_contact_person: null,
        attendance_routing_override: 'auto',
        propagation: {
          participations_updated: 0,
          applications_updated: 0,
          reports_updated: 0,
        },
      },
    };
  }

  /**
   * After admin edits project faculty, rebind enrollments, join applications, and open
   * impact-report faculty lines that still pointed at the previous supervisor.
   */
  private async propagateContactChangeBindings(
    opportunityId: string,
    params: {
      oldFacultyEmail: string | null;
      newFacultyEmail: string | null;
      oldFacultyUserId: string | null;
      newFacultyUserId: string | null;
      facultyEmailChanged: boolean;
    },
  ): Promise<{
    participations_updated: number;
    applications_updated: number;
    reports_updated: number;
  }> {
    if (!params.facultyEmailChanged) {
      return {
        participations_updated: 0,
        applications_updated: 0,
        reports_updated: 0,
      };
    }

    const oldFe = this.normalizeEmail(params.oldFacultyEmail || '');
    const newFe = this.normalizeEmail(params.newFacultyEmail || '');

    const replaceProjectFacultyEmail = (
      current: string | null | undefined,
    ): string | null | undefined => {
      const normalized = this.normalizeEmail(current || '');
      if (!newFe) {
        return normalized === oldFe ? '' : current;
      }
      if (!normalized) {
        return newFe;
      }
      if (oldFe && normalized === oldFe) {
        return newFe;
      }
      return current;
    };

    let participationsUpdated = 0;
    const participations = await this.participationRepository.find({
      where: { projectId: opportunityId },
    });
    for (const participation of participations) {
      const nextPrimary = replaceProjectFacultyEmail(
        participation.primaryFacultyEmail,
      );
      const nextSupervisor = replaceProjectFacultyEmail(
        participation.facultySupervisorEmail,
      );
      const nextSecondary = replaceProjectFacultyEmail(
        participation.secondaryFacultyEmail,
      );
      const changed =
        nextPrimary !== participation.primaryFacultyEmail ||
        nextSupervisor !== participation.facultySupervisorEmail ||
        nextSecondary !== participation.secondaryFacultyEmail;
      if (!changed) {
        continue;
      }
      participation.primaryFacultyEmail = nextPrimary ?? '';
      participation.facultySupervisorEmail = nextSupervisor ?? '';
      participation.secondaryFacultyEmail = nextSecondary ?? '';
      await this.participationRepository.save(participation);
      participationsUpdated += 1;
    }

    let applicationsUpdated = 0;
    const appRepo = this.opportunitiesRepository.manager.getRepository(
      OpportunityApplication,
    );
    const applications = await appRepo.find({
      where: { opportunityId, withdrawnAt: IsNull() },
    });
    for (const application of applications) {
      const nextPrimary = replaceProjectFacultyEmail(
        application.primaryFacultyEmail,
      );
      const nextSecondary = replaceProjectFacultyEmail(
        application.secondaryFacultyEmail,
      );
      const payload =
        application.applyPayload && typeof application.applyPayload === 'object'
          ? { ...application.applyPayload }
          : {};
      let payloadChanged = false;
      for (const key of [
        'primary_faculty_email',
        'secondary_faculty_email',
        'faculty_supervisor_email',
      ]) {
        const raw = payload[key];
        if (typeof raw !== 'string') {
          continue;
        }
        const next = replaceProjectFacultyEmail(raw);
        if (next !== raw) {
          payload[key] = next ?? '';
          payloadChanged = true;
        }
      }

      const changed =
        nextPrimary !== application.primaryFacultyEmail ||
        nextSecondary !== application.secondaryFacultyEmail ||
        payloadChanged;
      if (!changed) {
        continue;
      }
      application.primaryFacultyEmail = (nextPrimary as string) || null;
      application.secondaryFacultyEmail = (nextSecondary as string) || null;
      if (payloadChanged) {
        application.applyPayload = payload;
      }
      await appRepo.save(application);
      applicationsUpdated += 1;
    }

    let reportsUpdated = 0;
    const reportRepo =
      this.opportunitiesRepository.manager.getRepository(StudentReport);
    const reports = await reportRepo
      .createQueryBuilder('report')
      .where('report.opportunityId = :opportunityId', { opportunityId })
      .orWhere("TRIM(COALESCE(report.project_id, '')) = :opportunityId", {
        opportunityId,
      })
      .getMany();

    for (const report of reports) {
      const facultyStatus = (report.faculty_status || 'pending').toLowerCase();
      if (facultyStatus === 'approved' || facultyStatus === 'rejected') {
        continue;
      }

      const section1 =
        report.section1 && typeof report.section1 === 'object'
          ? { ...report.section1 }
          : null;
      const currentSectionEmail = section1?.faculty_supervisor_email;
      const nextSectionEmail = replaceProjectFacultyEmail(currentSectionEmail);
      const sectionChanged =
        !!section1 &&
        nextSectionEmail !== currentSectionEmail &&
        typeof nextSectionEmail === 'string' &&
        !!nextSectionEmail;

      const boundToOldFacultyUser =
        !!params.oldFacultyUserId &&
        report.facultyId === params.oldFacultyUserId;
      const shouldRebindFacultyUser =
        !!newFe &&
        (sectionChanged || boundToOldFacultyUser || !report.facultyId);

      if (!sectionChanged && !shouldRebindFacultyUser) {
        continue;
      }

      if (sectionChanged && section1) {
        section1.faculty_supervisor_email = nextSectionEmail;
        report.section1 = section1;
      }

      if (shouldRebindFacultyUser) {
        const linkedFacultyId = await this.resolveFacultyUserIdByEmail(newFe);
        report.facultyId = linkedFacultyId;
        if (report.faculty_status !== 'pending') {
          report.faculty_status = 'pending';
        }
      }

      await reportRepo.save(report);
      reportsUpdated += 1;
    }

    return {
      participations_updated: participationsUpdated,
      applications_updated: applicationsUpdated,
      reports_updated: reportsUpdated,
    };
  }

  private async resolveFacultyUserIdByEmail(
    email: string | null | undefined,
  ): Promise<string | null> {
    const normalized = this.normalizeEmail(email || '');
    if (!normalized) {
      return null;
    }
    const facultyUser = await this.usersRepository
      .createQueryBuilder('u')
      .where('LOWER(TRIM(u.email)) = :em', { em: normalized })
      .andWhere('u.role = :role', { role: UserRole.FACULTY })
      .getOne();
    return facultyUser?.id ?? null;
  }

  async setAttendanceRoutingOverride(
    opportunityId: string,
    override: 'auto' | 'partner' | 'faculty',
  ) {
    const opp = await this.findOne(opportunityId);
    if (!opp) throw new NotFoundException('Opportunity not found');
    opp.attendanceRoutingOverride = override;
    await this.opportunitiesRepository.save(opp);
    return { success: true, data: { attendance_routing_override: override } };
  }
}
