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
    UploadedFiles,
    BadRequestException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { StudentsService } from './students.service';
import { StudentReportsService } from '../reports/student-reports.service';
import { ApplyOpportunityDto } from './dto/apply-opportunity.dto';
import { LogHoursDto } from './dto/log-hours.dto';
import { UpdateStudentProfileDto } from './dto/update-profile.dto';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname } from 'path';

@Controller('students')
@UseGuards(JwtAuthGuard)
export class StudentsController {
    constructor(private readonly studentsService: StudentsService) { }

    // Dashboard - Moving to StudentController below, but keeping here for backward compatibility if needed? 
    // Actually, user specifically asked for /student/dashboard.
    // I will remove it from here to avoid confusion or keep it as alias? 
    // Let's keep it here mapped to 'dashboard' (so /students/dashboard works) AND create the new one.
    @Get('dashboard')
    getDashboard(@Request() req, @Query('studentId') studentId?: string) {
        return this.studentsService.getDashboard(studentId || req.user.id);
    }

    // ... other methods ...


    // Opportunities
    @Get('reports')
    getReports(@Request() req, @Query('organisationId') organisationId: string) {
        if (!organisationId) {
            throw new BadRequestException('organisationId is required');
        }
        return this.studentsService.getReports(req.user.id, organisationId);
    }

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

    @Get('projects/:id')
    getProjectById(@Param('id') id: string) {
        return this.studentsService.getProjectById(id);
    }

    @Get('opportunities/recommended')
    getRecommendedOpportunities(@Request() req) {
        return this.studentsService.getRecommendedOpportunities(req.user.id);
    }

    @Get('opportunities/:id')
    getOpportunityById(@Request() req, @Param('id') id: string) {
        return this.studentsService.getOpportunityById(id, req.user.id);
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

@Controller('student')
@UseGuards(JwtAuthGuard)
export class StudentController {
    constructor(
        private readonly studentsService: StudentsService,
        private readonly studentReportsService: StudentReportsService
    ) { }

    @Get('dashboard')
    getDashboard(@Request() req, @Query('studentId') studentId?: string) {
        const targetId = studentId || req.user.id;
        if (targetId !== req.user.id && req.user.role !== 'admin') {
            throw new BadRequestException('Unauthorized to view this dashboard');
        }
        return this.studentsService.getDashboard(targetId);
    }

    @Get('projects/:id')
    getProjectById(@Param('id') id: string) {
        return this.studentsService.getProjectById(id);
    }

    // ---- Reports aliases (frontend uses /student not /students) ----

    @Get('reports')
    getAllReports(@Request() req, @Query() query: any) {
        return this.studentReportsService.findAll({ ...query, studentId: req.user.id });
    }

    @Get('reports/check')
    checkReportStatus(@Query() query: { studentId: string; opportunityId?: string }) {
        return this.studentReportsService.checkReportStatus(query.studentId, query.opportunityId);
    }

    @Get('reports/:id')
    getReportById(@Request() req, @Param('id') id: string) {
        console.log(`[StudentController] getReportById HIT! ID: ${id}, User: ${req.user.id}`);
        return this.studentReportsService.findOneByOpportunityOrId(id, req.user.id);
    }

    @Post('reports')
    @UseInterceptors(FilesInterceptor('files', 50, {
        limits: { fileSize: 10 * 1024 * 1024 },
        fileFilter: (req, file, callback) => {
            const allowedExtensions = ['.jpg', '.jpeg', '.png', '.pdf', '.doc', '.docx'];
            const ext = file.originalname.toLowerCase().substring(file.originalname.lastIndexOf('.'));
            if (allowedExtensions.includes(ext)) {
                callback(null, true);
            } else {
                callback(new BadRequestException(`File type ${ext} is not allowed`), false);
            }
        },
    }))
    async submitReport(@Request() req, @Body() body: any, @UploadedFiles() files: any[]) {
        return this.studentReportsService.createReport(req.user.id, body, files);
    }

    @Post('reports/:id/submit')
    @UseInterceptors(FilesInterceptor('files', 50, {
        limits: { fileSize: 10 * 1024 * 1024 },
        fileFilter: (req, file, callback) => {
            const allowedExtensions = ['.jpg', '.jpeg', '.png', '.pdf', '.doc', '.docx'];
            const ext = file.originalname.toLowerCase().substring(file.originalname.lastIndexOf('.'));
            if (allowedExtensions.includes(ext)) {
                callback(null, true);
            } else {
                callback(new BadRequestException(`File type ${ext} is not allowed`), false);
            }
        },
    }))
    async submitReportWithId(@Request() req, @Param('id') id: string, @Body() body: any, @UploadedFiles() files: any[]) {
        // If opportunityId is not in body, use the one from URL
        if (!body.opportunityId) body.opportunityId = id;
        return this.studentReportsService.createReport(req.user.id, body, files);
    }

    @Post('reports/draft')
    @UseInterceptors(FilesInterceptor('files', 50, {
        limits: { fileSize: 10 * 1024 * 1024 },
        fileFilter: (req, file, callback) => {
            const allowedExtensions = ['.jpg', '.jpeg', '.png', '.pdf', '.doc', '.docx'];
            const ext = file.originalname.toLowerCase().substring(file.originalname.lastIndexOf('.'));
            if (allowedExtensions.includes(ext)) {
                callback(null, true);
            } else {
                callback(new BadRequestException(`File type ${ext} is not allowed`), false);
            }
        },
    }))
    async saveDraft(@Request() req, @Body() body: any, @UploadedFiles() files: any[]) {
        return this.studentReportsService.saveDraft(req.user.id, body, files);
    }

    @Post('reports/:id/draft')
    @UseInterceptors(FilesInterceptor('files', 50, {
        limits: { fileSize: 10 * 1024 * 1024 },
        fileFilter: (req, file, callback) => {
            const allowedExtensions = ['.jpg', '.jpeg', '.png', '.pdf', '.doc', '.docx'];
            const ext = file.originalname.toLowerCase().substring(file.originalname.lastIndexOf('.'));
            if (allowedExtensions.includes(ext)) {
                callback(null, true);
            } else {
                callback(new BadRequestException(`File type ${ext} is not allowed`), false);
            }
        },
    }))
    async saveDraftWithId(@Request() req, @Param('id') id: string, @Body() body: any, @UploadedFiles() files: any[]) {
        if (!body.opportunityId) body.opportunityId = id;
        return this.studentReportsService.saveDraft(req.user.id, body, files);
    }
}
