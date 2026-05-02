import { Controller, Get, Body, Patch, UseGuards, Request, Post, UseInterceptors, UploadedFile, BadRequestException, Put, Delete, Param, Query } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { UpdateOrganizationDto } from '../organizations/dto/organization.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MembershipActiveGuard } from '../organization-membership/membership-active.guard';
import { FileInterceptor } from '@nestjs/platform-express';
import { ReportsService } from '../reports/reports.service';
import { CreateReportDto } from '../reports/dto/create-report.dto';
import { UpdateReportDto } from '../reports/dto/update-report.dto';
import { OpportunitiesService } from '../opportunities/opportunities.service';
import { GetApplicantsDto } from './dto/get-applicants.dto';
import { UpdateApplicantDto } from './dto/update-applicant.dto';
import { StudentReportsService } from '../reports/student-reports.service';
import { S3Service } from '../common/s3.service';
import { OpportunityApplicationsService } from '../opportunities/opportunity-applications.service';

@Controller('partners')
@UseGuards(JwtAuthGuard, MembershipActiveGuard)
export class PartnersController {
    constructor(
        private readonly usersService: UsersService,
        private readonly organizationsService: OrganizationsService,
        private readonly reportsService: ReportsService,
        private readonly opportunitiesService: OpportunitiesService,
        private readonly studentReportsService: StudentReportsService,
        private readonly s3Service: S3Service,
        private readonly opportunityApplicationsService: OpportunityApplicationsService,
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
            message: 'Partner rejection submitted',
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
@UseGuards(JwtAuthGuard, MembershipActiveGuard)
export class PartnerAliasController {
    constructor(
        private readonly studentReportsService: StudentReportsService,
        private readonly opportunitiesService: OpportunitiesService,
        private readonly opportunityApplicationsService: OpportunityApplicationsService,
    ) { }

    @Get('reports')
    getReports(@Request() req, @Query() query: any) {
        if (!req.user.organizationId) {
            throw new BadRequestException('User is not linked to an organization');
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
            message: 'Partner rejection submitted',
            data: {
                id: saved.id,
                partner_approval_status: saved.partnerApprovalStatus,
                workflow_stage: saved.workflowStage,
            },
        };
    }
}
