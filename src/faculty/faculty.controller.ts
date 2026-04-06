import { Controller, Get, Query, Param, UseGuards, Request } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { FacultyService } from './faculty.service';

@Controller('faculty/approvals')
@UseGuards(JwtAuthGuard)
export class FacultyController {
    constructor(private readonly facultyService: FacultyService) { }

    @Get()
    async getApprovals(
        @Request() req,
        @Query('status') status?: string
    ) {
        return this.facultyService.getApprovals(req.user.id, status);
    }

    /** Full student project (opportunity) detail + linked reports for this faculty supervisor */
    @Get(':id')
    async getProjectDetail(@Request() req, @Param('id') id: string) {
        return this.facultyService.getProjectDetail(req.user.id, id);
    }
}
