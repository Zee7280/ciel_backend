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

@Controller('student/support')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.STUDENT)
export class StudentSupportController {
    constructor(private readonly studentSupportService: StudentSupportService) { }

    @Get('faqs')
    listFaqs() {
        return this.studentSupportService.listFaqs();
    }

    @Get('tickets')
    listTickets(@Request() req) {
        return this.studentSupportService.listTickets(req.user.id);
    }

    @Get('tickets/track')
    trackTicket(@Request() req, @Query('reference') reference?: string) {
        return this.studentSupportService.trackByReference(req.user.id, reference);
    }

    @Get('tickets/:id')
    getTicket(@Request() req, @Param('id') id: string) {
        return this.studentSupportService.getTicket(req.user.id, id);
    }

    @Post('tickets')
    @UseGuards(CreateTicketRateLimitGuard)
    createTicket(@Request() req, @Body() dto: CreateSupportTicketDto) {
        return this.studentSupportService.createTicket(req.user.id, dto);
    }
}
