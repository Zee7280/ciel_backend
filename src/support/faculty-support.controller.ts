import {
    Body,
    Controller,
    Get,
    Param,
    Post,
    Query,
    Request,
    UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { StudentSupportService } from './student-support.service';
import { CreateSupportTicketDto } from './dto/create-support-ticket.dto';
import { CreateTicketRateLimitGuard } from './guards/create-ticket-rate-limit.guard';

@Controller('faculty/support')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.FACULTY)
export class FacultySupportController {
    constructor(private readonly supportService: StudentSupportService) { }

    @Get('faqs')
    listFaqs() {
        return this.supportService.listFaqs();
    }

    @Get('tickets')
    listTickets(@Request() req) {
        return this.supportService.listTickets(req.user.id);
    }

    @Get('tickets/track')
    trackTicket(@Request() req, @Query('reference') reference?: string) {
        return this.supportService.trackByReference(req.user.id, reference);
    }

    @Get('tickets/:id')
    getTicket(@Request() req, @Param('id') id: string) {
        return this.supportService.getTicket(req.user.id, id);
    }

    @Post('tickets')
    @UseGuards(CreateTicketRateLimitGuard)
    createTicket(@Request() req, @Body() dto: CreateSupportTicketDto) {
        return this.supportService.createTicket(req.user.id, dto, 'FC');
    }
}
