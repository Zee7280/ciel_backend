import {
    Controller,
    Get,
    Post,
    Patch,
    Body,
    Param,
    Query,
    Request,
    UseGuards,
    UseInterceptors,
    UploadedFiles,
    UploadedFile,
    BadRequestException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { StudentsService } from './students.service';
import { StudentReportsService } from '../reports/student-reports.service';
import { CreateOpportunityDto } from '../opportunities/dto/create-opportunity.dto';
import { FilesInterceptor, FileInterceptor } from '@nestjs/platform-express';

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

    @Get('projects')
    getStudentProjects(@Request() req) {
        return this.studentsService.getStudentProjects(req.user.id);
    }

    /** Alias for clients that POST (e.g. Next.js proxy); always scoped to JWT user. */
    @Post('projects')
    postStudentProjects(@Request() req) {
        return this.studentsService.getStudentProjects(req.user.id);
    }

    @Get('projects/:id')
    getProjectById(@Request() req, @Param('id') id: string) {
        return this.studentsService.getProjectById(id, req.user.id);
    }

    @Get('opportunity')
    getOpportunity(@Request() req, @Query() query: any) {
        return this.studentsService.getOpportunities(query, req.user.id);
    }

    @Post('opportunity')
    createIndependentProject(@Request() req, @Body() createOpportunityDto: CreateOpportunityDto) {
        return this.studentsService.createStudentOpportunity(req.user.id, createOpportunityDto);
    }

    @Post('opportunity/:id')
    @Patch('opportunity/:id')
    updateIndependentProject(@Request() req, @Param('id') id: string, @Body() updateOpportunityDto: Partial<CreateOpportunityDto>) {
        return this.studentsService.updateStudentOpportunity(req.user.id, id, updateOpportunityDto);
    }

    @Post('verify-team-member/send')
    @Post('verify-identity/send')
    async sendOtp(@Body() body: { email: string }) {
        if (!body.email) {
            throw new BadRequestException('Email is required');
        }
        return this.studentsService.sendTeamMemberOtp(body.email);
    }

    @Post('verify-team-member/confirm')
    @Post('verify-identity/confirm')
    async confirmOtp(@Body() body: { email: string; otp: string }) {
        if (!body.email || !body.otp) {
            throw new BadRequestException('Email and OTP required');
        }
        return this.studentsService.confirmTeamMemberOtp(body.email, body.otp);
    }

    @Post('verify-team-member')
    async verifyTeamMember(@Body() body: { email: string }) {
        if (!body.email) {
            throw new BadRequestException('Email is required');
        }
        return this.studentsService.sendTeamMemberVerification(body.email);
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

    @Post('reports/upload')
    @UseInterceptors(FileInterceptor('file'))
    async uploadFile(@Request() req, @UploadedFile() file: any, @Body('section') section: string) {
        if (!file) {
            throw new BadRequestException('File not provided');
        }
        if (!section) {
            throw new BadRequestException('Section is required (e.g., section8)');
        }
        const url = await this.studentReportsService.uploadFile(file, section, req.user.id);
        return { success: true, data: { url } };
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
