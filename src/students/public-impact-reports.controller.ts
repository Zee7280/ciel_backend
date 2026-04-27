import { Controller, Get, Param } from '@nestjs/common';
import { StudentReportsService } from '../reports/student-reports.service';

@Controller('public/impact-reports')
export class PublicImpactReportsController {
    constructor(private readonly studentReportsService: StudentReportsService) {}

    @Get(':verificationKey/verification')
    getVerification(@Param('verificationKey') verificationKey: string) {
        return this.studentReportsService.getPublicImpactReportVerification(verificationKey);
    }
}
