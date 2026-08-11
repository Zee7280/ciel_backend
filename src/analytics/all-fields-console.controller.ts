import { Controller, Get, Query, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { AllFieldsConsoleService } from './all-fields-console.service';
import { AllFieldsConsoleViewAsQueryDto } from './dto/all-fields-console-query.dto';

/**
 * Super Admin All-Fields Analytics Console.
 * Additive endpoints — does not alter existing role analytics routes.
 */
@Controller('admin/analytics/all-fields-console')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class AllFieldsConsoleController {
  constructor(private readonly consoleService: AllFieldsConsoleService) {}

  /** Field ownership registry (read-only) for Sections 1–10. */
  @Get('registry')
  getRegistry() {
    return this.consoleService.getRegistry();
  }

  /**
   * View-as stakeholder mirror: platform aggregate filtered to the selected
   * role’s field lens (not a live impersonation session).
   */
  @Get('view-as')
  getViewAs(@Request() req, @Query() query: AllFieldsConsoleViewAsQueryDto) {
    return this.consoleService.getViewAs(req.user, query.role, query.section, {
      project_id: query.project_id,
      university: query.university,
      scope: query.scope,
    });
  }
}
