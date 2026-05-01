import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    Patch,
    Query,
    UseGuards,
    UseInterceptors,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { AdminSupportService } from './admin-support.service';
import { UpdateSupportTicketDto } from './dto/update-support-ticket.dto';
import { AdminMutationAuditInterceptor } from '../audit-logs/admin-mutation-audit.interceptor';

@Controller('admin/support')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
@UseInterceptors(AdminMutationAuditInterceptor)
export class AdminSupportController {
    constructor(private readonly adminSupportService: AdminSupportService) { }

    @Get('faqs')
    listFaqs() {
        return this.adminSupportService.listFaqs();
    }

    @Get('tickets')
    listTickets(@Query('status') status?: string) {
        return this.adminSupportService.listTickets(status);
    }

    @Get('tickets/:id')
    getTicket(@Param('id') id: string) {
        return this.adminSupportService.getTicket(id);
    }

    @Patch('tickets/:id')
    updateTicket(@Param('id') id: string, @Body() dto: UpdateSupportTicketDto) {
        return this.adminSupportService.updateTicket(id, dto);
    }

    @Delete('tickets/:id')
    @HttpCode(HttpStatus.NO_CONTENT)
    deleteTicket(@Param('id') id: string) {
        return this.adminSupportService.deleteTicket(id);
    }
}
