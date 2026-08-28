import { Controller, Get, Param } from '@nestjs/common';
import { PathsService } from './paths.service';

@Controller('public/coursework')
export class PublicCourseworkVerificationController {
    constructor(private readonly pathsService: PathsService) {}

    @Get(':verificationKey/verification')
    getVerification(@Param('verificationKey') verificationKey: string) {
        return this.pathsService.getPublicCourseworkVerification(verificationKey);
    }
}
