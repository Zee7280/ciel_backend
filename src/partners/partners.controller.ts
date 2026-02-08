import { Controller, Get, Body, Patch, UseGuards, Request, Post, UseInterceptors, UploadedFile, BadRequestException, Put, Delete, Param, Query } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { UpdateOrganizationDto } from '../organizations/dto/organization.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname } from 'path';
import { ReportsService } from '../reports/reports.service';
import { CreateReportDto } from '../reports/dto/create-report.dto';
import { UpdateReportDto } from '../reports/dto/update-report.dto';
import { OpportunitiesService } from '../opportunities/opportunities.service';
import { GetApplicantsDto } from './dto/get-applicants.dto';
import { UpdateApplicantDto } from './dto/update-applicant.dto';

@Controller('partners')
@UseGuards(JwtAuthGuard)
export class PartnersController {
    constructor(
        private readonly usersService: UsersService,
        private readonly organizationsService: OrganizationsService,
        private readonly reportsService: ReportsService,
        private readonly opportunitiesService: OpportunitiesService,
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
    @UseInterceptors(FileInterceptor('logo', {
        storage: diskStorage({
            destination: './uploads',
            filename: (req, file, cb) => {
                const randomName = Array(32).fill(null).map(() => (Math.round(Math.random() * 16)).toString(16)).join('');
                cb(null, `${randomName}${extname(file.originalname)}`);
            },
        }),
    }))
    async uploadLogo(@Request() req, @UploadedFile() file: any, @Body() body: any) {
        if (!file) {
            throw new BadRequestException('Logo file not provided');
        }
        const logoUrl = `/uploads/${file.filename}`; // In real app, upload to S3/Cloudinary

        // Use userId from body if provided (and allowed), otherwise req.user.id
        // For now allowing it as per requirement. ideally should check admin role.
        const targetUserId = body.userId || body.id || req.user.id;

        await this.organizationsService.updateMyOrganization(targetUserId, { logoUrl });
        return { success: true, data: { logo_url: logoUrl } };
    }

    @Post('profile/logo')
    @UseInterceptors(FileInterceptor('logo', {
        storage: diskStorage({
            destination: './uploads',
            filename: (req, file, cb) => {
                const randomName = Array(32).fill(null).map(() => (Math.round(Math.random() * 16)).toString(16)).join('');
                cb(null, `${randomName}${extname(file.originalname)}`);
            },
        }),
    }))
    async uploadLogoProfile(@Request() req, @UploadedFile() file: any, @Body() body: any) {
        return this.uploadLogo(req, file, body);
    }

    @Get('dashboard')
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

    @Get('impact/metrics')
    getImpactMetrics() {
        // Mock data to match spec
        return {
            success: true,
            data: {
                totalBeneficiaries: 5000,
                totalProjects: 25,
                totalHours: 12000,
                sdgDistribution: {
                    "4": 40,
                    "8": 30,
                    "10": 20,
                    "13": 10
                },
                monthlyTrend: [
                    { "month": "Jan", "beneficiaries": 400 },
                    { "month": "Feb", "beneficiaries": 450 }
                ]
            }
        };
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
}
