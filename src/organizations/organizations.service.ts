import {
    Injectable,
    NotFoundException,
    UnauthorizedException,
    ForbiddenException,
    BadRequestException,
    ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, Repository } from 'typeorm';
import { Organization } from './entities/organization.entity';
import { User } from '../users/entities/user.entity';
import { CreateOrganizationDto, UpdateOrganizationDto, AcknowledgePolicyDto, AdminRejectOrganizationDto } from './dto/organization.dto';
import { UserRole } from '../users/enums/user-role.enum';
import * as bcrypt from 'bcrypt';

import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { OpportunityApplication } from '../opportunities/entities/opportunity-application.entity';
import { Timesheet } from '../timesheets/entities/timesheet.entity';
import { Report } from '../reports/entities/report.entity';
import { Participation } from '../engagement/entities/participant.entity';
import { FacultyUniversityScopeService } from '../faculty-university-scope/faculty-university-scope.service';

const UNIVERSITY_SCOPED_PARTICIPATION_STATUSES = [
    'pending',
    'pending_payment_approval',
    'paid',
    'pending_ciel_approval',
    'pending_faculty_approval',
    'approved',
    'verified',
    'accepted',
    'finalized',
];

@Injectable()
export class OrganizationsService {
    constructor(
        @InjectRepository(Organization)
        private organizationsRepository: Repository<Organization>,
        @InjectRepository(User)
        private usersRepository: Repository<User>,
        @InjectRepository(Opportunity)
        private opportunitiesRepository: Repository<Opportunity>,
        @InjectRepository(OpportunityApplication)
        private opportunityApplicationsRepository: Repository<OpportunityApplication>,
        @InjectRepository(Timesheet)
        private timesheetsRepository: Repository<Timesheet>,
        @InjectRepository(Report)
        private reportsRepository: Repository<Report>,
        @InjectRepository(Participation)
        private participationRepository: Repository<Participation>,
        private readonly facultyUniversityScopeService: FacultyUniversityScopeService,
    ) { }

    /**
     * Distinct student IDs genuinely affiliated with this university (same match rules as
     * getUniversityAnalytics's proven participation-level query) — used to filter dashboard/impact
     * stats so a university doesn't inherit every co-participant of an opportunity its students
     * merely joined alongside people from other schools.
     */
    private async resolveUniversityAffiliatedStudentIds(orgId: string, orgName: string): Promise<Set<string>> {
        const orgNameNorm = orgName.trim().toLowerCase();
        const rows = await this.participationRepository
            .createQueryBuilder('p')
            .leftJoin('p.project', 'project')
            .leftJoin('p.student', 'student')
            .select('p.student_id', 'studentId')
            .where('p.student_id IS NOT NULL')
            .andWhere('p.status IN (:...st)', { st: UNIVERSITY_SCOPED_PARTICIPATION_STATUSES })
            .andWhere(
                new Brackets((b) => {
                    b.where(`TRIM(COALESCE(p.universityId, '')) = :orgId`, { orgId })
                        .orWhere(`project."organizationId"::text = :orgId`, { orgId })
                        .orWhere(`student."organizationId"::text = :orgId`, { orgId })
                        .orWhere(`LOWER(TRIM(COALESCE(p.universityName, ''))) = :orgNameNorm`, { orgNameNorm })
                        .orWhere(`LOWER(TRIM(COALESCE(p.universityId, ''))) = :orgNameNorm`, { orgNameNorm })
                        .orWhere(`LOWER(TRIM(COALESCE(student.institution, ''))) = :orgNameNorm`, { orgNameNorm })
                        .orWhere(`LOWER(TRIM(COALESCE(student.university, ''))) = :orgNameNorm`, { orgNameNorm });
                }),
            )
            .getRawMany<{ studentId: string }>();
        return new Set(rows.map((r) => r.studentId).filter(Boolean));
    }

    /** Real applicant counts per opportunity (excludes withdrawn) — replaces a hardcoded volunteersApplied: 0. */
    private async countApplicantsByOpportunity(oppIds: string[]): Promise<Map<string, number>> {
        if (oppIds.length === 0) return new Map();
        const rows = await this.opportunityApplicationsRepository
            .createQueryBuilder('a')
            .select('a.opportunityId', 'opportunityId')
            .addSelect('COUNT(*)', 'count')
            .where('a.opportunityId IN (:...oppIds)', { oppIds })
            .andWhere('a.withdrawnAt IS NULL')
            .groupBy('a.opportunityId')
            .getRawMany<{ opportunityId: string; count: string }>();
        return new Map(rows.map((r) => [r.opportunityId, Number(r.count) || 0]));
    }

    /**
     * Partner dashboard for university-type orgs: activity is usually on non-university-owned listings.
     * Scope opportunity IDs the same way as faculty delegation / university analytics.
     */
    private async getPartnerDashboardStatsForUniversityOrg(orgId: string, orgName: string) {
        const oppIds = await this.facultyUniversityScopeService.resolveOpportunityIdsForUniversityOrganization(orgId);

        if (oppIds.length === 0) {
            return {
                success: true,
                data: {
                    stats: {
                        activeOpportunities: 0,
                        studentsEngaged: 0,
                        verifiedHours: 0,
                        reportsSubmitted: 0,
                    },
                    pendingVerifications: 0,
                    pendingSummary: {
                        total: 0,
                        items: [
                            {
                                key: 'partner_pending_verifications',
                                title: 'Pending verifications',
                                count: 0,
                                href: '/dashboard/partner/verification',
                                tone: 'warning',
                                description: 'Student hours or reports waiting for partner review.',
                            },
                            {
                                key: 'partner_pending_opportunities',
                                title: 'Requests under approval',
                                count: 0,
                                href: '/dashboard/partner/requests',
                                tone: 'neutral',
                                description: 'Your opportunities still moving through approval.',
                            },
                        ],
                    },
                    recentProjects: [],
                    verificationProgress: { percentage: 0, label: 'No submissions yet' },
                },
            };
        }

        const affiliatedStudentIds = await this.resolveUniversityAffiliatedStudentIds(orgId, orgName);

        const activeOpportunities = await this.opportunitiesRepository.count({
            where: { id: In(oppIds), status: 'active' },
        });

        const timesheetsAll = await this.timesheetsRepository.find({
            where: { opportunityId: In(oppIds) },
            select: ['studentId', 'status', 'hours'],
        });
        // Restrict to this university's own students — the resolved opportunity IDs can include
        // listings shared with other schools' students, who must not count toward this dashboard.
        const timesheets = timesheetsAll.filter((t) => t.studentId && affiliatedStudentIds.has(t.studentId));
        const studentsEngaged = new Set(timesheets.map((t) => t.studentId)).size;

        const verifiedTimesheets = timesheets.filter((t) => t.status === 'verified');
        const verifiedHours = verifiedTimesheets.reduce((sum, t) => sum + t.hours, 0);
        const pendingTimesheets = timesheets.filter((t) => t.status === 'pending');

        const reportsSubmitted = affiliatedStudentIds.size
            ? await this.reportsRepository
                  .createQueryBuilder('r')
                  .where('r."opportunityId" IN (:...oppIds)', { oppIds })
                  .andWhere('r."studentId" IN (:...studentIds)', { studentIds: [...affiliatedStudentIds] })
                  .getCount()
            : 0;

        const pendingVerifications = pendingTimesheets.length;

        const pendingOpportunities = await this.opportunitiesRepository.count({
            where: { id: In(oppIds), status: 'pending_approval' },
        });

        const recentProjects = await this.opportunitiesRepository.find({
            where: { id: In(oppIds) },
            order: { createdAt: 'DESC' },
            take: 3,
        });
        const applicantCounts = await this.countApplicantsByOpportunity(recentProjects.map((p) => p.id));

        const verifiedCount = verifiedTimesheets.length;
        const decidedCount = verifiedCount + pendingTimesheets.length;
        const verificationPercentage = decidedCount === 0 ? 0 : Math.round((100 * verifiedCount) / decidedCount);

        return {
            success: true,
            data: {
                stats: {
                    activeOpportunities,
                    studentsEngaged,
                    verifiedHours,
                    reportsSubmitted,
                },
                pendingVerifications,
                pendingSummary: {
                    total: pendingVerifications + pendingOpportunities,
                    items: [
                        {
                            key: 'partner_pending_verifications',
                            title: 'Pending verifications',
                            count: pendingVerifications,
                            href: '/dashboard/partner/verification',
                            tone: 'warning',
                            description: 'Student hours or reports waiting for partner review.',
                        },
                        {
                            key: 'partner_pending_opportunities',
                            title: 'Requests under approval',
                            count: pendingOpportunities,
                            href: '/dashboard/partner/requests',
                            tone: 'neutral',
                            description: 'Your opportunities still moving through approval.',
                        },
                    ],
                },
                recentProjects: recentProjects.map((p) => ({
                    id: p.id,
                    title: p.title,
                    location: p.location?.city || 'Unknown',
                    volunteersNeeded: p.timeline?.volunteers_required || 0,
                    volunteersApplied: applicantCounts.get(p.id) ?? 0,
                    status: p.status,
                })),
                verificationProgress: {
                    percentage: verificationPercentage,
                    label: decidedCount === 0 ? 'No submissions yet' : `${verifiedCount} of ${decidedCount} verified`,
                },
            },
        };
    }

    async getPartnerDashboardStats(orgId: string) {
        const org = await this.organizationsRepository.findOne({ where: { id: orgId } });
        if (org && this.isUniversityOrgType(org.orgType)) {
            return this.getPartnerDashboardStatsForUniversityOrg(orgId, org.name);
        }

        // Active Opportunities
        const activeOpportunities = await this.opportunitiesRepository.count({
            where: { organizationId: orgId, status: 'active' }
        });

        // Students Engaged (Distinct students in timesheets for this org)
        const timesheets = await this.timesheetsRepository.find({
            where: { organizationId: orgId },
            select: ['studentId', 'status', 'hours']
        });
        const studentsEngaged = new Set(timesheets.map(t => t.studentId)).size;

        // Verified Hours
        const verifiedTimesheets = timesheets.filter(t => t.status === 'verified');
        const verifiedHours = verifiedTimesheets.reduce((sum, t) => sum + t.hours, 0);
        const pendingTimesheetsForRate = timesheets.filter(t => t.status === 'pending');

        // Reports Submitted (submitted BY students to this partner org)
        const reportsSubmitted = await this.reportsRepository.count({
            where: { organizationId: orgId }
        });

        // Pending Verifications (Timesheets pending)
        const pendingVerifications = pendingTimesheetsForRate.length;

        const pendingOpportunities = await this.opportunitiesRepository.count({
            where: { organizationId: orgId, status: 'pending_approval' }
        });

        // Recent Projects
        const recentProjects = await this.opportunitiesRepository.find({
            where: { organizationId: orgId },
            order: { createdAt: 'DESC' },
            take: 3
        });
        const applicantCounts = await this.countApplicantsByOpportunity(recentProjects.map((p) => p.id));

        const verifiedCount = verifiedTimesheets.length;
        const decidedCount = verifiedCount + pendingTimesheetsForRate.length;
        const verificationPercentage = decidedCount === 0 ? 0 : Math.round((100 * verifiedCount) / decidedCount);

        return {
            success: true,
            data: {
                stats: {
                    activeOpportunities,
                    studentsEngaged,
                    verifiedHours,
                    reportsSubmitted
                },
                pendingVerifications,
                pendingSummary: {
                    total: pendingVerifications + pendingOpportunities,
                    items: [
                        {
                            key: 'partner_pending_verifications',
                            title: 'Pending verifications',
                            count: pendingVerifications,
                            href: '/dashboard/partner/verification',
                            tone: 'warning',
                            description: 'Student hours or reports waiting for partner review.',
                        },
                        {
                            key: 'partner_pending_opportunities',
                            title: 'Requests under approval',
                            count: pendingOpportunities,
                            href: '/dashboard/partner/requests',
                            tone: 'neutral',
                            description: 'Your opportunities still moving through approval.',
                        },
                    ],
                },
                recentProjects: recentProjects.map(p => ({
                    id: p.id,
                    title: p.title,
                    location: p.location?.city || 'Unknown',
                    volunteersNeeded: p.timeline?.volunteers_required || 0,
                    volunteersApplied: applicantCounts.get(p.id) ?? 0,
                    status: p.status
                })),
                verificationProgress: {
                    percentage: verificationPercentage,
                    label: decidedCount === 0 ? 'No submissions yet' : `${verifiedCount} of ${decidedCount} verified`,
                },
            }
        };
    }

    // User Methods
    async create(createDto: CreateOrganizationDto) {
        const org = this.organizationsRepository.create(createDto);
        return this.organizationsRepository.save(org);
    }

    async getMyOrganization(userId: string) {
        const user = await this.usersRepository.findOne({
            where: { id: userId },
            relations: ['organization'],
        });

        if (!user || !user.organization) {
            return null;
        }

        return this.filterSensitiveFields(user.organization);
    }

    /** Opportunity flows require User.name / User.phone; partner forms often save these on Organization only. */
    private async maybeFillUserContactFromOrg(
        user: User,
        contactName?: string,
        contactPhone?: string,
    ): Promise<void> {
        let changed = false;
        const nameTrim = typeof contactName === 'string' ? contactName.trim() : '';
        if (nameTrim && !user.name?.trim()) {
            user.name = nameTrim;
            changed = true;
        }
        const phoneTrim = typeof contactPhone === 'string' ? contactPhone.trim() : '';
        if (phoneTrim && !user.phone?.trim()) {
            user.phone = phoneTrim;
            changed = true;
        }
        if (changed) await this.usersRepository.save(user);
    }

    async updateMyOrganization(reqUserId: string, updateDto: UpdateOrganizationDto) {
        const userId = reqUserId;

        const user = await this.usersRepository.findOne({
            where: { id: userId },
            relations: ['organization'],
        });

        if (!user) {
            throw new NotFoundException('User not found');
        }

        if (user.organization && user.organization.isBlocked) {
            throw new ForbiddenException('Organization is blocked');
        }

        const { safeguardingAcknowledged, dataPolicyAcknowledged, userId: dtoUserId, ...rest } = updateDto;
        const updateData: any = { ...rest };

        if (safeguardingAcknowledged !== undefined) {
            updateData.safeguardingAcknowledged = safeguardingAcknowledged;
        }
        if (dataPolicyAcknowledged !== undefined) {
            updateData.dataPolicyAcknowledged = dataPolicyAcknowledged;
        }

        if (!user.organization) {
            // Upsert: Create new
            // Missing required fields name and orgType?
            // Try to use User's orgName/orgType if available, or defaults.
            const newOrg = this.organizationsRepository.create({
                name: user.orgName || user.name || 'Unnamed Organization', // Fallback
                orgType: user.orgType || 'NGO', // Fallback
                ...updateData,
                verificationStatus: 'PENDING',
                users: [user] // Link user
            });
            const savedOrg = await this.organizationsRepository.save(newOrg);

            // TS workaround: save can return array if inference is ambiguous
            const orgToLink = Array.isArray(savedOrg) ? savedOrg[0] : savedOrg as Organization;

            // Link to user explicitly if needed
            user.organization = orgToLink;
            await this.usersRepository.save(user);
            await this.maybeFillUserContactFromOrg(user, updateData.contactName, updateData.contactPhone);

            return this.filterSensitiveFields(orgToLink);
        } else {
            // Update existing
            await this.organizationsRepository.update(user.organization.id, updateData);
            const updatedOrg = await this.organizationsRepository.findOne({ where: { id: user.organization.id } });
            if (!updatedOrg) {
                throw new NotFoundException('Organization not found after update');
            }
            await this.maybeFillUserContactFromOrg(user, updateData.contactName, updateData.contactPhone);
            return this.filterSensitiveFields(updatedOrg);
        }
    }

    async acknowledgePolicies(userId: string, dto: AcknowledgePolicyDto) {
        const user = await this.usersRepository.findOne({
            where: { id: userId },
            relations: ['organization'],
        });

        if (!user || !user.organization) {
            throw new NotFoundException('Organization not found');
        }

        user.organization.safeguardingAcknowledged = dto.safeguarding;
        user.organization.dataPolicyAcknowledged = dto.dataPolicy;
        user.organization.worksWithMinors = dto.worksWithMinors;

        await this.organizationsRepository.save(user.organization);
        return { success: true };
    }

    private filterSensitiveFields(org: Organization) {
        const { verifiedBy, verificationNotes, isBlocked, ...safeOrg } = org;
        return safeOrg;
    }

    // Admin Methods
    async findAll(filters: any) {
        const query = this.organizationsRepository.createQueryBuilder('org');

        if (filters.type) {
            query.andWhere('org.orgType = :type', { type: filters.type });
        }
        if (filters.status) {
            query.andWhere('org.verificationStatus = :status', { status: filters.status });
        }
        if (filters.country) {
            query.andWhere('org.countryCode = :country', { country: filters.country });
        }

        const orgs = await query.getMany();
        // Return minimal view for list
        return orgs.map(org => ({
            id: org.id,
            name: org.name,
            orgType: org.orgType,
            city: org.city,
            country: org.country,
            verificationStatus: org.verificationStatus,
            createdAt: org.createdAt
        }));
    }

    async findAllForAdmin() {
        // Need to count active opportunities
        // Assuming there is a relation or we can query opportunities
        // But OpportunitiesService is injected in Opportunities, and OrganizationsService is injected there.
        // Circular dependency might be an issue if we inject OpportunitiesService here.
        // Better to use QueryBuilder with raw relation if possible or just simple query if relation exists.
        // Organization entity does not have 'opportunities' OneToMany relation in the file I saw.
        // Let's check Opportunity entity again. It has ManyToOne to Organization.
        // We can use query builder on Organization and join opportunities if relation exists on Organization side.
        // Wait, Organization entity DOES NOT have OneToMany opportunities.
        // Use raw query or add relation. Adding relation is better but I should stick to existing structure if possible.
        // Actually, without relation on Organization, standard TypeORM join is harder from Organization side.
        // But we can do a subquery or strictly use QueryBuilder on Opportunity?
        // Let's assume we can add relation or use a separate query or existing relations.
        // Checking Opportunity entity again... it has @ManyToOne.
        // If I can't modify entity easily (risk), I can do a raw query or leftJoin.

        // Let's look at how to get active project count.
        // select org.*, (select count(*) from opportunities where organizationId = org.id and status = 'active') as active_projects_count

        const query = this.organizationsRepository.createQueryBuilder('org')
            .leftJoinAndSelect('org.users', 'user') // To get contact info if needed, but Org has contactName/Phone
            .loadRelationCountAndMap('org.active_projects_count', 'org.opportunities', 'opportunities', (qb) => qb.where('opportunities.status = :status', { status: 'active' }));

        // Wait, 'org.opportunities' relation does NOT exist on Organization entity in file d:\saevolgo\ciel-api\src\organizations\entities\organization.entity.ts
        // I need to add it or use subquery.
        // Adding relation is cleaner.

        // I will first add the relation to Organization entity in a separate step?
        // Or just use a subquery map.

        const orgs = await this.organizationsRepository.createQueryBuilder('org')
            .select('org')
            .addSelect(subQuery => {
                return subQuery
                    .select('COUNT(opp.id)', 'count')
                    .from('opportunities', 'opp') // Assuming table name is 'opportunities'
                    .where('opp.organizationId = org.id')
                    .andWhere('opp.status = :status', { status: 'active' });
            }, 'active_projects_count')
            .getRawAndEntities();

        // getRawAndEntities returns { entities: [], raw: [] }
        // We need to merge them.

        return orgs.entities.map((org, index) => {
            const raw = orgs.raw.find(r => r.org_id === org.id); // Check raw structure
            // Actually, getRawAndEntities mapping is tricky with addSelect subquery.
            // simpler:

            // Let's use getRawMany just to be safe if we want custom shape
            // OR map manually.

            const count = orgs.raw.find(r => r.org_id === org.id)?.active_projects_count || 0;
            // note: raw field names depend on driver.

            let status = org.verificationStatus.toLowerCase();
            if (org.isBlocked) {
                status = 'suspended';
            } else if (status === 'approved') {
                status = 'verified';
            }
            // else keeps 'pending', 'rejected' as is

            return {
                id: org.id,
                name: org.name,
                email: org.contactEmail || 'N/A', // Mapping from org contactEmail
                organization_type: org.orgType,
                contact_person: org.contactName || 'N/A',
                contact_number: org.contactPhone || 'N/A',
                status: status,
                active_projects_count: parseInt(count as string) || 0
            };
        });
    }

    async getAdminOrganizationDetails(id: string) {
        const org = await this.findOne(id);

        const activeProjectsCount = await this.opportunitiesRepository.count({
            where: {
                organizationId: org.id,
                status: 'active',
            },
        });

        const normalizedStatus = org.isBlocked
            ? 'suspended'
            : org.verificationStatus?.toUpperCase() === 'APPROVED'
                ? 'verified'
                : (org.verificationStatus || 'PENDING').toLowerCase();

        return {
            id: org.id,
            name: org.name,
            email: org.contactEmail,
            contact_person: org.contactName,
            contact: org.contactName,
            organization_type: org.orgType,
            type: org.orgType,
            status: normalizedStatus,
            verification_status: org.verificationStatus,
            active_projects_count: activeProjectsCount,
            projects: activeProjectsCount,
            phone: org.contactPhone,
            website: org.websiteUrl,
            address: org.address,
            city: org.city,
            state: org.region,
            province: org.region,
            country: org.country,
            postal_code: null,
            registration_number: null,
            tax_number: null,
            created_at: org.createdAt,
            updated_at: org.updatedAt,
            verified_at: org.verifiedAt,
        };
    }

    async findOne(id: string) {
        const org = await this.organizationsRepository.findOne({ where: { id } });
        if (!org) throw new NotFoundException('Organization not found');
        return org; // Returns full object for admin
    }

    async approveOrganization(id: string, adminId: string) {
        const org = await this.findOne(id);
        org.verificationStatus = 'APPROVED';
        org.verifiedBy = adminId;
        org.verifiedAt = new Date();
        return this.organizationsRepository.save(org);
    }

    async rejectOrganization(id: string, adminId: string, dto: AdminRejectOrganizationDto) {
        const org = await this.findOne(id);
        org.verificationStatus = 'REJECTED';
        org.verifiedBy = adminId;
        org.verifiedAt = new Date();
        org.verificationNotes = dto.notes;
        return this.organizationsRepository.save(org);
    }

    async blockOrganization(id: string) {
        const org = await this.findOne(id);
        org.isBlocked = true;
        return this.organizationsRepository.save(org);
    }

    async updateStatus(id: string, status: string) {
        const org = await this.findOne(id);
        if (status === 'suspended') {
            org.isBlocked = true;
        } else if (status === 'approve' || status === 'active') {
            org.isBlocked = false;
            if (status === 'approve') {
                org.verificationStatus = 'APPROVED';
                org.verifiedAt = new Date();
                // We might want to set verifiedBy if we had the admin ID here, 
                // but typically status toggles might not carry user context deep unless passed.
                // For now, simple status update.
            }
        } else {
            // Check if status maps to verificationStatus (APPROVED, REJECTED, PENDING)
            const validVerificationStatuses = ['APPROVED', 'REJECTED', 'PENDING'];
            if (validVerificationStatuses.includes(status.toUpperCase())) {
                org.verificationStatus = status.toUpperCase();
            }
        }
        return this.organizationsRepository.save(org);
    }

    async createForAdmin(data: any, adminId: string) {
        // 1. Create Organization
        const newOrg = this.organizationsRepository.create({
            name: data.name,
            orgType: data.type,
            contactEmail: data.email,
            contactPhone: data.contact, // Mapping contact to contactPhone
            verificationStatus: 'APPROVED',
            verifiedBy: adminId,
            verifiedAt: new Date(),
            verificationScope: 'LOCAL',
            country: 'Pakistan',
            countryCode: 'PK'
        });
        const savedOrg = await this.organizationsRepository.save(newOrg);

        // 2. Create User
        const salt = await bcrypt.genSalt();
        const hashedPassword = await bcrypt.hash(data.password, salt);

        const newUser = this.usersRepository.create({
            name: data.name,
            email: data.email,
            password: hashedPassword,
            role: UserRole.ORGANIZATION_ADMIN,
            orgName: savedOrg.name,
            orgType: savedOrg.orgType,
            organization: savedOrg,
            status: 'active'
        });

        await this.usersRepository.save(newUser);

        return {
            success: true,
            organization: this.filterSensitiveFields(savedOrg),
            user: {
                id: newUser.id,
                email: newUser.email,
                role: newUser.role
            }
        };
    }

    private isUniversityOrgType(orgType: string): boolean {
        return String(orgType || '')
            .trim()
            .toLowerCase()
            .includes('university');
    }

    /** Attach a new login to an existing university organization (e.g. ops staff after membership purchase). */
    async addStaffMemberToUniversityOrganization(
        organizationId: string,
        dto: { name: string; email: string; password: string; role?: UserRole },
    ) {
        const org = await this.organizationsRepository.findOne({ where: { id: organizationId } });
        if (!org) {
            throw new NotFoundException('Organization not found');
        }
        if (!this.isUniversityOrgType(org.orgType)) {
            throw new BadRequestException('Staff members can only be added to university-type organizations');
        }
        const email = dto.email.trim().toLowerCase();
        const taken = await this.usersRepository.findOne({ where: { email } });
        if (taken) {
            throw new ConflictException('Email already exists');
        }
        const hashedPassword = await bcrypt.hash(dto.password, 10);
        const role =
            dto.role === UserRole.ORGANIZATION_ADMIN ? UserRole.ORGANIZATION_ADMIN : UserRole.UNIVERSITY;
        const user = this.usersRepository.create({
            name: dto.name,
            email,
            password: hashedPassword,
            role,
            organization: org,
            orgName: org.name,
            orgType: org.orgType,
            status: 'active',
        });
        await this.usersRepository.save(user);
        return {
            success: true,
            data: {
                id: user.id,
                email: user.email,
                role: user.role,
                organizationId: org.id,
            },
        };
    }

    /**
     * University org analytics: participations linked to this org via enrollment `universityId`,
     * `universityName` (often the same canonical institution string as `organizations.name`, not a UUID),
     * opportunities owned by the org, students tied by `organizationId`, or profile `institution` / `university`.
     * Non-university org types receive 403.
     */
    async getUniversityAnalytics(orgId: string) {
        const org = await this.organizationsRepository.findOne({ where: { id: orgId } });
        if (!org) {
            throw new NotFoundException('Organization not found');
        }
        if (!this.isUniversityOrgType(org.orgType)) {
            throw new ForbiddenException('University analytics are only available for university organizations.');
        }

        const orgNameNorm = org.name.trim().toLowerCase();

        const st = [
            'pending',
            'pending_payment_approval',
            'paid',
            'pending_ciel_approval',
            'pending_faculty_approval',
            'approved',
            'verified',
            'accepted',
            'finalized',
        ];

        const participations = await this.participationRepository
            .createQueryBuilder('p')
            .leftJoinAndSelect('p.project', 'project')
            .leftJoinAndSelect('p.student', 'student')
            .where('p.student_id IS NOT NULL')
            .andWhere('p.status IN (:...st)', { st })
            .andWhere(
                new Brackets((b) => {
                    b.where(`TRIM(COALESCE(p.universityId, '')) = :orgId`, { orgId })
                        .orWhere(`project."organizationId"::text = :orgId`, { orgId })
                        .orWhere(`student."organizationId"::text = :orgId`, { orgId })
                        .orWhere(`LOWER(TRIM(COALESCE(p.universityName, ''))) = :orgNameNorm`, {
                            orgNameNorm,
                        })
                        .orWhere(`LOWER(TRIM(COALESCE(p.universityId, ''))) = :orgNameNorm`, {
                            orgNameNorm,
                        })
                        .orWhere(`LOWER(TRIM(COALESCE(student.institution, ''))) = :orgNameNorm`, {
                            orgNameNorm,
                        })
                        .orWhere(`LOWER(TRIM(COALESCE(student.university, ''))) = :orgNameNorm`, {
                            orgNameNorm,
                        });
                }),
            )
            .getMany();

        const total_participants = participations.length;
        const distinctStudentIds = [
            ...new Set(participations.map((p) => p.studentId).filter((id): id is string => Boolean(id))),
        ];
        const total_distinct_students = distinctStudentIds.length;

        let verified_students = 0;
        if (distinctStudentIds.length > 0) {
            verified_students = await this.usersRepository.count({
                where: {
                    id: In(distinctStudentIds),
                    profile_verified: true,
                    identity_verified: true,
                },
            });
        }

        const verification_rate_percent =
            total_distinct_students === 0
                ? 0
                : Math.round((100 * verified_students) / total_distinct_students);

        const degreeMap = new Map<string, number>();
        const yearMap = new Map<string, number>();
        let individualEnrollmentRows = 0;
        let teamEnrollmentRows = 0;
        let total_required_hours = 0;

        for (const p of participations) {
            const majorFallback = ((p.student as User | undefined)?.major || '').trim();
            const deg = (p.academicProgram || '').trim() || majorFallback || 'Unspecified';
            degreeMap.set(deg, (degreeMap.get(deg) || 0) + 1);
            const yr = (p.yearOfStudy || '').trim() || 'Unspecified';
            yearMap.set(yr, (yearMap.get(yr) || 0) + 1);
            if (p.participationMode === 'team') {
                teamEnrollmentRows += 1;
            } else {
                individualEnrollmentRows += 1;
            }
            total_required_hours += this.resolveRequiredHoursPerStudentFromOpportunity(p.project);
        }

        const individual_participation_percent =
            total_participants === 0
                ? 0
                : Math.round((100 * individualEnrollmentRows) / total_participants);
        const team_participation_percent =
            total_participants === 0 ? 0 : Math.round((100 * teamEnrollmentRows) / total_participants);

        const degree_participation = [...degreeMap.entries()]
            .map(([degree, count]) => ({ degree, count }))
            .sort((a, b) => b.count - a.count);

        const year_participation = [...yearMap.entries()]
            .map(([year_of_study, count]) => ({ year_of_study, count }))
            .sort((a, b) => b.count - a.count);

        return {
            success: true,
            data: {
                organization_id: orgId,
                organization_name: org.name,
                total_participants,
                total_distinct_students,
                verified_students,
                verification_rate_percent,
                degree_participation,
                year_participation,
                individual_participation_percent,
                team_participation_percent,
                total_required_hours: Math.round(total_required_hours * 10) / 10,
            },
        };
    }

    /** Same shape as {@link getPartnerStudentsAnalytics} but scoped like university dashboard / analytics. */
    private async getPartnerStudentsAnalyticsForUniversityOrg(orgId: string) {
        const oppIds = await this.facultyUniversityScopeService.resolveOpportunityIdsForUniversityOrganization(orgId);
        const st = [
            'pending',
            'pending_payment_approval',
            'paid',
            'pending_ciel_approval',
            'pending_faculty_approval',
            'approved',
            'verified',
            'accepted',
            'finalized',
        ];

        if (oppIds.length === 0) {
            return {
                success: true,
                data: {
                    organization_id: orgId,
                    total_students_assigned: 0,
                    total_enrollments: 0,
                    verified_students: 0,
                    verification_rate_percent: 0,
                    university_mix: [],
                    degree_mix: [],
                    total_required_hours: 0,
                },
            };
        }

        const participations = await this.participationRepository
            .createQueryBuilder('p')
            .innerJoinAndSelect('p.project', 'project')
            .leftJoinAndSelect('p.student', 'student')
            .where('p.student_id IS NOT NULL')
            .andWhere('p.project_id IN (:...oppIds)', { oppIds })
            .andWhere('p.status IN (:...st)', { st })
            .getMany();

        const total_enrollments = participations.length;
        const distinctStudentIds = [
            ...new Set(participations.map((p) => p.studentId).filter((id): id is string => Boolean(id))),
        ];
        const total_students_assigned = distinctStudentIds.length;

        let verified_students = 0;
        if (distinctStudentIds.length > 0) {
            verified_students = await this.usersRepository.count({
                where: {
                    id: In(distinctStudentIds),
                    profile_verified: true,
                    identity_verified: true,
                },
            });
        }

        const verification_rate_percent =
            total_students_assigned === 0 ? 0 : Math.round((100 * verified_students) / total_students_assigned);

        const universityMap = new Map<string, number>();
        const degreeMap = new Map<string, number>();
        let total_required_hours = 0;

        for (const p of participations) {
            const uni =
                (p.universityName || '').trim() ||
                ((p.student as User | undefined)?.university || '').trim() ||
                'Unspecified';
            universityMap.set(uni, (universityMap.get(uni) || 0) + 1);

            const majorFallback = ((p.student as User | undefined)?.major || '').trim();
            const deg = (p.academicProgram || '').trim() || majorFallback || 'Unspecified';
            degreeMap.set(deg, (degreeMap.get(deg) || 0) + 1);

            total_required_hours += this.resolveRequiredHoursPerStudentFromOpportunity(p.project);
        }

        const university_mix = [...universityMap.entries()]
            .map(([university, count]) => ({ university, count }))
            .sort((a, b) => b.count - a.count);

        const degree_mix = [...degreeMap.entries()]
            .map(([degree, count]) => ({ degree, count }))
            .sort((a, b) => b.count - a.count);

        return {
            success: true,
            data: {
                organization_id: orgId,
                total_students_assigned,
                total_enrollments,
                verified_students,
                verification_rate_percent,
                university_mix,
                degree_mix,
                total_required_hours: Math.round(total_required_hours * 10) / 10,
            },
        };
    }

    /**
     * Partner (NGO) org: students on listings owned by this org (`opportunity.organizationId`).
     * Assignments = participation rows; distinct students and profile/identity verification match university analytics.
     */
    async getPartnerStudentsAnalytics(orgId: string) {
        const org = await this.organizationsRepository.findOne({ where: { id: orgId } });
        if (org && this.isUniversityOrgType(org.orgType)) {
            return this.getPartnerStudentsAnalyticsForUniversityOrg(orgId);
        }

        const st = [
            'pending',
            'pending_payment_approval',
            'paid',
            'pending_ciel_approval',
            'pending_faculty_approval',
            'approved',
            'verified',
            'accepted',
            'finalized',
        ];

        const participations = await this.participationRepository
            .createQueryBuilder('p')
            .innerJoinAndSelect('p.project', 'project')
            .leftJoinAndSelect('p.student', 'student')
            .where('p.student_id IS NOT NULL')
            .andWhere('project.organizationId = :orgId', { orgId })
            .andWhere('p.status IN (:...st)', { st })
            .getMany();

        const total_enrollments = participations.length;
        const distinctStudentIds = [
            ...new Set(participations.map((p) => p.studentId).filter((id): id is string => Boolean(id))),
        ];
        const total_students_assigned = distinctStudentIds.length;

        let verified_students = 0;
        if (distinctStudentIds.length > 0) {
            verified_students = await this.usersRepository.count({
                where: {
                    id: In(distinctStudentIds),
                    profile_verified: true,
                    identity_verified: true,
                },
            });
        }

        const verification_rate_percent =
            total_students_assigned === 0 ? 0 : Math.round((100 * verified_students) / total_students_assigned);

        const universityMap = new Map<string, number>();
        const degreeMap = new Map<string, number>();
        let total_required_hours = 0;

        for (const p of participations) {
            const uni =
                (p.universityName || '').trim() ||
                ((p.student as User | undefined)?.university || '').trim() ||
                'Unspecified';
            universityMap.set(uni, (universityMap.get(uni) || 0) + 1);

            const majorFallbackNgo = ((p.student as User | undefined)?.major || '').trim();
            const deg = (p.academicProgram || '').trim() || majorFallbackNgo || 'Unspecified';
            degreeMap.set(deg, (degreeMap.get(deg) || 0) + 1);

            total_required_hours += this.resolveRequiredHoursPerStudentFromOpportunity(p.project);
        }

        const university_mix = [...universityMap.entries()]
            .map(([university, count]) => ({ university, count }))
            .sort((a, b) => b.count - a.count);

        const degree_mix = [...degreeMap.entries()]
            .map(([degree, count]) => ({ degree, count }))
            .sort((a, b) => b.count - a.count);

        return {
            success: true,
            data: {
                organization_id: orgId,
                total_students_assigned,
                total_enrollments,
                verified_students,
                verification_rate_percent,
                university_mix,
                degree_mix,
                total_required_hours: Math.round(total_required_hours * 10) / 10,
            },
        };
    }

    private resolveRequiredHoursPerStudentFromOpportunity(project: Opportunity | null | undefined): number {
        if (!project) return 0;
        const raw = project.timeline?.expected_hours;
        const fromT = Number(raw);
        if (Number.isFinite(fromT) && fromT > 0) return fromT;
        const rh = Number(project.requiredHours);
        return Number.isFinite(rh) ? rh : 0;
    }

    private parsePrimarySdgGoalNumber(opp: Opportunity): number | null {
        const parse = (raw: unknown): number | null => {
            if (raw == null || raw === '') return null;
            const m = String(raw).match(/(\d{1,2})/);
            if (!m) return null;
            const n = parseInt(m[1], 10);
            return n >= 1 && n <= 17 ? n : null;
        };
        const fromInfo = parse(opp.sdg_info?.sdg_id);
        if (fromInfo != null) return fromInfo;
        return parse(opp.sdg);
    }

    private async getPartnerImpactMetricsForUniversityOrg(orgId: string, orgName: string) {
        const oppIds = await this.facultyUniversityScopeService.resolveOpportunityIdsForUniversityOrganization(orgId);

        const now = new Date();
        const emptyMonthlyTrend: Array<{ month: string; beneficiaries: number; hours: number }> = [];
        for (let i = 11; i >= 0; i--) {
            const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
            emptyMonthlyTrend.push({
                month: d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }),
                hours: 0,
                beneficiaries: 0,
            });
        }

        if (oppIds.length === 0) {
            return {
                success: true,
                data: {
                    totalBeneficiaries: 0,
                    totalProjects: 0,
                    totalHours: 0,
                    sdgDistribution: {},
                    monthlyTrend: emptyMonthlyTrend,
                },
            };
        }

        const opps = await this.opportunitiesRepository.find({
            where: { id: In(oppIds) },
        });

        const excluded = new Set(['draft', 'rejected']);
        let totalBeneficiaries = 0;
        const sdgCounts = new Map<number, number>();
        let totalProjects = 0;

        for (const o of opps) {
            const st = String(o.status || '').toLowerCase();
            if (!excluded.has(st)) {
                totalProjects += 1;
            }

            const obj = o.objectives as { beneficiaries_count?: number; total_beneficiaries?: number } | null;
            const b = Number(obj?.beneficiaries_count ?? obj?.total_beneficiaries ?? 0);
            if (Number.isFinite(b) && b > 0) {
                totalBeneficiaries += b;
            }

            const g = this.parsePrimarySdgGoalNumber(o);
            if (g != null) {
                sdgCounts.set(g, (sdgCounts.get(g) || 0) + 1);
            }
        }

        const affiliatedStudentIds = await this.resolveUniversityAffiliatedStudentIds(orgId, orgName);
        const verifiedTsAll = await this.timesheetsRepository.find({
            where: { opportunityId: In(oppIds), status: 'verified' },
        });
        // Same population fix as the dashboard stats — a shared opportunity's other-school
        // participants must not inflate this university's own impact numbers.
        const verifiedTs = verifiedTsAll.filter((t) => t.studentId && affiliatedStudentIds.has(t.studentId));
        const totalHours = verifiedTs.reduce((s, t) => s + (Number(t.hours) || 0), 0);

        const totalSdgWeight = [...sdgCounts.values()].reduce((a, b) => a + b, 0);
        const sdgDistribution: Record<string, number> = {};
        if (totalSdgWeight > 0) {
            for (const [k, v] of sdgCounts) {
                sdgDistribution[String(k)] = Math.round((100 * v) / totalSdgWeight);
            }
        }

        const byMonth = new Map<string, number>();
        for (const t of verifiedTs) {
            const d = t.updatedAt instanceof Date ? t.updatedAt : new Date(t.updatedAt);
            const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
            byMonth.set(key, (byMonth.get(key) || 0) + (Number(t.hours) || 0));
        }

        const monthlyTrend: Array<{ month: string; beneficiaries: number; hours: number }> = [];
        for (let i = 11; i >= 0; i--) {
            const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
            const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
            const hoursRaw = byMonth.get(key) || 0;
            const rounded = Math.round(hoursRaw * 10) / 10;
            monthlyTrend.push({
                month: d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }),
                hours: rounded,
                beneficiaries: Math.round(hoursRaw),
            });
        }

        return {
            success: true,
            data: {
                totalBeneficiaries: Math.round(totalBeneficiaries),
                totalProjects,
                totalHours: Math.round(totalHours * 10) / 10,
                sdgDistribution,
                monthlyTrend,
            },
        };
    }

    /** Partner impact analytics: org opportunities, objectives beneficiaries, SDG tags, verified timesheet hours. */
    async getPartnerImpactMetrics(orgId: string) {
        const org = await this.organizationsRepository.findOne({ where: { id: orgId } });
        if (org && this.isUniversityOrgType(org.orgType)) {
            return this.getPartnerImpactMetricsForUniversityOrg(orgId, org.name);
        }

        const opps = await this.opportunitiesRepository.find({
            where: { organizationId: orgId },
        });

        const excluded = new Set(['draft', 'rejected']);
        let totalBeneficiaries = 0;
        const sdgCounts = new Map<number, number>();
        let totalProjects = 0;

        for (const o of opps) {
            const st = String(o.status || '').toLowerCase();
            if (!excluded.has(st)) {
                totalProjects += 1;
            }

            const obj = o.objectives as { beneficiaries_count?: number; total_beneficiaries?: number } | null;
            const b = Number(obj?.beneficiaries_count ?? obj?.total_beneficiaries ?? 0);
            if (Number.isFinite(b) && b > 0) {
                totalBeneficiaries += b;
            }

            const g = this.parsePrimarySdgGoalNumber(o);
            if (g != null) {
                sdgCounts.set(g, (sdgCounts.get(g) || 0) + 1);
            }
        }

        const verifiedTs = await this.timesheetsRepository.find({
            where: { organizationId: orgId, status: 'verified' },
        });
        const totalHours = verifiedTs.reduce((s, t) => s + (Number(t.hours) || 0), 0);

        const totalSdgWeight = [...sdgCounts.values()].reduce((a, b) => a + b, 0);
        const sdgDistribution: Record<string, number> = {};
        if (totalSdgWeight > 0) {
            for (const [k, v] of sdgCounts) {
                sdgDistribution[String(k)] = Math.round((100 * v) / totalSdgWeight);
            }
        }

        const byMonth = new Map<string, number>();
        for (const t of verifiedTs) {
            const d = t.updatedAt instanceof Date ? t.updatedAt : new Date(t.updatedAt);
            const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
            byMonth.set(key, (byMonth.get(key) || 0) + (Number(t.hours) || 0));
        }

        const now = new Date();
        const monthlyTrend: Array<{ month: string; beneficiaries: number; hours: number }> = [];
        for (let i = 11; i >= 0; i--) {
            const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
            const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
            const hoursRaw = byMonth.get(key) || 0;
            const rounded = Math.round(hoursRaw * 10) / 10;
            monthlyTrend.push({
                month: d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }),
                hours: rounded,
                beneficiaries: Math.round(hoursRaw),
            });
        }

        return {
            success: true,
            data: {
                totalBeneficiaries: Math.round(totalBeneficiaries),
                totalProjects,
                totalHours: Math.round(totalHours * 10) / 10,
                sdgDistribution,
                monthlyTrend,
            },
        };
    }

    async remove(id: string) {
        const org = await this.findOne(id);
        return this.organizationsRepository.remove(org);
    }
}
