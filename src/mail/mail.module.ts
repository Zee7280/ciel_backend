import { Module, Global } from '@nestjs/common';
import { MailService } from './mail.service';
import { AdminMailController } from './admin-mail.controller';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';

@Global()
@Module({
    imports: [AuditLogsModule],
    controllers: [AdminMailController],
    providers: [MailService],
    exports: [MailService],
})
export class MailModule { }
