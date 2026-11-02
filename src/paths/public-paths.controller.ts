import { Controller, Get, Param } from '@nestjs/common';
import { PathsService } from './paths.service';

/** Unauthenticated, PII-minimal reads: verification links and the home-page spotlight. */
@Controller('public/paths')
export class PublicPathsController {
  constructor(private readonly pathsService: PathsService) {}

  @Get('fyp/:id/verification')
  fyp(@Param('id') id: string) {
    return this.pathsService.getPublicFypVerification(id);
  }

  @Get('venture/:id/verification')
  venture(@Param('id') id: string) {
    return this.pathsService.getPublicVentureVerification(id);
  }

  @Get('spotlight')
  spotlight() {
    return this.pathsService.getPublicSpotlight();
  }
}
