
import { Controller, Get, Post, Body, UseGuards, Request } from '@nestjs/common';
import { FundingService } from './funding.service';
import { CreateFundingApplicationDto } from './dto/create-application.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MembershipActiveGuard } from '../organization-membership/membership-active.guard';

@Controller('partners/funding')
@UseGuards(JwtAuthGuard)
export class FundingController {
    constructor(private readonly fundingService: FundingService) { }

    @Get('opportunities')
    async getOpportunities() {
        const data = await this.fundingService.findAllOpportunities();
        return { success: true, data };
    }

    @Post('applications')
    @UseGuards(MembershipActiveGuard)
    async createApplication(@Request() req, @Body() dto: CreateFundingApplicationDto) {
        const data = await this.fundingService.createApplication(req.user.organizationId, dto);
        return { success: true, data };
    }

    @Get('applications')
    async getApplications(@Request() req) {
        const data = await this.fundingService.getApplications(req.user.organizationId);
        return { success: true, data };
    }
}
