import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    Post,
    UploadedFiles,
    UseGuards,
    UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { AdminMutationAuditInterceptor } from '../audit-logs/admin-mutation-audit.interceptor';
import {
    PLATFORM_TUTORIAL_MAX_FILE_BYTES,
    TutorialsService,
} from './tutorials.service';

const tutorialUpload = FileFieldsInterceptor(
    [
        { name: 'video', maxCount: 1 },
        { name: 'document', maxCount: 1 },
        { name: 'poster', maxCount: 1 },
    ],
    {
        limits: { fileSize: PLATFORM_TUTORIAL_MAX_FILE_BYTES },
    },
);

@Controller('admin/tutorials')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
@UseInterceptors(AdminMutationAuditInterceptor)
export class AdminTutorialsController {
    constructor(private readonly tutorialsService: TutorialsService) {}

    @Get()
    list() {
        return this.tutorialsService.listForAdmin();
    }

    @Post()
    @UseInterceptors(tutorialUpload)
    async create(
        @UploadedFiles()
        files: {
            video?: Express.Multer.File[];
            document?: Express.Multer.File[];
            poster?: Express.Multer.File[];
        },
        @Body('title') title?: string,
        @Body('description') description?: string,
        @Body('category') category?: string,
        @Body('durationLabel') durationLabel?: string,
        @Body('sortOrder') sortOrderRaw?: string,
    ) {
        const t = (title || '').trim();
        if (t.length < 2) {
            throw new BadRequestException('Title is required');
        }
        const video = files?.video?.[0];
        TutorialsService.assertVideoFile(video);
        const document = files?.document?.[0];
        TutorialsService.assertDocFile(document);
        const poster = files?.poster?.[0];
        TutorialsService.assertPosterFile(poster);

        const sortOrder = Math.max(
            0,
            parseInt(String(sortOrderRaw ?? '0'), 10) || 0,
        );

        return this.tutorialsService.createFromUploads({
            title: t,
            description: description || '',
            category: category || 'General',
            durationLabel,
            sortOrder,
            video: video!,
            document,
            poster,
        });
    }

    @Delete(':id')
    @HttpCode(HttpStatus.OK)
    remove(@Param('id') id: string) {
        return this.tutorialsService.remove(id);
    }
}
