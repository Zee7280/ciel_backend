import { BadRequestException } from '@nestjs/common';
import * as path from 'path';

/** Types that can run script when opened from a public URL (stored XSS on the bucket origin). */
export const UNSAFE_UPLOAD_MIME =
  /^(text\/html|image\/svg\+xml|application\/xhtml\+xml|text\/xml|application\/xml|text\/javascript|application\/javascript|application\/x-javascript)\b/i;

export const AVATAR_LOGO_MAX_BYTES = 5 * 1024 * 1024;
export const PROOF_MAX_BYTES = 10 * 1024 * 1024;

const IMAGE_MIME = /^image\/(jpeg|jpg|png|webp|gif|heic|heif)$/i;
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif']);
const PROOF_EXT = new Set([...IMAGE_EXT, '.pdf']);

type FilterCb = (error: Error | null, accept: boolean) => void;
type FileLike = { mimetype?: string; originalname?: string };

function ext(file: FileLike): string {
  return path.extname(String(file.originalname || '')).toLowerCase();
}

/** Avatar / logo: real raster images only (no SVG / HTML), 5 MB. */
export const imageUploadOptions = {
  limits: { fileSize: AVATAR_LOGO_MAX_BYTES, files: 2 },
  fileFilter: (_req: unknown, file: FileLike, cb: FilterCb) => {
    if (IMAGE_MIME.test(String(file.mimetype || '')) && IMAGE_EXT.has(ext(file))) {
      return cb(null, true);
    }
    cb(new BadRequestException('Upload a JPG, PNG, WebP or GIF image (max 5 MB).'), false);
  },
};

/** Payment / membership proof: an image or a PDF, 10 MB. */
export const proofUploadOptions = {
  limits: { fileSize: PROOF_MAX_BYTES, files: 1 },
  fileFilter: (_req: unknown, file: FileLike, cb: FilterCb) => {
    const mime = String(file.mimetype || '');
    const ok =
      (IMAGE_MIME.test(mime) || /^application\/pdf$/i.test(mime)) &&
      PROOF_EXT.has(ext(file));
    if (ok) return cb(null, true);
    cb(new BadRequestException('Upload an image or a PDF (max 10 MB).'), false);
  },
};

/** Extension taken from the client filename, reduced to a safe token (no dots, slashes, spaces). */
export function safeFileExtension(originalName: string | undefined): string {
  const raw = path.extname(String(originalName || '')).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(raw) ? raw : '';
}
