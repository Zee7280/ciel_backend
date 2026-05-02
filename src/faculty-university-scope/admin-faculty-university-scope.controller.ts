import { Body, Controller, Delete, Get, Param, Post, Request, UseGuards, UseInterceptors } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { FacultyUniversityScopeService } from './faculty-university-scope.service';
import { AssignFacultyUniversityScopeDto } from './dto/assign-faculty-university-scope.dto';
import { AdminMutationAuditInterceptor } from '../audit-logs/admin-mutation-audit.interceptor';

@Controller('admin/faculty-university-scope')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
@UseInterceptors(AdminMutationAuditInterceptor)
export class AdminFacultyUniversityScopeController {
    constructor(private readonly facultyUniversityScopeService: FacultyUniversityScopeService) {}

    @Get()
    list() {
        return this.facultyUniversityScopeService.listAll().then((rows) => ({
            success: true,
            data: rows.map((r) => ({
                id: r.id,
                faculty_user_id: r.facultyUser?.id,
                faculty_email: r.facultyUser?.email,
                faculty_name: r.facultyUser?.name,
                university_organization_id: r.universityOrganization?.id,
                university_organization_name: r.universityOrganization?.name,
                assigned_by_admin_id: r.assignedByAdmin?.id,
                created_at: r.createdAt,
            })),
        }));
    }

    @Post()
    async assign(@Request() req: { user: { id: string } }, @Body() dto: AssignFacultyUniversityScopeDto) {
        const saved = await this.facultyUniversityScopeService.assign({
            facultyUserId: dto.facultyUserId,
            universityOrganizationId: dto.universityOrganizationId,
            assignedByAdminId: req.user.id,
        });
        return {
            success: true,
            data: {
                id: saved.id,
                faculty_user_id: saved.facultyUser?.id ?? dto.facultyUserId,
                university_organization_id:
                    saved.universityOrganization?.id ?? dto.universityOrganizationId,
            },
        };
    }

    @Delete(':facultyUserId')
    async remove(@Param('facultyUserId') facultyUserId: string) {
        await this.facultyUniversityScopeService.remove(facultyUserId);
        return { success: true };
    }
}
