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
            where: { published: true },
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
        const videoUrl = this.assertTutorialUrl(opts.videoUrl, 'videoUrl');
        if (!videoUrl) throw new BadRequestException('videoUrl is required');
        const row = this.repo.create({
            title: opts.title.trim(),
            description: (opts.description || '').trim(),
            category: (opts.category || 'General').trim() || 'General',
            videoUrl,
            posterUrl: this.assertTutorialUrl(opts.posterUrl, 'posterUrl'),
            durationLabel: opts.durationLabel?.trim() || null,
            documentUrl: this.assertTutorialUrl(opts.documentUrl, 'documentUrl'),
            documentFilename: opts.documentFilename ?? null,
            sortOrder: opts.sortOrder,
        });
        const saved = await this.repo.save(row);
        return { success: true, data: saved };
    }

    /** https only, and must live in the configured storage bucket's tutorials folder. */
    assertTutorialUrl(url: string | null | undefined, label: string): string | null {
        if (url === null || url === undefined) return null;
        const raw = String(url).trim();
        if (!raw) return null;
        let parsed: URL;
        try {
            parsed = new URL(raw);
        } catch {
            throw new BadRequestException(`${label} must be a valid URL`);
        }
        if (parsed.protocol !== 'https:') {
            throw new BadRequestException(`${label} must be an https URL`);
        }
        const key = this.s3Service.keyFromPublicUrl(raw);
        if (!key || !key.startsWith('platform-tutorials/')) {
            throw new BadRequestException(
                `${label} must point to the platform storage (platform-tutorials folder)`,
            );
        }
        return raw;
    }

    async update(
        id: string,
        dto: {
            title?: string;
            description?: string;
            category?: string;
            durationLabel?: string | null;
            sortOrder?: number | string;
            published?: boolean | string;
            videoUrl?: string;
            posterUrl?: string | null;
            documentUrl?: string | null;
            documentFilename?: string | null;
        },
    ) {
        const row = await this.repo.findOne({ where: { id } });
        if (!row) {
            throw new NotFoundException('Tutorial not found');
        }
        if (dto.title !== undefined) {
            const t = String(dto.title).trim();
            if (t.length < 2) throw new BadRequestException('Title is required');
            row.title = t.slice(0, 255);
        }
        if (dto.description !== undefined) row.description = String(dto.description).trim();
        if (dto.category !== undefined) {
            row.category = String(dto.category).trim().slice(0, 120) || 'General';
        }
        if (dto.durationLabel !== undefined) {
            row.durationLabel = dto.durationLabel ? String(dto.durationLabel).trim().slice(0, 32) : null;
        }
        if (dto.sortOrder !== undefined) {
            row.sortOrder = Math.max(0, this.normalizeSortOrder(dto.sortOrder));
        }
        if (dto.published !== undefined) {
            row.published = dto.published === true || String(dto.published).toLowerCase() === 'true';
        }
        if (dto.videoUrl !== undefined) {
            const v = this.assertTutorialUrl(dto.videoUrl, 'videoUrl');
            if (!v) throw new BadRequestException('videoUrl cannot be empty');
            row.videoUrl = v;
        }
        if (dto.posterUrl !== undefined) row.posterUrl = this.assertTutorialUrl(dto.posterUrl, 'posterUrl');
        if (dto.documentUrl !== undefined) {
            row.documentUrl = this.assertTutorialUrl(dto.documentUrl, 'documentUrl');
            if (!row.documentUrl) row.documentFilename = null;
        }
        if (dto.documentFilename !== undefined && row.documentUrl) {
            row.documentFilename = dto.documentFilename ? String(dto.documentFilename).slice(0, 512) : null;
        }
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
        const sortOrder = this.normalizeSortOrder((r as { sortOrder?: unknown }).sortOrder);
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
            sortOrder,
        };
    }

    private normalizeSortOrder(value: unknown): number {
        if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
        const n = parseInt(String(value ?? '').trim(), 10);
        return Number.isFinite(n) ? n : 0;
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
