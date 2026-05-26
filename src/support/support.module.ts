import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SupportFaq } from './entities/support-faq.entity';
import { SupportTicket } from './entities/support-ticket.entity';
import { User } from '../users/entities/user.entity';
import { StudentSupportService } from './student-support.service';
import { StudentSupportController } from './student-support.controller';
import { FacultySupportController } from './faculty-support.controller';
import { PartnerSupportController } from './partner-support.controller';
import { AdminSupportService } from './admin-support.service';
import { AdminSupportController } from './admin-support.controller';
import { CreateTicketRateLimitGuard } from './guards/create-ticket-rate-limit.guard';

import { AuditLogsModule } from '../audit-logs/audit-logs.module';

@Module({
    imports: [TypeOrmModule.forFeature([SupportFaq, SupportTicket, User]), AuditLogsModule],
    controllers: [
        StudentSupportController,
        FacultySupportController,
        PartnerSupportController,
        AdminSupportController,
    ],
    providers: [StudentSupportService, AdminSupportService, CreateTicketRateLimitGuard],
})
export class SupportModule { }
