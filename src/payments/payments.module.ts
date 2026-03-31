import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Participation } from '../engagement/entities/participant.entity';
import { Setting } from '../settings/entities/setting.entity';
import { StorageModule } from '../common/storage.module';
import { PaymentsService } from './payments.service';
import { StudentPaymentsController } from './student-payments.controller';
import { AdminPaymentsController } from './admin-payments.controller';

@Module({
    imports: [
        TypeOrmModule.forFeature([Participation, Setting]),
        StorageModule,
    ],
    controllers: [StudentPaymentsController, AdminPaymentsController],
    providers: [PaymentsService],
    exports: [PaymentsService],
})
export class PaymentsModule { }
