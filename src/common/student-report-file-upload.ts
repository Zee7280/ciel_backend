import { BadRequestException } from '@nestjs/common';
import * as path from 'path';

/**
 * Student report / evidence uploads — keep in sync with FE `REPORT_ATTACHMENT_ACCEPT`
 * (`ciel_frontend/src/utils/reportAttachmentAccept.ts`) and HTML file inputs that use it.
 * Phone uploads often use HEIC/WebP; MIME fallback covers missing filename extensions.
 */
export const STUDENT_REPORT_ALLOWED_EXTENSIONS = new Set([
    '.jpg',
    '.jpeg',
    '.png',
    '.webp',
    '.heic',
    '.heif',
    '.pdf',
    '.doc',
    '.docx',
]);

const ALLOWED_MIMETYPES = new Set([
    'image/jpeg',
    'image/jpg',
    'image/pjpeg',
    'image/png',
    'image/webp',
    'image/heic',
    'image/heif',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

function normalizeMime(raw: string | undefined): string {
    return (raw || '').toLowerCase().split(';')[0].trim();
}

/** Multer limits for single- and multi-file report uploads (photos from modern phones exceed 10MB). */
export function studentReportUploadMulterLimits(): { fileSize: number; fieldSize: number } {
    return {
        fileSize: 15 * 1024 * 1024,
        fieldSize: 52 * 1024 * 1024,
    };
}

/** Shared fileFilter for report draft/submit/evidence uploads. */
export function studentReportMulterFileFilter(
    _req: Express.Request,
    file: Express.Multer.File,
    callback: (error: Error | null, acceptFile: boolean) => void,
): void {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const mime = normalizeMime(file.mimetype);

    if (STUDENT_REPORT_ALLOWED_EXTENSIONS.has(ext)) {
        callback(null, true);
        return;
    }

    /* Mobile clients sometimes omit an extension — accept only trusted image/doc MIME types. */
    if (!ext && ALLOWED_MIMETYPES.has(mime)) {
        callback(null, true);
        return;
    }

    const label = ext || mime || '(unknown type)';
    callback(
        new BadRequestException(
            `File type not allowed (${label}). Use photos (JPG, PNG, HEIC, WebP) or PDF/Word.`,
        ),
        false,
    );
}
