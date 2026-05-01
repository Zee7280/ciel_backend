import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Participation } from '../engagement/entities/participant.entity';
import { Setting } from '../settings/entities/setting.entity';
import { StorageModule } from '../common/storage.module';
import { PaymentsService } from './payments.service';
import { StudentPaymentsController } from './student-payments.controller';
import { AdminPaymentsController } from './admin-payments.controller';

import { Payment } from './entities/payment.entity';
import { StudentReport } from '../reports/entities/student-report.entity';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';

@Module({
    imports: [
        AuditLogsModule,
        TypeOrmModule.forFeature([Participation, Setting, Payment, StudentReport]),
        StorageModule,
    ],
    controllers: [StudentPaymentsController, AdminPaymentsController],
    providers: [PaymentsService],
    exports: [PaymentsService],
})
export class PaymentsModule { }
