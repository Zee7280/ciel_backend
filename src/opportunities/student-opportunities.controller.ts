import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { VerificationVerifyAuthGuard } from '../auth/verification-verify-auth.guard';
import { OpportunitiesService } from './opportunities.service';
import { CreateOpportunityDto } from './dto/create-opportunity.dto';

@Controller('student/opportunities')
export class StudentOpportunitiesController {
  constructor(private readonly opportunitiesService: OpportunitiesService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  create(@Request() req, @Body() dto: CreateOpportunityDto) {
    return this.opportunitiesService.createStudentOpportunity(req.user.id, dto);
  }

  @UseGuards(VerificationVerifyAuthGuard)
  @Get('faculty/verify')
  verify(@Request() req, @Query('token') token: string) {
    return this.opportunitiesService.verifyFaculty(token, req.user);
  }
}

/**
 * Singular alias of `StudentOpportunitiesController`, `student/opportunity` (no `Post()`/`Patch(':id')`
 * handlers here on purpose — those paths are also registered by `StudentController`
 * (`student.controller.ts`, `@Controller('student')` + `@Post('opportunity'[/':id'])`), which wins
 * route resolution since `StudentsModule` is imported before `OpportunitiesModule` in `app.module.ts`.
 * Registering the same POST/PATCH paths here a second time previously made this controller's
 * draft-save branch (`body.draft === true`) permanently unreachable dead code — draft saves silently
 * fell through to `StudentController`'s full-validation create/update instead, throwing on any
 * incomplete mid-wizard draft. Draft-awareness now lives directly in `StudentController`. Only `GET
 * mine` (a path `StudentController` doesn't define) stays here.
 */
@Controller('student/opportunity')
export class StudentOpportunitySingularController {
  constructor(private readonly opportunitiesService: OpportunitiesService) {}

  @UseGuards(JwtAuthGuard)
  @Get('mine')
  mine(@Request() req, @Query('status') status?: string) {
    return this.opportunitiesService.findMineForStudent(req.user.id, {
      status,
    });
  }
}
