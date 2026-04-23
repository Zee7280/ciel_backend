import { Controller, Get, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { FacultyService } from './faculty.service';

@Controller('faculty')
@UseGuards(JwtAuthGuard)
export class FacultyDashboardController {
    constructor(private readonly facultyService: FacultyService) {}

    @Get('dashboard')
    async getDashboard(@Request() req: { user: { id: string; email?: string } }) {
        return this.facultyService.getDashboard(req.user.id, req.user.email || '');
    }
}
