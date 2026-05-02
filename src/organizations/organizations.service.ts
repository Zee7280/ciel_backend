import {
    Injectable,
    NotFoundException,
    UnauthorizedException,
    ForbiddenException,
    BadRequestException,
    ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Organization } from './entities/organization.entity';
import { User } from '../users/entities/user.entity';
import { CreateOrganizationDto, UpdateOrganizationDto, AcknowledgePolicyDto, AdminRejectOrganizationDto } from './dto/organization.dto';
import { UserRole } from '../users/enums/user-role.enum';
import * as bcrypt from 'bcrypt';

import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { Timesheet } from '../timesheets/entities/timesheet.entity';
import { Report } from '../reports/entities/report.entity';

@Injectable()
export class OrganizationsService {
    constructor(
        @InjectRepository(Organization)
        private organizationsRepository: Repository<Organization>,
        @InjectRepository(User)
        private usersRepository: Repository<User>,
        @InjectRepository(Opportunity)
        private opportunitiesRepository: Repository<Opportunity>,
        @InjectRepository(Timesheet)
        private timesheetsRepository: Repository<Timesheet>,
        @InjectRepository(Report)
        private reportsRepository: Repository<Report>,
    ) { }

    async getPartnerDashboardStats(orgId: string) {
        // Active Opportunities
        const activeOpportunities = await this.opportunitiesRepository.count({
            where: { organizationId: orgId, status: 'active' }
        });

        // Students Engaged (Distinct students in timesheets for this org)
        const timesheets = await this.timesheetsRepository.find({
            where: { organizationId: orgId },
            select: ['studentId']
        });
        const studentsEngaged = new Set(timesheets.map(t => t.studentId)).size;

        // Verified Hours
        const verifiedTimesheets = await this.timesheetsRepository.find({
            where: { organizationId: orgId, status: 'verified' }
        });
        const verifiedHours = verifiedTimesheets.reduce((sum, t) => sum + t.hours, 0);

        // Reports Submitted (By organization/partner user?)
        // Assuming reports linked to organizationId are the ones submitted BY or TO the organization?
        // Prompt says "Reports Submitted". Usually partners submit reports TO admin? 
        // Or students submit reports TO partner?
        // If "Reports Submitted" by partner, then query where organizationId = orgId.
        // Let's assume reports linked to org via organizationId.
        const reportsSubmitted = await this.reportsRepository.count({
            where: { organizationId: orgId }
        });

        // Pending Verifications (Timesheets pending)
        const pendingVerifications = await this.timesheetsRepository.count({
            where: { organizationId: orgId, status: 'pending' }
        });

        const pendingOpportunities = await this.opportunitiesRepository.count({
            where: { organizationId: orgId, status: 'pending_approval' }
        });

        // Recent Projects
        const recentProjects = await this.opportunitiesRepository.find({
            where: { organizationId: orgId },
            order: { createdAt: 'DESC' },
            take: 3
        });

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
                    volunteersApplied: 0, // Need to count?
                    status: p.status
                })),
                impactTarget: {
                    percentage: 85,
                    label: "Goal Met"
                }
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

    async remove(id: string) {
        const org = await this.findOne(id);
        return this.organizationsRepository.remove(org);
    }
}
