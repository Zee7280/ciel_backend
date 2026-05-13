import { Injectable, NotFoundException, ForbiddenException, UnauthorizedException, BadRequestException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, DeepPartial, Brackets, EntityManager, ObjectLiteral, QueryFailedError } from 'typeorm';
import { Opportunity } from './entities/opportunity.entity';
import { Organization } from '../organizations/entities/organization.entity';
import { Participation } from '../engagement/entities/participant.entity';
import { CreateOpportunityDto, UpdateOpportunityDto } from './dto/create-opportunity.dto';
import { OrganizationsService } from '../organizations/organizations.service';
import { EngagementService } from '../engagement/engagement.service';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/enums/user-role.enum';
import { getProfileCompletionStatus, resolveDisplayNameForProfile } from '../users/profile-completion.util';
import { MailService, OpportunityVerificationEmailDetails } from '../mail/mail.service';
import { randomUUID } from 'crypto';
import { OpportunityWorkflowService, WORKFLOW_STAGE, LINE_STATUS } from './opportunity-workflow.service';
import { isProjectVerificationAuthRequired } from '../common/project-verification-auth.util';
import { NotificationsService } from '../notifications/notifications.service';
import { OpportunityApplication } from './entities/opportunity-application.entity';
import { OpportunityApplicationsService } from './opportunity-applications.service';
import { StudentReport } from '../reports/entities/student-report.entity';
import { Report } from '../reports/entities/report.entity';
import { AttendanceLog } from '../engagement/entities/attendance-log.entity';
import { Payment } from '../payments/entities/payment.entity';
import { Timesheet } from '../timesheets/entities/timesheet.entity';

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
    ) { }

    private isValidEmail(email?: string) {
        if (!email) return false;
        return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
    }

    private normalizeEmail(s?: string) {
        return (s || '').trim().toLowerCase();
    }

    private async deleteChildRows(
        manager: EntityManager,
        entity: { new(): ObjectLiteral },
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

    private async deleteOpportunityChildren(manager: EntityManager, opportunityId: string) {
        const deleted = {
            attendanceLogs: await this.deleteChildRows(manager, AttendanceLog, { projectId: opportunityId }),
            payments: await this.deleteChildRows(manager, Payment, { projectId: opportunityId }),
            studentReports: await this.deleteChildRows(manager, StudentReport, [
                { opportunityId },
                { project_id: opportunityId },
            ]),
            reports: await this.deleteChildRows(manager, Report, { opportunityId }),
            timesheets: await this.deleteChildRows(manager, Timesheet, { opportunityId }),
            opportunityApplications: await this.deleteChildRows(manager, OpportunityApplication, { opportunityId }),
            participations: await this.deleteChildRows(manager, Participation, { projectId: opportunityId }),
        };

        return deleted;
    }

    private extractQueryFailedDetail(error: QueryFailedError) {
        const driverError = error.driverError as { detail?: string; message?: string } | undefined;
        return String(driverError?.detail || driverError?.message || error.message || '').trim();
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
    private hasAdditionalPartnerOrganization(dto: Pick<CreateOpportunityDto, 'partner_organization'>): boolean {
        const po = dto.partner_organization as Record<string, unknown> | null | undefined;
        if (!po || typeof po !== 'object') return false;
        const email = typeof po['official_email'] === 'string' ? po['official_email'].trim() : '';
        const name = typeof po['organization_name'] === 'string' ? po['organization_name'].trim() : '';
        return email.length > 0 || name.length > 0;
    }

    /**
     * Partner contact email for student-created opportunities (legacy + new payload shapes).
     * Priority: external_partner_collaboration → supervision external/partner fields → executing_context.partner → partner_organization.
     */
    private resolvePartnerEmail(dto: CreateOpportunityDto): string | null {
        const collab = dto.external_partner_collaboration as { official_email?: string } | undefined;
        const fromCollab =
            collab && typeof collab.official_email === 'string' ? collab.official_email : undefined;
        const sup = dto.supervision as
            | { external_partner_email?: string; partner_email?: string }
            | undefined;
        const fromSupExt = sup && typeof sup.external_partner_email === 'string' ? sup.external_partner_email : undefined;
        const fromSupPartner = sup && typeof sup.partner_email === 'string' ? sup.partner_email : undefined;
        const ctx = dto.executing_context as { partner?: { official_email?: string } } | undefined;
        const fromCtx =
            ctx?.partner && typeof ctx.partner.official_email === 'string' ? ctx.partner.official_email : undefined;
        const po = dto.partner_organization as { official_email?: string } | undefined;
        const fromPo = po && typeof po.official_email === 'string' ? po.official_email : undefined;

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
            if (timeline.start_date) tl.push(`Starts: ${String(timeline.start_date)}`);
            if (timeline.end_date) tl.push(`Ends: ${String(timeline.end_date)}`);
            if (timeline.expected_hours != null && timeline.expected_hours !== '') {
                tl.push(`Expected hours: ${String(timeline.expected_hours)}`);
            }
        }
        const sup = opp.supervision as Record<string, unknown> | null | undefined;
        const supervisorBits: string[] = [];
        if (sup && typeof sup === 'object') {
            if (typeof sup.supervisor_name === 'string' && sup.supervisor_name.trim()) {
                supervisorBits.push(sup.supervisor_name.trim());
            }
            if (typeof sup.faculty_department === 'string' && sup.faculty_department.trim()) {
                supervisorBits.push(sup.faculty_department.trim());
            }
            if (typeof sup.faculty_university_name === 'string' && sup.faculty_university_name.trim()) {
                supervisorBits.push(sup.faculty_university_name.trim());
            }
        }
        let partnerOrg: string | undefined;
        if (sup && typeof sup.partner_org_name === 'string' && sup.partner_org_name.trim()) {
            partnerOrg = sup.partner_org_name.trim();
        }
        const po = opp.partner_organization as {
            organization_name?: string;
            contact_person_name?: string;
        } | undefined;
        if (!partnerOrg && po?.organization_name?.trim()) partnerOrg = po.organization_name.trim();
        const collab = opp.external_partner_collaboration as {
            organization_name?: string;
            contact_person_name?: string;
            contact_name?: string;
        } | undefined;
        if (!partnerOrg && collab?.organization_name?.trim()) partnerOrg = collab.organization_name.trim();
        const ectPartner = opp.executing_context?.partner as {
            organization_name?: string;
            contact_person_name?: string;
            contact_name?: string;
        } | undefined;
        if (!partnerOrg && ectPartner?.organization_name?.trim()) partnerOrg = ectPartner.organization_name.trim();

        let partnerRecipientName: string | undefined;
        const supPartnerContact =
            sup && typeof sup === 'object' && typeof sup.partner_contact_person === 'string' && sup.partner_contact_person.trim()
                ? sup.partner_contact_person.trim()
                : undefined;
        if (po?.contact_person_name?.trim()) partnerRecipientName = po.contact_person_name.trim();
        else if (collab?.contact_person_name?.trim()) partnerRecipientName = collab.contact_person_name.trim();
        else if (collab?.contact_name?.trim()) partnerRecipientName = collab.contact_name.trim();
        else if (ectPartner?.contact_person_name?.trim()) partnerRecipientName = ectPartner.contact_person_name.trim();
        else if (ectPartner?.contact_name?.trim()) partnerRecipientName = ectPartner.contact_name.trim();
        else if (supPartnerContact) partnerRecipientName = supPartnerContact;
        else if (partnerOrg) partnerRecipientName = partnerOrg;

        const ect = opp.executing_context as { type?: string } | undefined;
        let executionSummary: string | undefined;
        if (ect?.type === 'partner') executionSummary = 'With host / partner organization';
        else if (ect?.type === 'independent') executionSummary = 'Independent community activity';

        let objectivesPreview: string | undefined;
        const obj = opp.objectives as { description?: string } | undefined;
        if (obj?.description && typeof obj.description === 'string') {
            const raw = obj.description.trim();
            if (raw) objectivesPreview = raw.length > 300 ? `${raw.slice(0, 297)}…` : raw;
        }

        let sdgLabel: string | undefined;
        const sdg = opp.sdg_info as { sdg_id?: string } | undefined;
        if (sdg?.sdg_id) sdgLabel = String(sdg.sdg_id);
        else if (opp.sdg && opp.sdg !== 'SDG') sdgLabel = opp.sdg;

        const loc = opp.location as { city?: string; venue?: string } | undefined;
        const locParts = [loc?.city, loc?.venue].filter((x): x is string => typeof x === 'string' && !!x.trim());

        const scope = opp.participation_scope as { creator_university_name?: string } | null | undefined;
        const creatorUni =
            scope && typeof scope.creator_university_name === 'string' && scope.creator_university_name.trim()
                ? scope.creator_university_name.trim()
                : undefined;
        const institutionName = meta.studentUniversity?.trim() || creatorUni;

        let facultyReviewerName: string | undefined;
        let departmentName: string | undefined;
        if (sup && typeof sup === 'object') {
            if (typeof sup.supervisor_name === 'string' && sup.supervisor_name.trim()) {
                facultyReviewerName = sup.supervisor_name.trim();
            }
            if (typeof sup.faculty_department === 'string' && sup.faculty_department.trim()) {
                departmentName = sup.faculty_department.trim();
            }
        }

        let volunteersRequired: string | undefined;
        if (timeline && typeof timeline === 'object' && timeline.volunteers_required != null && timeline.volunteers_required !== '') {
            volunteersRequired = String(timeline.volunteers_required);
        }

        return {
            opportunityId: opp.id,
            mode: opp.mode || undefined,
            typesLine: opp.types?.length ? opp.types.join(', ') : undefined,
            timelineSummary: tl.length ? tl.join(' · ') : undefined,
            locationSummary: locParts.length ? locParts.join(', ') : undefined,
            sdgLabel,
            partnerOrganization: partnerOrg,
            partnerRecipientName,
            executionSummary,
            facultySupervisionLine: supervisorBits.length ? supervisorBits.join(' · ') : undefined,
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
            if (opportunity.facultyId && user.id === opportunity.facultyId) return true;
            const sup = opportunity.supervision as Record<string, unknown> | undefined;
            const c = this.normalizeEmail(typeof sup?.contact === 'string' ? sup.contact : '');
            const oe = this.normalizeEmail(typeof sup?.official_email === 'string' ? sup.official_email : '');
            if (ue === c || (!!oe && ue === oe)) return true;
            const po = opportunity.partner_organization as Record<string, unknown> | undefined;
            const poe = this.normalizeEmail(typeof po?.official_email === 'string' ? po.official_email : '');
            return !!poe && ue === poe;
        }
        const pe = this.resolvePartnerEmailFromOpportunity(opportunity);
        if (!pe || ue !== this.normalizeEmail(pe)) return false;
        if (user.role === UserRole.STUDENT) return false;
        return true;
    }

    /**
     * When VERIFICATION_REQUIRE_AUTH is enabled, the logged-in user must match the email / faculty
     * binding for the magic link (partner vs faculty vs legacy liaison).
     */
    private assertVerificationIdentityIfRequired(
        opportunity: Opportunity,
        token: string,
        user?: { id: string; email: string; role: string },
    ): void {
        if (!this.verificationAuthRequired()) return;
        if (!user?.id) {
            throw new UnauthorizedException('Login required to verify this link.');
        }
        const kind = this.projectVerificationTokenKind(opportunity, token);
        if (!kind) return;
        if (!this.verificationUserMatchesToken(opportunity, kind, user)) {
            throw new ForbiddenException('Ye link is account se link nahi hai');
        }
    }

    /**
     * F2 "partner organization" block: separate collaboration contact who must acknowledge in the portal
     * when their email is not the same as the executing-organization official contact.
     */
    private shouldRequirePartnerOrganizationAck(dto: CreateOpportunityDto): boolean {
        const po = dto.partner_organization as { official_email?: string } | undefined;
        const raw = po && typeof po.official_email === 'string' ? po.official_email : undefined;
        const pe = this.normalizeEmail(raw);
        if (!pe || !this.isValidEmail(pe)) return false;
        const exec = dto.executing_organization as { official_email?: string } | undefined;
        const ee =
            exec && typeof exec.official_email === 'string' ? this.normalizeEmail(exec.official_email) : null;
        if (!ee) return true;
        return pe !== ee;
    }

    /** Whether partner approval + email flow applies for this student submission. */
    private studentOpportunityRequiresPartner(dto: CreateOpportunityDto): boolean {
        const typePartner = dto.executing_context?.type === 'partner';
        const collab = dto.external_partner_collaboration;
        const hasCollab =
            collab !== null &&
            collab !== undefined &&
            typeof collab === 'object' &&
            Object.keys(collab as object).length > 0;
        const sup = dto.supervision as { external_partner_email?: string; partner_email?: string } | undefined;
        const hasSupPartnerLead = !!(sup?.external_partner_email || sup?.partner_email);
        return typePartner || hasCollab || hasSupPartnerLead || this.shouldRequirePartnerOrganizationAck(dto);
    }

    /**
     * Liaison/partner links do not log the faculty in; set facultyId from supervision.contact first,
     * then partner_organization.official_email if needed, so approvals/history bind to the faculty account.
     */
    private async assignFacultyIdFromSupervisionIfMissing(opp: Opportunity): Promise<void> {
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
        const rawPo = po && typeof po.official_email === 'string' ? po.official_email : '';
        await tryBindFacultyByEmail(rawPo);
    }

    /**
     * One new organization row per student opportunity when there is no named partner org.
     * Same student creating many opportunities → many placeholder orgs (no shared dummy).
     */
    private async createPlaceholderOrganizationForStudentOpportunity(opportunityTitle: string): Promise<string> {
        const t = (opportunityTitle || 'Untitled').trim().slice(0, 72);
        const tag = randomUUID().slice(0, 8);
        const name = `Student opportunity — ${t} — ${tag}`;
        const row = this.organizationsRepository.create({
            name,
            orgType: 'OTHER',
            verificationStatus: 'unclaimed_student_initiated',
            country: 'Pakistan',
            countryCode: 'PK',
            description: 'Auto-created placeholder for a student-submitted opportunity (not a partner site).',
        });
        const saved = await this.organizationsRepository.save(row);
        return saved.id;
    }

    private normalizeSafetyDeclaration(safety?: any) {
        if (!safety) return safety;
        return {
            environment_safe_and_appropriate:
                safety.environment_safe_and_appropriate ?? safety.site_safe_and_suitable,
            students_guided_and_supervised:
                safety.students_guided_and_supervised ?? safety.students_properly_supervised,
            lawful_ethical_and_non_hazardous:
                safety.lawful_ethical_and_non_hazardous ?? safety.lawful_and_free_from_hazards,
            precautions_and_basic_safety:
                safety.precautions_and_basic_safety ?? safety.basic_safety_and_emergency_measures,
        };
    }

    private validateSafetyDeclaration(safety?: any) {
        if (!safety) throw new BadRequestException('safety_declaration is required');
        const normalized = this.normalizeSafetyDeclaration(safety);
        const keys = [
            'environment_safe_and_appropriate',
            'students_guided_and_supervised',
            'lawful_ethical_and_non_hazardous',
            'precautions_and_basic_safety'
        ];
        const allTrue = keys.every(k => normalized[k] === true);
        if (!allTrue) {
            throw new BadRequestException('All safety_declaration checks must be true');
        }
    }

    private resolveSafetyDeclarationPayload(dto: { safety_declaration?: any; safety_supervision_declaration?: any }) {
        return dto.safety_declaration ?? dto.safety_supervision_declaration;
    }

    private validateSubmissionConfirmations(confirm?: any) {
        if (!confirm) throw new BadRequestException('submission_confirmations are required');
        const normalized = {
            academically_valid_and_accurately_described:
                confirm.academically_valid_and_accurately_described ?? confirm.genuine_and_accurate,
            activity_properly_supervised:
                confirm.activity_properly_supervised ?? confirm.organization_responsible_for_execution,
            environment_safe_and_appropriate:
                confirm.environment_safe_and_appropriate,
            information_correct_and_verifiable:
                confirm.information_correct_and_verifiable,
        };
        const keys = [
            'academically_valid_and_accurately_described',
            'activity_properly_supervised',
            'environment_safe_and_appropriate',
            'information_correct_and_verifiable'
        ];
        if (!keys.every(k => normalized[k] === true)) {
            throw new BadRequestException('All submission_confirmations must be true');
        }
    }

    private validateParticipationScope(scope?: any) {
        if (!scope) return; // backward compatibility
        const rule = scope.rule;
        if (!rule) throw new BadRequestException('participation_scope.rule is required');
        const uniNames: string[] = scope.university_names || [];
        const creatorUni = scope.creator_university_name || '';
        const deptScope = scope.department_restriction?.scope || 'all';
        const departments: string[] = scope.department_restriction?.departments || [];

        const needDepts = ['departments_across_universities', 'own_university_departments'].includes(rule) || deptScope === 'specific';
        if (needDepts && (!departments || departments.length === 0)) {
            throw new BadRequestException('Department list required for department-specific participation_scope');
        }

        const needUniList = ['restricted_specific_universities', 'departments_across_universities'].includes(rule);
        if (needUniList && uniNames.length === 0) {
            throw new BadRequestException('University list required for participation_scope.rule');
        }

        if (rule === 'own_university_only' && creatorUni && uniNames.length === 0) {
            scope.university_names = [creatorUni];
        }
        if (rule === 'own_university_departments' && creatorUni && uniNames.length === 0) {
            scope.university_names = [creatorUni];
        }
    }

    private validateSupervision(supervision: any) {
        if (!supervision) return;
        if (supervision.contact && !this.isValidEmail(supervision.contact)) {
            throw new BadRequestException('supervision.contact must be a valid email');
        }
        if (supervision.external_partner_email && !this.isValidEmail(supervision.external_partner_email)) {
            throw new BadRequestException('supervision.external_partner_email must be a valid email');
        }
        if (supervision.partner_email && !this.isValidEmail(supervision.partner_email)) {
            throw new BadRequestException('supervision.partner_email must be a valid email');
        }
        if (supervision.faculty_department === '') throw new BadRequestException('faculty_department is required');
        if (supervision.faculty_university_name === '') throw new BadRequestException('faculty_university_name is required');
    }

    private validateExternalPartner(collab?: any) {
        if (!collab) return;
        const { organization_name, contact_person, official_email } = collab;
        if (!organization_name || !contact_person || !official_email) {
            throw new BadRequestException('external_partner_collaboration requires organization_name, contact_person, official_email');
        }
        if (!this.isValidEmail(official_email)) {
            throw new BadRequestException('external_partner_collaboration.official_email must be valid');
        }
    }

    private ensureProfileComplete(user: User) {
        const { profile_complete, profile_missing_fields } = getProfileCompletionStatus(user);
        if (!profile_complete) {
            throw new ForbiddenException(`Profile incomplete: missing ${profile_missing_fields.join(', ')}`);
        }
    }

    async getOccupiedSeats(opportunityId: string): Promise<number> {
        return await this.participationRepository.count({
            where: {
                projectId: opportunityId,
                status: In(['pending', 'accepted', 'approved', 'verified', 'paid', 'pending_payment_approval', 'pending_ciel_approval', 'pending_faculty_approval'])
            }
        });
    }

    private async getFacultyOrgFallback(facultyId?: string | null) {
        if (!facultyId) return null;
        const faculty = await this.usersRepository.findOne({ where: { id: facultyId } });
        if (!faculty) return null;
        return {
            id: null,
            name: faculty.institution || faculty.university || faculty.name,
            logo_url: null
        };
    }

    private readonly publicLiveStatuses = ['active', 'live', 'open', 'recruiting'];

    private normalizeOpportunityStatus(status?: string | null): string | null {
        const normalized = (status || '').trim().toLowerCase();
        if (!normalized) return null;
        if (this.publicLiveStatuses.includes(normalized)) return 'active';
        if (['completed', 'complete', 'verified', 'finalized'].includes(normalized)) return 'completed';
        if (['closed', 'inactive', 'draft', 'rejected', 'cancelled', 'canceled'].includes(normalized)) {
            return 'closed';
        }
        return normalized;
    }

    private buildOpportunityOrganization(
        opp: Opportunity,
        orgFallback?: { id: string | null; name: string | null; logo_url: string | null } | null,
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
        orgFallback?: { id: string | null; name: string | null; logo_url: string | null } | null,
        detail = false,
    ) {
        const volunteersRequired = opp.timeline?.volunteers_required || 0;
        const organization = this.buildOpportunityOrganization(opp, orgFallback);
        const organizationName =
            organization?.name ||
            opp.partner_organization?.organization_name ||
            opp.executing_organization?.name ||
            null;

        const base = {
            id: opp.id,
            title: opp.title,
            description: opp.objectives?.description || '',
            status: this.getApiOpportunityStatus(opp),
            mode: opp.mode,
            types: opp.types,
            sdg: opp.sdg_info?.sdg_id || opp.sdg || null,
            sdg_info: opp.sdg_info,
            organization_name: organizationName,
            organization,
            participant_count: occupiedSeats,
            remaining_seats: Math.max(0, volunteersRequired - occupiedSeats),
            volunteersNeeded: volunteersRequired,
            location: opp.location,
            timeline: opp.timeline,
            start_date: opp.timeline?.start_date,
            end_date: opp.timeline?.end_date,
            from_time: opp.timeline?.from_time,
            to_time: opp.timeline?.to_time,
            ...this.getWorkflowResponseFields(opp),
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
        };
    }

    private getApiOpportunityStatus(opp: Opportunity): string | null {
        if (opp.workflowStage === WORKFLOW_STAGE.LIVE && opp.admin_approved) return 'live';
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
        return {
            workflow_stage: opp.workflowStage ?? null,
            faculty_approval_status: opp.facultyApprovalStatus ?? null,
            partner_approval_status: opp.partnerApprovalStatus ?? null,
            admin_approval_status: opp.adminApprovalStatus ?? null,
        };
    }

    /** Whether CIEL admin final-approve may run without skipping required gates. */
    private isOpportunityReadyForAdminFinalApprove(opp: Opportunity): boolean {
        if (opp.isStudentCreated) {
            if (opp.workflowStage === WORKFLOW_STAGE.PENDING_ADMIN) return true;
            if (!opp.workflowStage && opp.status === 'pending_approval') return true;
            return false;
        }
        if (opp.requiresPartnerApproval && !opp.partnerVerified) return false;
        if (opp.status === 'pending_partner') return false;
        if (opp.workflowStage === WORKFLOW_STAGE.PENDING_PARTNER) return false;
        // `pending_execution` is also used for org/faculty rows waiting on executing-org confirmation in
        // parallel with CIEL review (`afterFacultyCreatedPartnerVerified`). Those must still allow final
        // admin approval when a CIEL admin step exists; `afterAdminApproved` keeps the listing gated until
        // execution verifies when needed.
        if (opp.status === 'pending_execution' && opp.admin_approval_required !== true) {
            return false;
        }
        return true;
    }

    /** Short label for the admin approvals queue (student pipeline + final step). */
    private describeAdminQueueFlow(opp: Opportunity): { flow_status: string; admin_can_approve: boolean } {
        const admin_can_approve = this.isOpportunityReadyForAdminFinalApprove(opp);
        const st = opp.status;
        if (opp.isStudentCreated) {
            const ws = opp.workflowStage;
            if (ws === WORKFLOW_STAGE.PENDING_FACULTY || st === 'pending_faculty' || st === 'pending_verification') {
                return { flow_status: 'Awaiting faculty / liaison', admin_can_approve: false };
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

    /** Public directory: honor org/creator visibility flags only. Participation rules apply at apply/enroll time. */
    private isPubliclyVisibleOpportunity(opp: Opportunity): boolean {
        const linkage = opp.visibility_and_academic_linkage;
        const explicitType =
            linkage && typeof linkage.visibility_type === 'string'
                ? linkage.visibility_type.trim().toLowerCase()
                : '';

        if (explicitType) {
            return !['own_university_only', 'restricted_specific_universities', 'restricted'].includes(
                explicitType,
            );
        }

        // Student flow defaults top-level `visibility` to "restricted" while scope lives in
        // participation_scope; treat that default as public listing. Faculty/org "restricted"
        // without linkage still suppresses the directory (previous behavior).
        const legacy = String(opp.visibility || '').trim().toLowerCase();
        if (['own_university_only', 'restricted_specific_universities'].includes(legacy)) {
            return false;
        }
        if (legacy === 'restricted' && !opp.isStudentCreated) {
            return false;
        }
        return true;
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
            select: ['id', 'email', 'name', 'university', 'institution'],
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

    private async sendPartnerApprovalEmail(opportunity: Opportunity) {
        if (!opportunity.partnerToken) return;
        const partnerEmail = this.resolvePartnerEmailFromOpportunity(opportunity);
        if (!partnerEmail) return;

        const creator = await this.getOpportunityCreatorContact(opportunity);
        const details = this.buildOpportunityVerificationEmailDetails(opportunity, {
            studentName: creator?.name || undefined,
            studentUniversity: creator?.university || creator?.institution || undefined,
        });

        try {
            await this.mailService.sendPartnerVerification(
                partnerEmail,
                opportunity.title,
                opportunity.partnerToken,
                details,
                {
                    path: '/verify-project',
                    returnTo: this.getPartnerApprovalReturnTo(opportunity.id),
                    introText:
                        `The faculty supervisor has approved <strong>${this.escHtml(opportunity.title)}</strong>. ` +
                        'Please review the partner execution scope to continue this opportunity in CIEL.',
                    ctaLabel: 'Review partner approval',
                },
            );
        } catch (error) {
            console.warn('Failed to send partner approval email', (error as Error).message);
        }
    }

    private async sendAdminReviewEmail(opportunity: Opportunity, stageLabel: string) {
        try {
            await this.mailService.sendAdminOpportunityReviewNeeded(
                opportunity.title,
                opportunity.id,
                stageLabel,
            );
        } catch (error) {
            console.warn('Failed to send admin review email', (error as Error).message);
        }
    }

    private escHtml(input: string) {
        return String(input)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    private async handleFacultyApprovedSideEffects(opportunity: Opportunity) {
        if (!opportunity.isStudentCreated) return;

        if (opportunity.workflowStage === WORKFLOW_STAGE.PENDING_PARTNER) {
            await this.sendPartnerApprovalEmail(opportunity);
            await this.notifyStudentOpportunityUpdate(opportunity, {
                title: 'Faculty Approved',
                message:
                    'Your opportunity has passed faculty review and is now waiting for partner approval.',
                emailSubject: 'Faculty approved your opportunity',
            });
            return;
        }

        if (opportunity.workflowStage === WORKFLOW_STAGE.PENDING_ADMIN) {
            await this.sendAdminReviewEmail(opportunity, 'faculty approval');
            await this.notifyStudentOpportunityUpdate(opportunity, {
                title: 'Faculty Approved',
                message:
                    'Your opportunity has passed faculty review and is now waiting for admin approval.',
                emailSubject: 'Faculty approved your opportunity',
            });
        }
    }

    private async handlePartnerApprovedSideEffects(opportunity: Opportunity) {
        const execBlocking =
            !!opportunity.execution_verification_token && !opportunity.execution_verified;
        if (!execBlocking || opportunity.isStudentCreated) {
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
        if (!opportunity.isStudentCreated) return;

        // Single in-app notification (two used to fire here and could surface as duplicate alerts / digests).
        await this.notifyStudentOpportunityUpdate(opportunity, {
            title: 'Opportunity live',
            message:
                'Your opportunity has passed admin review and is now live on CIEL. You can begin your report from your dashboard.',
            emailSubject: 'Your opportunity is now live',
            skipStatusEmail: true,
        });

        const creator = await this.getOpportunityCreatorContact(opportunity);
        if (creator?.email) {
            try {
                await this.mailService.sendStudentOpportunityFullyApprovedEmail(
                    creator.email,
                    creator.name || 'Student',
                    opportunity.title,
                    opportunity.id,
                );
            } catch (error) {
                console.warn(
                    'Failed to send student fully approved opportunity email',
                    (error as Error).message,
                );
            }
        }

        try {
            await this.mailService.sendAdminStudentMayStartReport(
                opportunity.title || 'Project',
                opportunity.id,
                creator?.name || creator?.email || 'Student',
            );
        } catch (error) {
            console.warn('Failed to send admin start-report notice', (error as Error).message);
        }
    }

    async create(userId: string, createOpportunityDto: CreateOpportunityDto) {
        const user = await this.usersRepository.findOne({ where: { id: userId }, relations: ['organization'] });
        if (!user) {
            throw new ForbiddenException('User not found');
        }
        this.ensureProfileComplete(user);
        createOpportunityDto.safety_declaration = this.resolveSafetyDeclarationPayload(createOpportunityDto);
        createOpportunityDto.safety_declaration = this.normalizeSafetyDeclaration(createOpportunityDto.safety_declaration);

        this.validateSupervision(createOpportunityDto.supervision);
        this.validateSafetyDeclaration(createOpportunityDto.safety_declaration);
        this.validateSubmissionConfirmations(createOpportunityDto.submission_confirmations);
        this.validateParticipationScope(createOpportunityDto.participation_scope);
        this.validateExternalPartner(createOpportunityDto.external_partner_collaboration);

        const org = await this.organizationsService.getMyOrganization(userId);

        if (!org && user.role !== UserRole.FACULTY) {
            throw new ForbiddenException('User must belong to an organization to create opportunities');
        }

        const hasExecContactEmail = !!this.normalizeEmail(
            typeof createOpportunityDto.executing_organization?.official_email === 'string'
                ? createOpportunityDto.executing_organization.official_email
                : undefined,
        );
        const needsExecutingOrgVerification =
            this.hasAdditionalPartnerOrganization(createOpportunityDto) && hasExecContactEmail;
        const executionVerificationToken = needsExecutingOrgVerification ? randomUUID() : null;
        const isFaculty = user.role === UserRole.FACULTY;
        /** Partner gate for faculty-authored posts (same heuristics as student flow, but only when a valid partner email exists). */
        let facultyPartnerToken: string | null = null;
        // Admin queue (findAllPending) lists only pending_approval. Faculty-created opps used to default to
        // pending_execution when admin_approval_required was false, so they never appeared for CIEL Admin.
        let initialStatus: string;
        if (needsExecutingOrgVerification) {
            initialStatus = 'pending_execution';
        } else if (isFaculty) {
            const wantsPartner = this.studentOpportunityRequiresPartner(createOpportunityDto);
            const partnerContact = wantsPartner ? this.resolvePartnerEmail(createOpportunityDto) : null;
            const requiresPartnerGate = !!(wantsPartner && partnerContact);
            facultyPartnerToken = requiresPartnerGate ? randomUUID() : null;
            initialStatus = requiresPartnerGate ? 'pending_partner' : 'pending_approval';
        } else if (createOpportunityDto.admin_approval_required) {
            initialStatus = 'pending_approval';
        } else {
            initialStatus = 'pending_execution';
        }

        /** Distinct partner_organization contact must acknowledge (even when executing-org portal step runs first). */
        const needsPartnerOrgAck = this.shouldRequirePartnerOrganizationAck(createOpportunityDto);
        let resolvedPartnerToken: string | null =
            isFaculty && !needsExecutingOrgVerification && facultyPartnerToken ? facultyPartnerToken : null;
        if (needsPartnerOrgAck && !resolvedPartnerToken) {
            resolvedPartnerToken = randomUUID();
        }

        const payload: DeepPartial<Opportunity> = {
            ...createOpportunityDto,
            organizationId: org?.id || null,
            facultyId: user.role === UserRole.FACULTY ? user.id : null,
            creatorId: user.id,
            status: initialStatus,
            execution_verification_token: executionVerificationToken,
            execution_verified: !executionVerificationToken,
            execution_verification_status: executionVerificationToken ? 'pending_execution' : 'execution_verified',
            sdg: createOpportunityDto.sdg_info?.sdg_id || 'SDG', // Fallback
            ...(resolvedPartnerToken
                ? {
                      partnerToken: resolvedPartnerToken,
                      partnerVerified: false,
                      requiresPartnerApproval: true,
                      partnerApprovalStatus: LINE_STATUS.PENDING,
                      ...(isFaculty
                          ? { facultyApprovalStatus: LINE_STATUS.APPROVED, adminApprovalStatus: LINE_STATUS.PENDING }
                          : {}),
                  }
                : {}),
        };

        const opportunity = this.opportunitiesRepository.create(payload);
        if (isFaculty && !needsExecutingOrgVerification) {
            // Align workflow with any partner gate (magic link): `resolvedPartnerToken` can be set via
            // `needsPartnerOrgAck` even when `facultyPartnerToken` was not (e.g. org-ack-only path).
            this.opportunityWorkflow.initFacultyCreated(
                opportunity as Opportunity,
                !!resolvedPartnerToken,
            );
        }

        const saved = await this.opportunitiesRepository.save(opportunity);

        // Notify executing-org contact: sign in and confirm from opportunity detail (no public token link).
        if (executionVerificationToken && createOpportunityDto.executing_organization?.official_email) {
            const verifyBase = (process.env.FRONTEND_URL || process.env.APP_URL || '').replace(/\/+$/, '');
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
                console.warn('Failed to send executing org verification email', e.message);
            }
        }

        // Informational notice only when there is no magic-link partner gate for this row.
        const partnerEmail = createOpportunityDto.partner_organization?.official_email;
        if (partnerEmail && !resolvedPartnerToken) {
            try {
                await this.mailService.sendPartnerOpportunityNotice(partnerEmail, saved.title);
            } catch (e) {
                console.warn('Failed to send partner org email', e.message);
            }
        }

        if (resolvedPartnerToken) {
            const pe = this.resolvePartnerEmail(createOpportunityDto);
            if (pe) {
                try {
                    const verifyDetails = this.buildOpportunityVerificationEmailDetails(saved as Opportunity, {
                        facultyAuthorName: resolveDisplayNameForProfile(user),
                        facultyAuthorEmail: user.email || undefined,
                    });
                    await this.mailService.sendPartnerVerification(pe, saved.title, resolvedPartnerToken, verifyDetails, {
                        path: '/verify-project',
                        returnTo: this.getPartnerApprovalReturnTo(saved.id),
                    });
                } catch (e) {
                    console.warn('Failed to send partner verification email for opportunity', (e as Error).message);
                }
            }
        }

        const execBlocking = !!saved.execution_verification_token && !saved.execution_verified;
        const notAwaitingFacultyOrPartner =
            saved.workflowStage !== WORKFLOW_STAGE.PENDING_FACULTY &&
            saved.workflowStage !== WORKFLOW_STAGE.PENDING_PARTNER;
        if (
            saved.status === 'pending_approval' &&
            !saved.admin_approved &&
            !execBlocking &&
            notAwaitingFacultyOrPartner
        ) {
            await this.sendAdminReviewEmail(saved as Opportunity, 'new submission');
        }

        return saved;
    }

    async createStudentOpportunity(userId: string, dto: CreateOpportunityDto) {
        const user = await this.usersRepository.findOne({ where: { id: userId }, relations: ['organization'] });
        if (!user) throw new ForbiddenException('User not found');
        this.ensureProfileComplete(user);
        dto.safety_declaration = this.resolveSafetyDeclarationPayload(dto);
        dto.safety_declaration = this.normalizeSafetyDeclaration(dto.safety_declaration);
        // validation rules for student flow
        if (!dto.supervision?.contact) throw new BadRequestException('Faculty email (supervision.contact) is required');
        if (!dto.supervision?.faculty_department) throw new BadRequestException('faculty_department is required');
        if (!dto.executing_context?.type) throw new BadRequestException('executing_context.type is required');
        this.validateSafetyDeclaration(dto.safety_declaration);
        this.validateSubmissionConfirmations(dto.submission_confirmations);
        this.validateParticipationScope(dto.participation_scope);
        this.validateSupervision(dto.supervision);
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
            if (!ind.activity_site_description) throw new BadRequestException('independent activity_site_description required');
        }

        const restricted = dto.restricted_universities && dto.restricted_universities.length > 0
            ? dto.restricted_universities
            : (dto.participation_scope?.creator_university_name ? [dto.participation_scope.creator_university_name] : []);

        const requiresPartner = this.studentOpportunityRequiresPartner(dto);
        const partnerEmail = requiresPartner ? this.resolvePartnerEmail(dto) : null;
        if (requiresPartner && !partnerEmail) {
            throw new BadRequestException(
                'Partner approval is required for this submission but no valid partner email was found. Provide official_email in external_partner_collaboration, executing_context.partner, supervision.partner_email / external_partner_email, or partner_organization.',
            );
        }
        const partnerToken = requiresPartner && partnerEmail ? randomUUID() : null;

        let organizationId: string | null = null;
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
        }

        if (!organizationId) {
            organizationId = await this.createPlaceholderOrganizationForStudentOpportunity(dto.title || '');
        }

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

        const payload: DeepPartial<Opportunity> = {
            ...dto,
            organizationId,
            facultyId: resolvedFacultyId,
            creatorId: user.id,
            status: 'pending_faculty',
            sdg: dto.sdg_info?.sdg_id || 'SDG',
            restricted_universities: restricted,
            visibility: dto.visibility || 'restricted',
            faculty_verification_status: 'pending_faculty',
            faculty_verified: false,
            faculty_verification_token: randomUUID(),
            isStudentCreated: true,
            requiresPartnerApproval: requiresPartner,
            partnerToken: partnerToken ?? undefined,
            partnerVerified: !requiresPartner,
        };

        const opportunity = this.opportunitiesRepository.create(payload);
        this.opportunityWorkflow.initStudentCreated(opportunity as Opportunity, requiresPartner);
        const saved = await this.opportunitiesRepository.save(opportunity);

        const facultyTo = this.normalizeEmail(dto.supervision.contact);
        const studentVerifyDetails = this.buildOpportunityVerificationEmailDetails(saved as Opportunity, {
            studentName: resolveDisplayNameForProfile(user),
            studentUniversity: user.university || user.institution || undefined,
        });
        try {
            await this.mailService.sendFacultyStudentOpportunityVerification(
                facultyTo,
                saved.title,
                saved.faculty_verification_token,
                studentVerifyDetails,
                {
                    path: '/verify/faculty',
                    returnTo: this.getFacultyApprovalReturnTo(saved.id),
                },
            );
        } catch (e) {
            console.warn('Failed to send faculty verification email', (e as Error).message);
        }

        if (partnerEmail && partnerToken) {
            try {
                await this.mailService.sendPartnerVerification(
                    partnerEmail,
                    saved.title,
                    partnerToken,
                    studentVerifyDetails,
                    {
                        path: '/verify-project',
                        returnTo: this.getPartnerApprovalReturnTo(saved.id),
                    },
                );
            } catch (e) {
                console.warn('Failed to send partner verification email', (e as Error).message);
            }
        }

        return { success: true, data: saved };
    }

    async update(userId: string, updateOpportunityDto: UpdateOpportunityDto, organizationId?: string) {
        const opportunity = await this.opportunitiesRepository.findOne({ where: { id: updateOpportunityDto.id } });
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

        let orgId = organizationId;
        if (!orgId) {
            const org = await this.organizationsService.getMyOrganization(userId);
            orgId = org?.id;
        }

        if (!isFacultyOwner) {
            if (!orgId) {
                throw new ForbiddenException('User must belong to an organization to update opportunities');
            }
            if (opportunity.organizationId !== orgId) {
                console.log(`Access Denied: Org ID mismatch. UserOrg: ${orgId}, OpportunityOrg: ${opportunity.organizationId}`);
                throw new ForbiddenException('You do not have access to this opportunity');
            }
        }

        const rejectedResubmitSnapshot = {
            wasRejected:
                opportunity.status === 'rejected' ||
                opportunity.workflowStage === WORKFLOW_STAGE.REJECTED ||
                opportunity.adminApprovalStatus === LINE_STATUS.REJECTED ||
                opportunity.partnerApprovalStatus === LINE_STATUS.REJECTED,
            partnerLineRejected: opportunity.partnerApprovalStatus === LINE_STATUS.REJECTED,
            /** Snapshot before patch — student pipeline must never use NGO resubmit logic. */
            isStudentCreated: opportunity.isStudentCreated,
        };

        const { id: _dtoId, ...patch } = updateOpportunityDto as UpdateOpportunityDto & { id: string };
        Object.assign(opportunity, patch);

        if (updateOpportunityDto.sdg_info) {
            opportunity.sdg = updateOpportunityDto.sdg_info.sdg_id || opportunity.sdg;
        }

        // Faculty edit/resubmit: force opportunity back into review lanes for fresh approval.
        if (isFacultyOwner && !opportunity.isStudentCreated) {
            const requiresPartnerApproval =
                this.studentOpportunityRequiresPartner(opportunity as unknown as CreateOpportunityDto) &&
                !!this.resolvePartnerEmailFromOpportunity(opportunity);

            this.opportunityWorkflow.initFacultyCreated(opportunity, requiresPartnerApproval);
            opportunity.admin_approved = false;
            opportunity.rejectionReason = null;
            opportunity.partnerVerified = !requiresPartnerApproval;

            if (opportunity.execution_verification_token && !opportunity.execution_verified) {
                opportunity.status = 'pending_execution';
                opportunity.execution_verification_status = 'pending_execution';
                opportunity.adminApprovalStatus = LINE_STATUS.PENDING;
            }
        }

        // Partner / NGO org member: after admin (or partner) rejection, saving edits resubmits into review queues.
        const isPartnerOrgMemberUpdate =
            !isFacultyOwner &&
            !!orgId &&
            opportunity.organizationId === orgId &&
            !rejectedResubmitSnapshot.isStudentCreated;

        if (rejectedResubmitSnapshot.wasRejected && isPartnerOrgMemberUpdate) {
            opportunity.rejectionReason = null;
            opportunity.admin_approved = false;

            const needsPartnerReverify =
                opportunity.requiresPartnerApproval &&
                (rejectedResubmitSnapshot.partnerLineRejected ||
                    opportunity.partnerApprovalStatus === LINE_STATUS.REJECTED);

            if (needsPartnerReverify) {
                opportunity.partnerApprovalStatus = LINE_STATUS.PENDING;
                opportunity.partnerVerified = false;
                opportunity.workflowStage = WORKFLOW_STAGE.PENDING_PARTNER;
                opportunity.status = 'pending_partner';
                opportunity.adminApprovalStatus = LINE_STATUS.PENDING;
            } else if (opportunity.execution_verification_token && !opportunity.execution_verified) {
                opportunity.status = 'pending_execution';
                opportunity.execution_verification_status = 'pending_execution';
                opportunity.workflowStage = null;
                opportunity.adminApprovalStatus = LINE_STATUS.PENDING;
            } else {
                opportunity.status = 'pending_approval';
                opportunity.workflowStage = WORKFLOW_STAGE.PENDING_ADMIN;
                opportunity.adminApprovalStatus = LINE_STATUS.PENDING;
            }

            if (opportunity.status === 'pending_approval' || opportunity.status === 'pending_execution') {
                await this.sendAdminReviewEmail(opportunity, 'partner resubmission after rejection');
            }
        }

        return this.opportunitiesRepository.save(opportunity);
    }

    /**
     * Faculty dashboard: opportunities this user created, is linked as `facultyId`,
     * is listed on supervision / partner_organization official_email, or appears on an application
     * as primary/secondary faculty email (verifier flow).
     */
    async findMineForFaculty(userId: string) {
        const user = await this.usersRepository.findOne({ where: { id: userId } });
        if (!user) {
            throw new ForbiddenException('User not found');
        }
        if (user.role !== UserRole.FACULTY) {
            throw new ForbiddenException('Only faculty can access this list');
        }

        const email = this.normalizeEmail(user.email);
        const idSet = new Set<string>();

        const ownedOrLinked = await this.opportunitiesRepository
            .createQueryBuilder('o')
            .select('o.id')
            // camelCase columns are quoted in DB; unquoted o.facultyId → facultyid (42703). Cast both as text for uuid/text param mix (42883).
            .where('("o"."creatorId")::text = :uid OR ("o"."facultyId")::text = :uid', { uid: userId })
            .getMany();
        for (const o of ownedOrLinked) {
            idSet.add(o.id);
        }

        if (email) {
            const appRepo = this.opportunitiesRepository.manager.getRepository(OpportunityApplication);
            const appRows = await appRepo
                .createQueryBuilder('app')
                .select('app.opportunityId', 'opportunityId')
                .where(
                    '(LOWER(TRIM(app.primaryFacultyEmail)) = :email OR LOWER(TRIM(COALESCE(app.secondaryFacultyEmail, \'\'))) = :email)',
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
                        qb.where(`LOWER(TRIM(COALESCE(o.supervision->>'contact', ''))) = :email`, { email })
                            .orWhere(`LOWER(TRIM(COALESCE(o.supervision->>'official_email', ''))) = :email`, {
                                email,
                            })
                            .orWhere(`LOWER(TRIM(COALESCE(o.partner_organization->>'official_email', ''))) = :email`, {
                                email,
                            });
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
                    organization_name: opp.organization?.name || null,
                };
            }),
        );

        return { items, opportunities: items, rows: items };
    }

    async findAll(userId: string, filters: any) {
        const org = await this.organizationsService.getMyOrganization(userId);
        const query = this.opportunitiesRepository.createQueryBuilder('opportunity');

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
            // Check if it's already an org ID
            try {
                const checkOrg = await this.organizationsService.findOne(filters.partner_id);
                filterOrgId = checkOrg.id;
            } catch (e) {
                // Not an org ID, maybe it's a User ID?
                const checkUserOrg = await this.organizationsService.getMyOrganization(filters.partner_id);
                if (checkUserOrg) {
                    filterOrgId = checkUserOrg.id;
                }
            }
        }

        if (filterOrgId && filterPartnerEmail) {
            // Org-owned opportunities OR student-submitted opportunities that mention this partner's email
            query.andWhere(
                `(opportunity."organizationId" = :orgId`
                + ` OR LOWER(TRIM(COALESCE(opportunity.external_partner_collaboration->>'official_email', ''))) = :pe`
                + ` OR LOWER(TRIM(COALESCE(opportunity.supervision->>'external_partner_email', ''))) = :pe`
                + ` OR LOWER(TRIM(COALESCE(opportunity.supervision->>'partner_email', ''))) = :pe`
                + ` OR LOWER(TRIM(COALESCE(opportunity.executing_context->'partner'->>'official_email', ''))) = :pe`
                + ` OR LOWER(TRIM(COALESCE(opportunity.partner_organization->>'official_email', ''))) = :pe)`,
                { orgId: filterOrgId, pe: filterPartnerEmail },
            );
        } else if (filterOrgId) {
            query.andWhere('opportunity.organizationId = :orgId', { orgId: filterOrgId });
        } else if (filterPartnerEmail) {
            query.andWhere(
                `(LOWER(TRIM(COALESCE(opportunity.external_partner_collaboration->>'official_email', ''))) = :pe`
                + ` OR LOWER(TRIM(COALESCE(opportunity.supervision->>'external_partner_email', ''))) = :pe`
                + ` OR LOWER(TRIM(COALESCE(opportunity.supervision->>'partner_email', ''))) = :pe`
                + ` OR LOWER(TRIM(COALESCE(opportunity.executing_context->'partner'->>'official_email', ''))) = :pe`
                + ` OR LOWER(TRIM(COALESCE(opportunity.partner_organization->>'official_email', ''))) = :pe)`,
                { pe: filterPartnerEmail },
            );
        }

        if (filters.status) {
            query.andWhere('opportunity.status = :status', { status: filters.status });
        }

        if (filters.limit) {
            query.take(filters.limit);
        }

        const opportunities = await query.getMany();

        return Promise.all(opportunities.map(async opp => {
            const occupiedSeats = await this.getOccupiedSeats(opp.id);
            const volunteersRequired = opp.timeline?.volunteers_required || 0;
            const orgFallback = !opp.organizationId ? await this.getFacultyOrgFallback(opp.facultyId) : null;

            return {
                ...opp,
                status: this.getApiOpportunityStatus(opp),
                location: opp.location,
                start_date: opp.timeline?.start_date,
                end_date: opp.timeline?.end_date,
                from_time: opp.timeline?.from_time,
                to_time: opp.timeline?.to_time,
                dates: opp.timeline ? { end: opp.timeline.end_date } : null,
                capacity: opp.timeline ? {
                    volunteers: volunteersRequired,
                    remaining_seats: Math.max(0, volunteersRequired - occupiedSeats)
                } : null,
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
        }));
    }

    async getPublicOpportunities(filters: any = {}) {
        // Admin-approved opportunities that are "live" for students: either legacy status in the
        // public set, or workflow live (legacy faculty flow can keep status `pending_execution` until
        // executing org verifies — same rows already surface as live in authenticated APIs).
        const orgFilter: { organizationId?: string } = {};
        if (filters.partner_id) {
            let filterOrgId = filters.partner_id;
            const checkUserOrg = await this.organizationsService.getMyOrganization(filters.partner_id);
            if (checkUserOrg) {
                filterOrgId = checkUserOrg.id;
            }
            orgFilter.organizationId = filterOrgId;
        }

        const opportunities = await this.opportunitiesRepository.find({
            where: [
                { admin_approved: true, status: In(this.publicLiveStatuses), ...orgFilter },
                { admin_approved: true, workflowStage: WORKFLOW_STAGE.LIVE, ...orgFilter },
            ],
            relations: ['organization'],
            order: { createdAt: 'DESC' },
        });
        const visibleOpportunities = opportunities.filter((opp) => this.isPubliclyVisibleOpportunity(opp));

        // We need to count participants for each opportunity
        const opportunitiesWithCounts = await Promise.all(visibleOpportunities.map(async (opp) => {
            const occupiedSeats = await this.getOccupiedSeats(opp.id);
            const orgFallback = !opp.organizationId ? await this.getFacultyOrgFallback(opp.facultyId) : null;
            return this.buildPublicOpportunityPayload(opp, occupiedSeats, orgFallback);
        }));

        return opportunitiesWithCounts;
    }

    async getPublicOpportunityById(id: string) {
        const opp = await this.opportunitiesRepository.findOne({
            where: [
                { id, admin_approved: true, status: In(this.publicLiveStatuses) },
                { id, admin_approved: true, workflowStage: WORKFLOW_STAGE.LIVE },
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
        const orgFallback = !opp.organizationId ? await this.getFacultyOrgFallback(opp.facultyId) : null;
        return this.buildPublicOpportunityPayload(opp, occupiedSeats, orgFallback, true);
    }

    async findOne(id: string) {
        return this.opportunitiesRepository.findOne({ where: { id }, relations: ['organization'] });
    }

    async findOneWithCreator(id: string) {
        const opportunity = await this.findOne(id);
        if (!opportunity) return null;

        const creator = opportunity.creatorId
            ? await this.usersRepository.findOne({
                  where: { id: opportunity.creatorId },
                  select: ['id', 'name', 'email', 'phone'],
              })
            : null;

        return {
            ...opportunity,
            creator: creator
                ? {
                      id: creator.id,
                      name: creator.name,
                      email: creator.email,
                      phone: creator.phone ?? null,
                  }
                : null,
        };
    }

    // Admin methods
    async findAllPending() {
        // CIEL admin queue: final review (`pending_approval`) plus student-created rows still with faculty/partner
        // so admins can track the pipeline (`flow_status`, `admin_can_approve`).
        // Treat NULL admin_approved like false (older rows).
        const opportunities = await this.opportunitiesRepository
            .createQueryBuilder('opportunity')
            .leftJoinAndSelect('opportunity.organization', 'organization')
            .where(
                new Brackets((qb) => {
                    qb.where(
                        new Brackets((inner) => {
                            inner
                                .where('opportunity.status = :st', { st: 'pending_approval' })
                                .andWhere(
                                    '(opportunity.admin_approved = :aa OR opportunity.admin_approved IS NULL)',
                                    { aa: false },
                                );
                        }),
                    ).orWhere(
                        new Brackets((inner) => {
                            inner
                                .where('opportunity.isStudentCreated = :isc', { isc: true })
                                .andWhere(
                                    '(opportunity.admin_approved = :aa OR opportunity.admin_approved IS NULL)',
                                    { aa: false },
                                )
                                .andWhere('opportunity.status IN (:...early)', {
                                    early: ['pending_faculty', 'pending_partner', 'pending_verification'],
                                });
                        }),
                    ).orWhere(
                        new Brackets((inner) => {
                            inner
                                .where('opportunity.isStudentCreated = :isc2', { isc2: false })
                                .andWhere(
                                    '(opportunity.admin_approved = :aa2 OR opportunity.admin_approved IS NULL)',
                                    { aa2: false },
                                )
                                .andWhere('opportunity.status IN (:...partnerOrg)', {
                                    partnerOrg: ['pending_execution', 'pending_partner'],
                                });
                        }),
                    );
                }),
            )
            .orderBy('opportunity.createdAt', 'DESC')
            .getMany();

        const creatorIds = [...new Set(opportunities.map((o) => o.creatorId).filter(Boolean))] as string[];
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

        return Promise.all(opportunities.map(async (opp) => {
            const occupiedSeats = await this.getOccupiedSeats(opp.id);
            const volunteersRequired = opp.timeline?.volunteers_required || 0;
            const orgFallback = !opp.organizationId ? await this.getFacultyOrgFallback(opp.facultyId) : null;
            const creator = opp.creatorId ? creatorById.get(opp.creatorId) ?? null : null;

            const {
                faculty_verification_token: _ft,
                partnerToken: _pt,
                liaisonToken: _lt,
                execution_verification_token: _et,
                ...oppRest
            } = opp;

            const { flow_status, admin_can_approve } = this.describeAdminQueueFlow(opp);

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
        }));
    }

    async approve(id: string) {
        const opp = await this.findOne(id);
        if (!opp) throw new NotFoundException('Opportunity not found');
        // Idempotent: repeated approve (double-click, retried request) must not re-run side effects / emails.
        if (opp.admin_approved === true && opp.workflowStage === WORKFLOW_STAGE.LIVE) {
            return opp;
        }
        if (!this.isOpportunityReadyForAdminFinalApprove(opp)) {
            throw new BadRequestException(
                'CIEL final approval is only available after faculty and partner steps (when applicable) are completed.',
            );
        }
        this.opportunityWorkflow.afterAdminApproved(opp);
        const saved = await this.opportunitiesRepository.save(opp);
        await this.handleAdminApprovedSideEffects(saved);
        return saved;
    }

    async reject(id: string, reason: string) {
        const opp = await this.findOne(id);
        if (!opp) throw new NotFoundException('Opportunity not found');
        this.opportunityWorkflow.afterAdminRejected(opp, reason);
        const saved = await this.opportunitiesRepository.save(opp);
        if (saved.isStudentCreated) {
            await this.notifyStudentOpportunityUpdate(saved, {
                title: 'Admin Rejected',
                message: 'Your opportunity was rejected during admin review.',
                emailSubject: 'Admin rejected your opportunity',
                reason,
            });
        }
        return saved;
    }

    async remove(id: string) {
        const opportunity = await this.opportunitiesRepository.findOne({ where: { id } });
        if (!opportunity) {
            throw new NotFoundException(`Opportunity with ID "${id}" not found`);
        }

        try {
            const deleted = await this.opportunitiesRepository.manager.transaction(async (manager) => {
                const deletedChildren = await this.deleteOpportunityChildren(manager, id);
                const result = await manager.delete(Opportunity, { id });

                if ((result.affected ?? 0) === 0) {
                    throw new NotFoundException(`Opportunity with ID "${id}" not found`);
                }

                return deletedChildren;
            });

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
                (error instanceof Error && /foreign key|constraint/i.test(error.message))
            ) {
                throw new ConflictException(this.buildOpportunityDeleteConflictMessage(id, error));
            }

            throw error;
        }
    }

    // Partner methods for managing applicants
    async getApplicantsForOpportunity(opportunityId: string, organizationId: string) {
        const opportunity = await this.opportunitiesRepository.findOne({
            where: { id: opportunityId }
        });

        if (!opportunity) {
            throw new NotFoundException('Opportunity not found');
        }

        if (opportunity.organizationId !== organizationId) {
            throw new ForbiddenException('You do not have access to this opportunity');
        }

        const participants = await this.participationRepository.find({
            where: { projectId: opportunityId },
            relations: ['student'],
            order: { createdAt: 'DESC' }
        });

        // Group by Application ID to show team structure if needed, or just list everyone
        return await Promise.all(participants.map(async p => ({
            id: p.id,
            studentName: p.fullName || p.student?.name || 'Unknown',
            university: p.universityName || p.student?.institution || 'N/A',
            email: p.email || p.student?.email || 'N/A',
            status: p.status,
            appliedAt: p.createdAt,
            avatar: p.student?.avatar || null,
            participation_type: p.participationMode,
            isTeamLead: p.isTeamLead,
            teamMembers: p.isTeamLead && p.applicationId ? (await this.participationRepository.find({
                where: { applicationId: p.applicationId, isTeamLead: false }
            })).map(m => ({
                id: m.id,
                name: m.fullName,
                email: m.email,
                university: m.universityName,
                role: 'Member',
                is_verified: true
            })) : []
        })));
    }

    async getOrganizationParticipants(organizationId: string) {
        const participants = await this.participationRepository.find({
            where: {
                project: { organizationId },
                status: In(['accepted', 'approved', 'verified', 'finalized'])
            },
            relations: ['student', 'project'],
            order: { createdAt: 'DESC' }
        });

        return participants.map(p => ({
            id: p.id,
            name: p.fullName || p.student?.name || 'Unknown student',
            opportunity: p.project?.title || 'Unknown Opportunity',
            joinedDate: p.createdAt.toLocaleDateString(),
            hours: 0,
            status: p.status === 'accepted' ? 'Active' : (p.status === 'verified' ? 'Completed' : p.status),
            participation_type: p.participationMode,
            is_leader: p.isTeamLead
        }));
    }

    async updateApplicantStatus(applicantId: string, status: string, organizationId: string) {
        const participant = await this.participationRepository.findOne({
            where: { id: applicantId },
            relations: ['project', 'student']
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

    async verifyOpportunityToken(token: string, user?: { id: string; email: string; role: string }) {
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
            if (!opportunity.faculty_verified || opportunity.status !== 'pending_partner') {
                throw new BadRequestException(
                    'Partner verification is only available after the faculty supervisor has approved this opportunity.',
                );
            }
            this.opportunityWorkflow.afterPartnerVerified(opportunity);
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
                message: 'Partner verification successful. The opportunity will now be reviewed by CIEL Admin.',
            };
        }

        let verifiedRole = '';

        if (opportunity.liaisonToken === token && !opportunity.liaisonVerified) {
            opportunity.liaisonVerified = true;
            verifiedRole = 'Liaison';

            // Legacy POST /student/opportunity: liaison email acted as faculty approval but never advanced workflow.
            if (
                opportunity.creatorId &&
                !opportunity.isStudentCreated &&
                opportunity.status === 'pending_verification'
            ) {
                opportunity.requiresPartnerApproval = !!(opportunity.partnerToken && !opportunity.partnerVerified);
                opportunity.isStudentCreated = true;
                this.opportunityWorkflow.initStudentCreated(
                    opportunity,
                    opportunity.requiresPartnerApproval,
                );
                this.opportunityWorkflow.afterFacultyVerified(opportunity);
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
                    message: 'Faculty verification successful. The project will continue in the approval workflow.',
                };
            }
            await this.assignFacultyIdFromSupervisionIfMissing(opportunity);
        } else if (
            opportunity.partnerToken === token &&
            !opportunity.partnerVerified &&
            !opportunity.isStudentCreated
        ) {
            this.opportunityWorkflow.afterFacultyCreatedPartnerVerified(opportunity);
            verifiedRole = 'Partner';
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
        } else {
            return {
                success: true,
                message: 'This component of the project has already been verified.'
            };
        }

        // Check if both are now verified
        if (opportunity.liaisonVerified && opportunity.partnerVerified) {
            opportunity.status = 'active';
        }

        await this.assignFacultyIdFromSupervisionIfMissing(opportunity);
        await this.opportunitiesRepository.save(opportunity);

        return {
            success: true,
            data: {
                title: opportunity.title,
                isFullyVerified: this.getApiOpportunityStatus(opportunity) === 'live'
            },
            message: `${verifiedRole} verification successful.`
        };
    }

    async verifyExecutingOrganizationForUser(userId: string, jwtEmail: string | undefined, opportunityId: string) {
        const user = await this.usersRepository.findOne({
            where: { id: userId },
            select: ['id', 'email'],
        });
        const actorEmail = this.normalizeEmail(user?.email || jwtEmail);
        if (!actorEmail) {
            throw new ForbiddenException('Your account must have an email to confirm execution details.');
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

        if (opp.execution_verified) {
            return {
                success: true,
                message: 'Executing organization was already verified.',
                data: { id: opp.id, status: opp.status, workflow_stage: opp.workflowStage },
            };
        }

        const exec = opp.executing_organization as { official_email?: string; officialEmail?: string } | null;
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
        if (opp.admin_approved) {
            opp.status = 'active';
        } else if (opp.requiresPartnerApproval && !opp.partnerVerified) {
            opp.status = 'pending_partner';
            opp.workflowStage = WORKFLOW_STAGE.PENDING_PARTNER;
            if (!opp.partnerApprovalStatus || opp.partnerApprovalStatus === LINE_STATUS.NOT_APPLICABLE) {
                opp.partnerApprovalStatus = LINE_STATUS.PENDING;
            }
        } else {
            opp.status = 'pending_approval';
            if (!opp.workflowStage || opp.workflowStage === WORKFLOW_STAGE.PENDING_ADMIN) {
                opp.workflowStage = WORKFLOW_STAGE.PENDING_ADMIN;
            }
            if (!opp.adminApprovalStatus || opp.adminApprovalStatus === LINE_STATUS.NOT_APPLICABLE) {
                opp.adminApprovalStatus = LINE_STATUS.PENDING;
            }
        }
        await this.opportunitiesRepository.save(opp);
        if (!opp.admin_approved) {
            await this.sendAdminReviewEmail(opp, 'executing organization verification');
        }
        return {
            success: true,
            message: 'Executing organization verified.',
            data: { id: opp.id, status: opp.status, workflow_stage: opp.workflowStage },
        };
    }

    async verifyFaculty(token: string, user?: { id: string; email: string; role: string }) {
        const opp = await this.opportunitiesRepository.findOne({ where: { faculty_verification_token: token } });
        if (!opp) throw new NotFoundException('Invalid or expired faculty verification token');
        this.assertVerificationIdentityIfRequired(opp, token, user);
        if (opp.isStudentCreated && opp.faculty_verified) {
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
        this.opportunityWorkflow.afterFacultyVerified(opp);
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
    private assertFacultySupervisorForStudentOpportunity(
        opp: Opportunity,
        facultyUserId: string,
        facultyEmail: string,
    ) {
        const o = opp.supervision;
        const supContact = this.normalizeEmail(typeof o?.contact === 'string' ? o.contact : undefined);
        const supOfficial = this.normalizeEmail(typeof o?.official_email === 'string' ? o.official_email : undefined);
        const po = opp.partner_organization as Record<string, unknown> | undefined;
        const partnerOfficial = this.normalizeEmail(
            typeof po?.official_email === 'string' ? po.official_email : undefined,
        );
        const fe = this.normalizeEmail(facultyEmail);
        const idOk = !!opp.facultyId && opp.facultyId === facultyUserId;
        const emailOk =
            (!!supContact && !!fe && supContact === fe) ||
            (!!supOfficial && !!fe && supOfficial === fe) ||
            (!!partnerOfficial && !!fe && partnerOfficial === fe);
        if (!idOk && !emailOk) {
            throw new ForbiddenException('You are not the assigned faculty supervisor for this opportunity');
        }
    }

    private assertPartnerCanReviewOpportunity(
        opp: Opportunity,
        partnerEmail: string,
        organizationId?: string | null,
    ) {
        const expectedEmail = this.resolvePartnerEmailFromOpportunity(opp);
        const emailMatches =
            !!expectedEmail &&
            this.normalizeEmail(expectedEmail) === this.normalizeEmail(partnerEmail);
        const organizationMatches =
            !!organizationId &&
            !!opp.organizationId &&
            organizationId === opp.organizationId;

        if (!emailMatches && !organizationMatches) {
            throw new ForbiddenException('You are not the assigned partner reviewer for this opportunity');
        }

        if (opp.isStudentCreated) {
            if (!opp.faculty_verified) {
                throw new BadRequestException(
                    'Partner verification is only available after faculty approval.',
                );
            }
            if (!this.isAwaitingPartnerDashboardReview(opp)) {
                throw new BadRequestException('This opportunity is not awaiting partner approval.');
            }
            return;
        }

        if (!this.isAwaitingPartnerDashboardReview(opp)) {
            throw new BadRequestException('This opportunity is not awaiting partner approval.');
        }
    }

    /**
     * Partner approve/reject and Faculty Hub `partner_ack` — true when the partner line is still open
     * (covers `pending_execution` + null workflow where execution org is still pending but partner may act).
     */
    isAwaitingPartnerDashboardReview(opp: Opportunity): boolean {
        if (!opp.requiresPartnerApproval || opp.partnerVerified) {
            return false;
        }
        const pas = opp.partnerApprovalStatus;
        if (pas === LINE_STATUS.APPROVED || pas === LINE_STATUS.REJECTED || pas === LINE_STATUS.SKIPPED) {
            return false;
        }
        if (opp.workflowStage === WORKFLOW_STAGE.PENDING_PARTNER) {
            return true;
        }
        if (opp.status === 'pending_partner' || opp.status === 'pending_execution') {
            return true;
        }
        if (pas === LINE_STATUS.PENDING || pas == null || pas === '') {
            return true;
        }
        return false;
    }

    private isAwaitingFacultyDashboardReview(opp: Opportunity): boolean {
        if (!opp.creatorId || opp.faculty_verified || opp.admin_approved) return false;
        if (opp.workflowStage === WORKFLOW_STAGE.LIVE || opp.status === 'active' || opp.status === 'live') {
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

    async facultyDashboardApprove(opportunityId: string, facultyUserId: string, facultyEmail: string) {
        const opp = await this.findOne(opportunityId);
        if (!opp) throw new NotFoundException('Opportunity not found');
        this.assertFacultySupervisorForStudentOpportunity(opp, facultyUserId, facultyEmail);

        const oppAwaitingFaculty = this.isAwaitingFacultyDashboardReview(opp);
        const pendingApp =
            await this.opportunityApplicationsService.findLatestPendingFacultyApplicationForDashboard(
                opportunityId,
                facultyEmail,
                opp.creatorId,
            );

        if (!oppAwaitingFaculty && !pendingApp) {
            throw new BadRequestException('This opportunity is not awaiting faculty approval');
        }

        if (oppAwaitingFaculty) {
            this.opportunityWorkflow.afterFacultyVerified(opp);
            await this.assignFacultyIdFromSupervisionIfMissing(opp);
            const saved = await this.opportunitiesRepository.save(opp);
            await this.handleFacultyApprovedSideEffects(saved);
            return saved;
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
    ) {
        const opp = await this.findOne(opportunityId);
        if (!opp) throw new NotFoundException('Opportunity not found');
        this.assertFacultySupervisorForStudentOpportunity(opp, facultyUserId, facultyEmail);

        const oppAwaitingFaculty = this.isAwaitingFacultyDashboardReview(opp);
        const pendingApp =
            await this.opportunityApplicationsService.findLatestPendingFacultyApplicationForDashboard(
                opportunityId,
                facultyEmail,
                opp.creatorId,
            );

        if (!oppAwaitingFaculty && !pendingApp) {
            throw new BadRequestException('This opportunity is not awaiting faculty approval');
        }

        if (oppAwaitingFaculty) {
            this.opportunityWorkflow.afterFacultyRejected(opp, reason);
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
                    'Faculty Rejected',
                    'Your opportunity was rejected during faculty review.',
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

    async partnerDashboardApprove(
        opportunityId: string,
        partner: { email: string; organizationId?: string | null },
    ) {
        const opp = await this.findOne(opportunityId);
        if (!opp) throw new NotFoundException('Opportunity not found');

        if (opp.partnerApprovalStatus === 'approved' && opp.workflowStage === WORKFLOW_STAGE.PENDING_ADMIN) {
            return opp;
        }

        this.assertPartnerCanReviewOpportunity(opp, partner.email, partner.organizationId);
        if (opp.isStudentCreated) {
            this.opportunityWorkflow.afterPartnerVerified(opp);
        } else {
            this.opportunityWorkflow.afterFacultyCreatedPartnerVerified(opp);
        }
        const saved = await this.opportunitiesRepository.save(opp);
        await this.handlePartnerApprovedSideEffects(saved);
        return saved;
    }

    async partnerDashboardReject(
        opportunityId: string,
        partner: { email: string; organizationId?: string | null },
        reason?: string,
    ) {
        const opp = await this.findOne(opportunityId);
        if (!opp) throw new NotFoundException('Opportunity not found');

        this.assertPartnerCanReviewOpportunity(opp, partner.email, partner.organizationId);
        this.opportunityWorkflow.afterPartnerRejected(opp, reason);
        const saved = await this.opportunitiesRepository.save(opp);

        if (saved.isStudentCreated) {
            await this.notifyStudentOpportunityUpdate(saved, {
                title: 'Partner Rejected',
                message: 'Your opportunity was rejected during partner review.',
                emailSubject: 'Partner rejected your opportunity',
                reason,
            });
        }

        return saved;
    }
}
