import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { TutorialsService } from './tutorials.service';

/**
 * Shared read API for all dashboard roles (student, faculty, partners / institutions).
 * Same payload as legacy GET /student/tutorials.
 */
@Controller('tutorials')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(
    UserRole.STUDENT,
    UserRole.FACULTY,
    UserRole.NGO,
    UserRole.UNIVERSITY,
    UserRole.CORPORATE,
    UserRole.ORGANIZATION_ADMIN,
)
export class PlatformTutorialsController {
    constructor(private readonly tutorialsService: TutorialsService) {}

    @Get()
    list() {
        return this.tutorialsService.listForStudents();
    }
}
