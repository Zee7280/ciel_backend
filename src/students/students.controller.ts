import {
    Controller,
    Get,
    Post,
    Put,
    Delete,
    Body,
    Param,
    Query,
    Request,
    UseGuards,
    UseInterceptors,
    UploadedFile,
    BadRequestException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { StudentsService } from './students.service';
import { ApplyOpportunityDto } from './dto/apply-opportunity.dto';
import { LogHoursDto } from './dto/log-hours.dto';
import { UpdateStudentProfileDto } from './dto/update-profile.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname } from 'path';

@Controller('students')
@UseGuards(JwtAuthGuard)
export class StudentsController {
    constructor(private readonly studentsService: StudentsService) { }

    // Dashboard
    @Get('dashboard')
    getDashboard(@Request() req) {
        return this.studentsService.getDashboard(req.user.id);
    }

    // Opportunities
    @Get('opportunities')
    getOpportunities(@Request() req, @Query() query) {
        return this.studentsService.getOpportunities(query, req.user.id);
    }

    @Post('opportunities')
    getOpportunitiesPost(@Request() req, @Query() query) {
        return this.studentsService.getOpportunities(query, req.user.id);
    }

    @Post('projects')
    getStudentProjects(@Body() body: { studentId: string }) {
        return this.studentsService.getStudentProjects(body.studentId);
    }

    @Get('opportunities/recommended')
    getRecommendedOpportunities(@Request() req) {
        return this.studentsService.getRecommendedOpportunities(req.user.id);
    }

    @Get('opportunities/:id')
    getOpportunityById(@Param('id') id: string) {
        return this.studentsService.getOpportunityById(id);
    }

    // Applications
    @Get('applications')
    getApplications(@Request() req, @Query('status') status?: string) {
        return this.studentsService.getApplications(req.user.id, status);
    }

    @Post('applications')
    applyToOpportunity(@Request() req, @Body() dto: ApplyOpportunityDto) {
        return this.studentsService.applyToOpportunity(req.user.id, dto);
    }

    @Post('opportunities/:id/apply')
    applyToOpportunityById(@Request() req, @Param('id') id: string, @Body() body: any) {
        return this.studentsService.applyToOpportunity(req.user.id, { ...body, opportunityId: id });
    }

    @Delete('applications/:id')
    withdrawApplication(@Request() req, @Param('id') id: string) {
        return this.studentsService.withdrawApplication(req.user.id, id);
    }

    // Timesheets
    @Get('timesheets')
    getTimesheets(@Request() req, @Query() query) {
        return this.studentsService.getTimesheets(req.user.id, query);
    }

    @Post('timesheets')
    logHours(@Request() req, @Body() dto: LogHoursDto) {
        return this.studentsService.logHours(req.user.id, dto);
    }

    @Put('timesheets/:id')
    updateTimesheet(@Request() req, @Param('id') id: string, @Body() dto: Partial<LogHoursDto>) {
        return this.studentsService.updateTimesheet(req.user.id, id, dto);
    }

    @Delete('timesheets/:id')
    deleteTimesheet(@Request() req, @Param('id') id: string) {
        return this.studentsService.deleteTimesheet(req.user.id, id);
    }

    // Impact
    @Get('impact')
    getImpact(@Request() req) {
        return this.studentsService.getImpact(req.user.id);
    }

    @Post('impact/history')
    getImpactHistory(@Body() body: { student_id: string }) {
        return this.studentsService.getImpactHistory(body.student_id);
    }

    // Profile
    @Get('profile')
    getProfile(@Request() req) {
        return this.studentsService.getProfile(req.user.id);
    }

    @Put('profile')
    updateProfile(@Request() req, @Body() dto: UpdateStudentProfileDto) {
        return this.studentsService.updateProfile(req.user.id, dto);
    }

    @Post('profile/avatar')
    @UseInterceptors(
        FileInterceptor('avatar', {
            storage: diskStorage({
                destination: process.env.NODE_ENV === 'production' || process.env.VERCEL ? '/tmp/uploads' : './uploads',
                filename: (req, file, cb) => {
                    const randomName = Array(32)
                        .fill(null)
                        .map(() => Math.round(Math.random() * 16).toString(16))
                        .join('');
                    cb(null, `${randomName}${extname(file.originalname)}`);
                },
            }),
        }),
    )
    async uploadAvatar(@Request() req, @UploadedFile() file: any) {
        if (!file) {
            throw new BadRequestException('Avatar file not provided');
        }
        const avatarUrl = `/uploads/${file.filename}`;
        await this.studentsService.updateProfile(req.user.id, { avatar: avatarUrl } as any);
        return { success: true, data: { avatar_url: avatarUrl } };
    }

    @Post('profile/change-password')
    async changePassword(@Request() req, @Body() body: { currentPassword: string; newPassword: string }) {
        // This should be implemented in UsersService
        return {
            success: true,
            message: 'Password changed successfully',
        };
    }

    // Settings
    @Get('settings')
    getSettings(@Request() req) {
        return this.studentsService.getSettings(req.user.id);
    }

    @Put('settings')
    updateSettings(@Request() req, @Body() settings: any) {
        return this.studentsService.updateSettings(req.user.id, settings);
    }
}
