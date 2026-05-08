import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { TutorialsService } from './tutorials.service';

@Controller('student/tutorials')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.STUDENT)
export class StudentTutorialsController {
    constructor(private readonly tutorialsService: TutorialsService) {}

    @Get()
    list() {
        return this.tutorialsService.listForStudents();
    }
}
