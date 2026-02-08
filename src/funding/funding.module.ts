
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FundingService } from './funding.service';
import { FundingController } from './funding.controller';
import { FundingOpportunity } from './entities/funding-opportunity.entity';
import { FundingApplication } from './entities/funding-application.entity';

@Module({
    imports: [TypeOrmModule.forFeature([FundingOpportunity, FundingApplication])],
    controllers: [FundingController],
    providers: [FundingService],
})
export class FundingModule { }
