import { Body, Controller, Get, Param, Patch, Post, Query, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { VerificationVerifyAuthGuard } from '../auth/verification-verify-auth.guard';
import { OpportunitiesService } from './opportunities.service';
import { CreateOpportunityDto, UpdateOpportunityDto } from './dto/create-opportunity.dto';

@Controller('student/opportunities')
export class StudentOpportunitiesController {
    constructor(private readonly opportunitiesService: OpportunitiesService) { }

    @Post()
    @UseGuards(JwtAuthGuard)
    create(@Request() req, @Body() dto: CreateOpportunityDto) {
        return this.opportunitiesService.createStudentOpportunity(req.user.id, dto);
    }

    @UseGuards(VerificationVerifyAuthGuard)
    @Get('faculty/verify')
    verify(@Request() req, @Query('token') token: string) {
        return this.opportunitiesService.verifyFaculty(token, req.user);
    }
}

/**
 * Singular alias of `StudentOpportunitiesController` — the frontend's create-opportunity form and
 * its Next.js API proxies (`/api/v1/student/opportunity[/:id]`) call this exact singular path.
 * Kept as its own controller (rather than renaming the plural one) so nothing that already depends
 * on `student/opportunities` breaks.
 */
@Controller('student/opportunity')
export class StudentOpportunitySingularController {
    constructor(private readonly opportunitiesService: OpportunitiesService) { }

    @Post()
    @UseGuards(JwtAuthGuard)
    create(@Request() req, @Body() body: Record<string, unknown>) {
        if (body?.draft === true) {
            return this.opportunitiesService.saveStudentOpportunityDraft(req.user.id, null, body);
        }
        return this.opportunitiesService.createStudentOpportunity(req.user.id, body as unknown as CreateOpportunityDto);
    }

    @Post(':id')
    @UseGuards(JwtAuthGuard)
    updateViaPost(@Request() req, @Param('id') id: string, @Body() body: Record<string, unknown>) {
        return this.updateOrSaveDraft(req, id, body);
    }

    @Patch(':id')
    @UseGuards(JwtAuthGuard)
    updateViaPatch(@Request() req, @Param('id') id: string, @Body() body: Record<string, unknown>) {
        return this.updateOrSaveDraft(req, id, body);
    }

    @UseGuards(JwtAuthGuard)
    @Get('mine')
    mine(@Request() req, @Query('status') status?: string) {
        return this.opportunitiesService.findMineForStudent(req.user.id, { status });
    }

    private updateOrSaveDraft(req, id: string, body: Record<string, unknown>) {
        if (body?.draft === true) {
            return this.opportunitiesService.saveStudentOpportunityDraft(req.user.id, id, body);
        }
        const dto = { ...body, id } as UpdateOpportunityDto;
        return this.opportunitiesService.update(req.user.id, dto, req.user.organizationId);
    }
}
