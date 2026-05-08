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
import { S3Service } from '../common/s3.service';

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
    constructor(
        private readonly tutorialsService: TutorialsService,
        private readonly s3Service: S3Service,
    ) {}

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

    @Post('presign')
    async presign(@Body() body: any) {
        const video = body?.video;
        const document = body?.document;
        const poster = body?.poster;

        const res: Record<string, unknown> = {};

        const v = this.assertUploadMeta(video, 'video');
        res.video = await this.s3Service.presignPutObject({
            folder: 'platform-tutorials/videos',
            originalName: v.filename,
            contentType: v.contentType,
        });

        if (document) {
            const d = this.assertUploadMeta(document, 'document');
            res.document = {
                ...(await this.s3Service.presignPutObject({
                    folder: 'platform-tutorials/documents',
                    originalName: d.filename,
                    contentType: d.contentType,
                })),
                filename: d.filename,
            };
        }

        if (poster) {
            const p = this.assertUploadMeta(poster, 'poster');
            res.poster = await this.s3Service.presignPutObject({
                folder: 'platform-tutorials/posters',
                originalName: p.filename,
                contentType: p.contentType,
            });
        }

        return { success: true, data: res };
    }

    @Post('direct')
    async createDirect(
        @Body('title') title?: string,
        @Body('description') description?: string,
        @Body('category') category?: string,
        @Body('durationLabel') durationLabel?: string,
        @Body('sortOrder') sortOrderRaw?: string,
        @Body('videoUrl') videoUrl?: string,
        @Body('documentUrl') documentUrl?: string,
        @Body('documentFilename') documentFilename?: string,
        @Body('posterUrl') posterUrl?: string,
    ) {
        const t = (title || '').trim();
        if (t.length < 2) {
            throw new BadRequestException('Title is required');
        }
        const vUrl = String(videoUrl || '').trim();
        if (!vUrl) {
            throw new BadRequestException('videoUrl is required');
        }

        const sortOrder = Math.max(
            0,
            parseInt(String(sortOrderRaw ?? '0'), 10) || 0,
        );

        return this.tutorialsService.createFromDirectUrls({
            title: t,
            description: description || '',
            category: category || 'General',
            durationLabel,
            sortOrder,
            videoUrl: vUrl,
            documentUrl: documentUrl ? String(documentUrl) : null,
            documentFilename: documentFilename ? String(documentFilename) : null,
            posterUrl: posterUrl ? String(posterUrl) : null,
        });
    }

    @Delete(':id')
    @HttpCode(HttpStatus.OK)
    remove(@Param('id') id: string) {
        return this.tutorialsService.remove(id);
    }

    private assertUploadMeta(
        meta: any,
        kind: 'video' | 'document' | 'poster',
    ): { filename: string; contentType: string; sizeBytes: number } {
        const filename = String(meta?.filename ?? '').trim();
        const contentType = String(meta?.contentType ?? '').trim();
        const sizeBytes = Number(meta?.sizeBytes ?? 0);
        if (!filename || !contentType || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
            throw new BadRequestException(`${kind} metadata is required`);
        }
        if (sizeBytes > PLATFORM_TUTORIAL_MAX_FILE_BYTES) {
            throw new BadRequestException(
                `${kind} exceeds max size (${Math.floor(
                    PLATFORM_TUTORIAL_MAX_FILE_BYTES / (1024 * 1024),
                )} MB)`,
            );
        }
        const ext = filename.toLowerCase().split('.').pop() || '';
        if (kind === 'video') {
            const allowed = new Set(['mp4', 'webm', 'mov']);
            if (!allowed.has(ext)) {
                throw new BadRequestException(
                    'Video must be .mp4, .webm, or .mov',
                );
            }
        } else if (kind === 'document') {
            const allowed = new Set(['pdf', 'doc', 'docx']);
            if (!allowed.has(ext)) {
                throw new BadRequestException(
                    'Document must be .pdf, .doc, or .docx',
                );
            }
        } else {
            const allowed = new Set(['jpg', 'jpeg', 'png', 'webp']);
            if (!allowed.has(ext)) {
                throw new BadRequestException(
                    'Poster must be .jpg, .png, or .webp',
                );
            }
        }
        return { filename, contentType, sizeBytes };
    }
}
