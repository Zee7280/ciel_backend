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

export const STUDENT_REPORT_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const STUDENT_REPORT_MAX_FIELD_BYTES = 55 * 1024 * 1024;

function normalizeMime(raw: string | undefined): string {
    return (raw || '').toLowerCase().split(';')[0].trim();
}

/** Multer limits for single- and multi-file report uploads (photos from modern phones exceed 10MB). */
export function studentReportUploadMulterLimits(): { fileSize: number; fieldSize: number } {
    return {
        fileSize: STUDENT_REPORT_MAX_FILE_BYTES,
        fieldSize: STUDENT_REPORT_MAX_FIELD_BYTES,
    };
}

function isAllowedStudentReportFile(filename: string | undefined, contentType: string | undefined): boolean {
    const ext = path.extname(filename || '').toLowerCase();
    const mime = normalizeMime(contentType);

    if (STUDENT_REPORT_ALLOWED_EXTENSIONS.has(ext)) {
        return true;
    }

    /* Mobile clients sometimes omit an extension — accept only trusted image/doc MIME types. */
    return !ext && ALLOWED_MIMETYPES.has(mime);
}

export function assertStudentReportUploadMeta(meta: {
    filename?: string;
    contentType?: string;
    size?: number | string;
}): { filename: string; contentType: string; size?: number } {
    const filename = String(meta?.filename || '').trim();
    const contentType = normalizeMime(meta?.contentType);
    const size = meta?.size === undefined ? undefined : Number(meta.size);

    if (!filename) {
        throw new BadRequestException('filename is required');
    }

    if (size !== undefined && (!Number.isFinite(size) || size < 0)) {
        throw new BadRequestException('size must be a valid number');
    }

    if (size !== undefined && size > STUDENT_REPORT_MAX_FILE_BYTES) {
        throw new BadRequestException('File too large. Maximum report upload size is 50MB.');
    }

    if (!isAllowedStudentReportFile(filename, contentType)) {
        const label = path.extname(filename).toLowerCase() || contentType || '(unknown type)';
        throw new BadRequestException(
            `File type not allowed (${label}). Use photos (JPG, PNG, HEIC, WebP) or PDF/Word.`,
        );
    }

    return {
        filename,
        contentType: contentType || 'application/octet-stream',
        size,
    };
}

/** Shared fileFilter for report draft/submit/evidence uploads. */
export function studentReportMulterFileFilter(
    _req: Express.Request,
    file: Express.Multer.File,
    callback: (error: Error | null, acceptFile: boolean) => void,
): void {
    if (isAllowedStudentReportFile(file.originalname, file.mimetype)) {
        callback(null, true);
        return;
    }

    const ext = path.extname(file.originalname || '').toLowerCase();
    const mime = normalizeMime(file.mimetype);
    const label = ext || mime || '(unknown type)';
    callback(
        new BadRequestException(
            `File type not allowed (${label}). Use photos (JPG, PNG, HEIC, WebP) or PDF/Word.`,
        ),
        false,
    );
}
