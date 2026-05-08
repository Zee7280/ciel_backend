import {
    BadRequestException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PlatformTutorial } from './entities/platform-tutorial.entity';
import { S3Service } from '../common/s3.service';

const TUTORIAL_FOLDER = 'platform-tutorials/videos';
const TUTORIAL_DOCS_FOLDER = 'platform-tutorials/documents';
const TUTORIAL_POSTERS_FOLDER = 'platform-tutorials/posters';

/** Multer / product cap: each tutorial file (video, document, poster) may be at most this size. */
export const PLATFORM_TUTORIAL_MAX_FILE_BYTES = 500 * 1024 * 1024;

@Injectable()
export class TutorialsService {
    constructor(
        @InjectRepository(PlatformTutorial)
        private readonly repo: Repository<PlatformTutorial>,
        private readonly s3Service: S3Service,
    ) {}

    async listForStudents() {
        const rows = await this.repo.find({
            order: { sortOrder: 'ASC', createdAt: 'DESC' },
        });
        return { success: true, data: rows.map((r) => this.toPublicDto(r)) };
    }

    async listForAdmin() {
        const rows = await this.repo.find({
            order: { sortOrder: 'ASC', createdAt: 'DESC' },
        });
        return { success: true, data: rows };
    }

    async createFromUploads(opts: {
        title: string;
        description: string;
        category: string;
        durationLabel?: string;
        sortOrder: number;
        video: Express.Multer.File;
        document?: Express.Multer.File;
        poster?: Express.Multer.File;
    }) {
        const videoUrl = await this.s3Service.uploadFile(
            opts.video,
            TUTORIAL_FOLDER,
        );
        let documentUrl: string | null = null;
        let documentFilename: string | null = null;
        if (opts.document) {
            documentUrl = await this.s3Service.uploadFile(
                opts.document,
                TUTORIAL_DOCS_FOLDER,
            );
            documentFilename = opts.document.originalname;
        }
        let posterUrl: string | null = null;
        if (opts.poster) {
            posterUrl = await this.s3Service.uploadFile(
                opts.poster,
                TUTORIAL_POSTERS_FOLDER,
            );
        }
        const row = this.repo.create({
            title: opts.title.trim(),
            description: (opts.description || '').trim(),
            category: (opts.category || 'General').trim() || 'General',
            videoUrl,
            posterUrl,
            durationLabel: opts.durationLabel?.trim() || null,
            documentUrl,
            documentFilename,
            sortOrder: opts.sortOrder,
        });
        const saved = await this.repo.save(row);
        return { success: true, data: saved };
    }

    async createFromDirectUrls(opts: {
        title: string;
        description: string;
        category: string;
        durationLabel?: string;
        sortOrder: number;
        videoUrl: string;
        documentUrl?: string | null;
        documentFilename?: string | null;
        posterUrl?: string | null;
    }) {
        const row = this.repo.create({
            title: opts.title.trim(),
            description: (opts.description || '').trim(),
            category: (opts.category || 'General').trim() || 'General',
            videoUrl: opts.videoUrl,
            posterUrl: opts.posterUrl ?? null,
            durationLabel: opts.durationLabel?.trim() || null,
            documentUrl: opts.documentUrl ?? null,
            documentFilename: opts.documentFilename ?? null,
            sortOrder: opts.sortOrder,
        });
        const saved = await this.repo.save(row);
        return { success: true, data: saved };
    }

    async remove(id: string) {
        const row = await this.repo.findOne({ where: { id } });
        if (!row) {
            throw new NotFoundException('Tutorial not found');
        }
        await this.s3Service.deleteByPublicUrl(row.videoUrl);
        await this.s3Service.deleteByPublicUrl(row.posterUrl);
        await this.s3Service.deleteByPublicUrl(row.documentUrl);
        await this.repo.remove(row);
        return { success: true };
    }

    private toPublicDto(r: PlatformTutorial) {
        return {
            id: r.id,
            title: r.title,
            description: r.description,
            category: r.category,
            videoUrl: r.videoUrl,
            poster: r.posterUrl ?? undefined,
            duration: r.durationLabel ?? undefined,
            documentUrl: r.documentUrl ?? undefined,
            documentFilename: r.documentFilename ?? undefined,
            sortOrder: r.sortOrder,
        };
    }

    static assertVideoFile(file: Express.Multer.File | undefined) {
        if (!file?.buffer?.length) {
            throw new BadRequestException('Video file is required');
        }
        const ext = file.originalname.toLowerCase().split('.').pop();
        const allowed = new Set(['mp4', 'webm', 'mov']);
        if (!ext || !allowed.has(ext)) {
            throw new BadRequestException(
                'Video must be .mp4, .webm, or .mov',
            );
        }
    }

    static assertDocFile(file: Express.Multer.File | undefined) {
        if (!file?.buffer?.length) return;
        const ext = file.originalname.toLowerCase().split('.').pop();
        const allowed = new Set(['pdf', 'doc', 'docx']);
        if (!ext || !allowed.has(ext)) {
            throw new BadRequestException(
                'Document must be .pdf, .doc, or .docx',
            );
        }
    }

    static assertPosterFile(file: Express.Multer.File | undefined) {
        if (!file?.buffer?.length) return;
        const ext = file.originalname.toLowerCase().split('.').pop();
        const allowed = new Set(['jpg', 'jpeg', 'png', 'webp']);
        if (!ext || !allowed.has(ext)) {
            throw new BadRequestException(
                'Poster must be .jpg, .png, or .webp',
            );
        }
    }
}
