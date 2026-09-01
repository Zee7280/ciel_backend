import { Controller, Get, Body, Patch, UseGuards, Request, Post, UseInterceptors, UploadedFile, BadRequestException, ForbiddenException, Put, Delete, Param, Query } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { UpdateOrganizationDto } from '../organizations/dto/organization.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { MembershipActiveGuard } from '../organization-membership/membership-active.guard';
import { FileInterceptor } from '@nestjs/platform-express';
import { ReportsService } from '../reports/reports.service';
import { CreateReportDto } from '../reports/dto/create-report.dto';
import { UpdateReportDto } from '../reports/dto/update-report.dto';
import { OpportunitiesService } from '../opportunities/opportunities.service';
import { GetApplicantsDto } from './dto/get-applicants.dto';
import { UpdateApplicantDto } from './dto/update-applicant.dto';
import { StudentReportsService } from '../reports/student-reports.service';
import { CommunityAwardService } from '../reports/community-award.service';
import { FacultyUniversityScopeService } from '../faculty-university-scope/faculty-university-scope.service';
import { NotifyCommunityAwardDto } from '../reports/dto/notify-community-award.dto';
import { S3Service } from '../common/s3.service';
import { OpportunityApplicationsService } from '../opportunities/opportunity-applications.service';

@Controller('partners')
@UseGuards(JwtAuthGuard, RolesGuard, MembershipActiveGuard)
@Roles(UserRole.UNIVERSITY, UserRole.NGO, UserRole.CORPORATE, UserRole.ORGANIZATION_ADMIN)
export class PartnersController {
    constructor(
        private readonly usersService: UsersService,
        private readonly organizationsService: OrganizationsService,
        private readonly reportsService: ReportsService,
        private readonly opportunitiesService: OpportunitiesService,
        private readonly studentReportsService: StudentReportsService,
        private readonly s3Service: S3Service,
        private readonly opportunityApplicationsService: OpportunityApplicationsService,
        private readonly communityAward: CommunityAwardService,
        private readonly facultyUniversityScope: FacultyUniversityScopeService,
    ) { }

    @Get('me')
    async getPartnerProfile(@Request() req) {
        const org = await this.organizationsService.getMyOrganization(req.user.id);
        if (!org) {
            return { success: false, message: 'Organization not found' };
        }

        // Map to spec response
        return {
            success: true,
            data: {
                id: org.id,
                name: org.name,
                type: org.orgType,
                description: org.description,
                website: org.websiteUrl,
                city: org.city,
                address: org.address,
                region: org.region,
                country: org.country,
                logo_url: org.logoUrl,
                verification_status: org.verificationStatus, // map if needed
                verification_scope: org.verificationScope,
                works_with_minors: org.worksWithMinors,
                contact: {
                    name: org.contactName,
                    email: org.contactEmail,
                    phone: org.contactPhone
                },
                compliance: {
                    safeguarding_acknowledged: org.safeguardingAcknowledged,
                    data_policy_acknowledged: org.dataPolicyAcknowledged
                }
            }
        };
    }

    @Patch('me')
    async updatePartnerProfile(@Request() req, @Body() updateOrganizationDto: UpdateOrganizationDto) {
        // We might need to map incoming camelCase/snake_case if DTO doesn't handle it.
        // For now assuming DTO matches or is handled by ValidationPipe
        const updatedOrg = await this.organizationsService.updateMyOrganization(req.user.id, updateOrganizationDto);
        return { success: true, data: updatedOrg };
    }

    @Post('me/logo')
    @UseInterceptors(FileInterceptor('logo'))
    async uploadLogo(@Request() req, @UploadedFile() file: any, @Body() body: any) {
        if (!file) {
            throw new BadRequestException('Logo file not provided');
        }

        const logoUrl = await this.s3Service.uploadFile(file, 'logos');

        // Use userId from body if provided (and allowed), otherwise req.user.id
        // For now allowing it as per requirement. ideally should check admin role.
        const targetUserId = body.userId || body.id || req.user.id;

        await this.organizationsService.updateMyOrganization(targetUserId, { logoUrl });
        return { success: true, data: { logo_url: logoUrl } };
    }

    @Post('profile/logo')
    @UseInterceptors(FileInterceptor('logo'))
    async uploadLogoProfile(@Request() req, @UploadedFile() file: any, @Body() body: any) {
        return this.uploadLogo(req, file, body);
    }

    @Get('dashboard')
    async getDashboardStats(@Request() req, @Query('id') userId?: string) {
        let orgId = req.user.organizationId;

        if (userId) {
            // If ID is provided (e.g. for admin/testing), fetch that user's org
            const userOrg = await this.organizationsService.getMyOrganization(userId);
            if (userOrg) {
                orgId = userOrg.id;
            } else {
                throw new BadRequestException('User linked to provided ID has no organization');
            }
        }

        if (!orgId) {
            throw new BadRequestException('User is not linked to an organization');
        }
        return this.organizationsService.getPartnerDashboardStats(orgId);
    }

    @Get('community-service/award-cards')
    async communityAwardCards(@Request() req) {
        if (!req.user.organizationId) {
            throw new BadRequestException('User is not linked to an organization');
        }
        const org = await this.organizationsService.getMyOrganization(req.user.id);
        const isUni = String(org?.orgType || '').toLowerCase().includes('university');
        const data = isUni
            ? await this.communityAward.listForUniversity(req.user.organizationId)
            : await this.communityAward.listForPartnerOrg(req.user.organizationId);
        return { success: true, data, scope: isUni ? 'university' : 'partner' };
    }

    @Post('community-service/award-notify')
    async communityAwardNotify(@Request() req, @Body() dto: NotifyCommunityAwardDto) {
        if (!req.user.organizationId) {
            throw new BadRequestException('User is not linked to an organization');
        }
        const org = await this.organizationsService.getMyOrganization(req.user.id);
        const isUni = String(org?.orgType || '').toLowerCase().includes('university');
        const pool = isUni
            ? await this.communityAward.listForUniversity(req.user.organizationId)
            : await this.communityAward.listForPartnerOrg(req.user.organizationId);
        const kind = isUni ? 'uni' : 'par';
        const data = await this.communityAward.notifyFromPool(pool, {
            ...dto,
            kind,
            scopeLabel: dto.scopeLabel || org?.name,
        });
        return { success: true, data };
    }

    @Get('community-service/faculty-representatives')
    async communityFacultyRepresentatives(@Request() req) {
        if (!req.user.organizationId) {
            throw new BadRequestException('User is not linked to an organization');
        }
        const org = await this.organizationsService.getMyOrganization(req.user.id);
        const isUni = String(org?.orgType || '').toLowerCase().includes('university');
        if (!isUni) {
            throw new ForbiddenException('Faculty representatives are only available for university organizations.');
        }
        const rows = await this.facultyUniversityScope.listForUniversityOrganization(req.user.organizationId);
        return {
            success: true,
            data: rows.map((r) => ({
                id: r.id,
                faculty_user_id: r.facultyUser?.id,
                faculty_email: r.facultyUser?.email,
                faculty_name: r.facultyUser?.name,
                faculty_department: r.facultyUser?.faculty_department || r.facultyUser?.department,
                university_organization_name: r.universityOrganization?.name || org?.name,
                created_at: r.createdAt,
            })),
        };
    }

    /** University-organization participation & verification analytics (403 for non-university orgs). */
    @Get('university/analytics')
    async getUniversityAnalytics(@Request() req) {
        const orgId = req.user.organizationId;
        if (!orgId) {
            throw new BadRequestException('User is not linked to an organization');
        }
        return this.organizationsService.getUniversityAnalytics(orgId);
    }

    /** Partner org: students assigned to this partner’s opportunities, mix and required hours. */
    @Get('students/analytics')
    async getPartnerStudentsAnalytics(@Request() req) {
        const orgId = req.user.organizationId;
        if (!orgId) {
            throw new BadRequestException('User is not linked to an organization');
        }
        return this.organizationsService.getPartnerStudentsAnalytics(orgId);
    }

    @Get('impact/metrics')
    async getImpactMetrics(@Request() req) {
        const orgId = req.user.organizationId;
        if (!orgId) {
            throw new BadRequestException('User is not linked to an organization');
        }
        return this.organizationsService.getPartnerImpactMetrics(orgId);
    }

    // Reports Endpoints
    @Get('reports')
    getReports(@Request() req, @Query() query) {
        return this.reportsService.findAllForPartner(req.user.organizationId, query);
    }

    @Post('reports')
    createReport(@Request() req, @Body() dto: CreateReportDto) {
        return this.reportsService.createReport(req.user.organizationId, dto);
    }

    @Put('reports/:id')
    updateReport(@Request() req, @Param('id') id: string, @Body() dto: UpdateReportDto) {
        return this.reportsService.updateReport(id, req.user.organizationId, dto);
    }

    @Delete('reports/:id')
    deleteReport(@Request() req, @Param('id') id: string) {
        return this.reportsService.deleteReport(id, req.user.organizationId);
    }

    // Get Applicants for an Opportunity
    @Post('opportunities/applicants')
    async getApplicants(@Request() req, @Body() dto: GetApplicantsDto) {
        if (!req.user.organizationId) {
            throw new BadRequestException('User is not linked to an organization');
        }

        const applicants = await this.opportunitiesService.getApplicantsForOpportunity(
            dto.id,
            req.user.organizationId
        );
        return { success: true, data: applicants };
    }

    // Update Applicant Status
    @Post('opportunities/applicants/update')
    async updateApplicantStatus(@Request() req, @Body() dto: UpdateApplicantDto) {
        if (!req.user.organizationId) {
            throw new BadRequestException('User is not linked to an organization');
        }

        return this.opportunitiesService.updateApplicantStatus(
            dto.applicantId,
            dto.status,
            req.user.organizationId
        );
    }

    /** Student join requests on this org's listings: faculty-approved → partner (if required) → CIEL admin. */
    @Get('opportunity-applications')
    listOpportunityApplications(@Request() req, @Query('status') status?: 'pending' | 'history') {
        if (!req.user.organizationId) {
            throw new BadRequestException('User is not linked to an organization');
        }
        return this.opportunityApplicationsService.partnerList(
            req.user.organizationId,
            status === 'history' ? 'history' : 'pending',
        );
    }

    @Post('opportunity-applications/:id/approve')
    approveOpportunityApplication(@Request() req, @Param('id') id: string) {
        if (!req.user.organizationId) {
            throw new BadRequestException('User is not linked to an organization');
        }
        return this.opportunityApplicationsService.partnerApprove(id, req.user.organizationId);
    }

    @Post('opportunity-applications/:id/reject')
    rejectOpportunityApplication(
        @Request() req,
        @Param('id') id: string,
        @Body() body: { reason?: string },
    ) {
        if (!req.user.organizationId) {
            throw new BadRequestException('User is not linked to an organization');
        }
        return this.opportunityApplicationsService.partnerReject(
            id,
            req.user.organizationId,
            body?.reason || '',
        );
    }

    @Get('student-reports')
    getStudentReports(@Request() req, @Query() query: any) {
        if (!req.user.organizationId) {
            throw new BadRequestException('User is not linked to an organization');
        }
        return this.studentReportsService.findAll({
            ...query,
            organizationId: req.user.organizationId
        });
    }

    @Get('student-reports/:id')
    getStudentReportById(@Request() req, @Param('id') id: string) {
        return this.studentReportsService.findOneForPartner(id, req.user.organizationId);
    }

    @Patch('student-reports/:id/verify')
    @Post('student-reports/:id/verify')
    verifyStudentReport(
        @Request() req,
        @Param('id') id: string,
        @Body() body: { action: 'approve' | 'reject'; reason?: string; feedback?: string; verified_by?: string }
    ) {
        return this.studentReportsService.verifyReport(
            id,
            body.action,
            req.user.role,
            body.reason || body.feedback,
            req.user.organizationId,
        );
    }

    @Post('approvals/:id/approve')
    async approveOpportunity(@Request() req, @Param('id') id: string) {
        const saved = await this.opportunitiesService.partnerDashboardApprove(id, {
            email: req.user.email || '',
            organizationId: req.user.organizationId || null,
        });
        return {
            success: true,
            message: 'Partner approval completed',
            data: {
                id: saved.id,
                partner_approval_status: saved.partnerApprovalStatus,
                workflow_stage: saved.workflowStage,
            },
        };
    }

    @Post('approvals/:id/reject')
    async rejectOpportunity(
        @Request() req,
        @Param('id') id: string,
        @Body() body: { reason?: string },
    ) {
        const saved = await this.opportunitiesService.partnerDashboardReject(
            id,
            {
                email: req.user.email || '',
                organizationId: req.user.organizationId || null,
            },
            body?.reason,
        );
        return {
            success: true,
            message: 'Partner permanent rejection submitted',
            data: {
                id: saved.id,
                partner_approval_status: saved.partnerApprovalStatus,
                workflow_stage: saved.workflowStage,
            },
        };
    }

    @Post('approvals/:id/revise')
    async reviseOpportunity(
        @Request() req,
        @Param('id') id: string,
        @Body() body: { reason?: string },
    ) {
        const saved = await this.opportunitiesService.partnerDashboardRevise(
            id,
            {
                email: req.user.email || '',
                organizationId: req.user.organizationId || null,
            },
            body?.reason,
        );
        return {
            success: true,
            message: 'Partner revision request submitted',
            data: {
                id: saved.id,
                partner_approval_status: saved.partnerApprovalStatus,
                workflow_stage: saved.workflowStage,
            },
        };
    }
}

// Explicit alias controller for singular /partner routes
@Controller('partner')
@UseGuards(JwtAuthGuard, RolesGuard, MembershipActiveGuard)
@Roles(UserRole.UNIVERSITY, UserRole.NGO, UserRole.CORPORATE, UserRole.ORGANIZATION_ADMIN)
export class PartnerAliasController {
    constructor(
        private readonly studentReportsService: StudentReportsService,
        private readonly opportunitiesService: OpportunitiesService,
        private readonly opportunityApplicationsService: OpportunityApplicationsService,
        private readonly organizationsService: OrganizationsService,
        private readonly facultyUniversityScope: FacultyUniversityScopeService,
    ) { }

    @Get('reports')
    async getReports(@Request() req, @Query() query: any) {
        if (!req.user.organizationId) {
            throw new BadRequestException('User is not linked to an organization');
        }
        const org = await this.organizationsService.getMyOrganization(req.user.id);
        if (org && this.facultyUniversityScope.isUniversityOrganization(org)) {
            const ids = await this.facultyUniversityScope.resolveOpportunityIdsForUniversityOrganization(org.id);
            return this.studentReportsService.findAllByOpportunityIds(ids, query);
        }
        return this.studentReportsService.findAll({
            ...query,
            organizationId: req.user.organizationId
        });
    }

    @Get('opportunity-applications')
    listOpportunityApplications(@Request() req, @Query('status') status?: 'pending' | 'history') {
        if (!req.user.organizationId) {
            throw new BadRequestException('User is not linked to an organization');
        }
        return this.opportunityApplicationsService.partnerList(
            req.user.organizationId,
            status === 'history' ? 'history' : 'pending',
        );
    }

    @Post('opportunity-applications/:id/approve')
    approveOpportunityApplication(@Request() req, @Param('id') id: string) {
        if (!req.user.organizationId) {
            throw new BadRequestException('User is not linked to an organization');
        }
        return this.opportunityApplicationsService.partnerApprove(id, req.user.organizationId);
    }

    @Post('opportunity-applications/:id/reject')
    rejectOpportunityApplication(
        @Request() req,
        @Param('id') id: string,
        @Body() body: { reason?: string },
    ) {
        if (!req.user.organizationId) {
            throw new BadRequestException('User is not linked to an organization');
        }
        return this.opportunityApplicationsService.partnerReject(
            id,
            req.user.organizationId,
            body?.reason || '',
        );
    }

    @Get('reports/:id')
    getReportById(@Request() req, @Param('id') id: string) {
        return this.studentReportsService.findOneForPartner(id, req.user.organizationId);
    }

    @Patch('reports/:id/verify')
    @Post('reports/:id/verify')
    verifyReport(
        @Request() req,
        @Param('id') id: string,
        @Body() body: { action: 'approve' | 'reject'; reason?: string; feedback?: string; verified_by?: string }
    ) {
        return this.studentReportsService.verifyReport(
            id,
            body.action,
            req.user.role,
            body.reason || body.feedback,
            req.user.organizationId,
        );
    }

    @Post('opportunities/applicants')
    async getApplicants(@Request() req, @Body() dto: GetApplicantsDto) {
        if (!req.user.organizationId) {
            throw new BadRequestException('User is not linked to an organization');
        }

        const applicants = await this.opportunitiesService.getApplicantsForOpportunity(
            dto.id,
            req.user.organizationId
        );
        return { success: true, data: applicants };
    }

    @Post('opportunities/applicants/update')
    async updateApplicantStatus(@Request() req, @Body() dto: UpdateApplicantDto) {
        if (!req.user.organizationId) {
            throw new BadRequestException('User is not linked to an organization');
        }

        return this.opportunitiesService.updateApplicantStatus(
            dto.applicantId,
            dto.status,
            req.user.organizationId
        );
    }

    @Post('approvals/:id/approve')
    async approveOpportunity(@Request() req, @Param('id') id: string) {
        const saved = await this.opportunitiesService.partnerDashboardApprove(id, {
            email: req.user.email || '',
            organizationId: req.user.organizationId || null,
        });
        return {
            success: true,
            message: 'Partner approval completed',
            data: {
                id: saved.id,
                partner_approval_status: saved.partnerApprovalStatus,
                workflow_stage: saved.workflowStage,
            },
        };
    }

    @Post('approvals/:id/reject')
    async rejectOpportunity(
        @Request() req,
        @Param('id') id: string,
        @Body() body: { reason?: string },
    ) {
        const saved = await this.opportunitiesService.partnerDashboardReject(
            id,
            {
                email: req.user.email || '',
                organizationId: req.user.organizationId || null,
            },
            body?.reason,
        );
        return {
            success: true,
            message: 'Partner permanent rejection submitted',
            data: {
                id: saved.id,
                partner_approval_status: saved.partnerApprovalStatus,
                workflow_stage: saved.workflowStage,
            },
        };
    }

    @Post('approvals/:id/revise')
    async reviseOpportunity(
        @Request() req,
        @Param('id') id: string,
        @Body() body: { reason?: string },
    ) {
        const saved = await this.opportunitiesService.partnerDashboardRevise(
            id,
            {
                email: req.user.email || '',
                organizationId: req.user.organizationId || null,
            },
            body?.reason,
        );
        return {
            success: true,
            message: 'Partner revision request submitted',
            data: {
                id: saved.id,
                partner_approval_status: saved.partnerApprovalStatus,
                workflow_stage: saved.workflowStage,
            },
        };
    }
}
