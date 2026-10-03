import { BadRequestException } from '@nestjs/common';
import { imageUploadOptions, proofUploadOptions, safeFileExtension, UNSAFE_UPLOAD_MIME } from './safe-upload';

const run = (opts: any, file: any) =>
  new Promise<{ err: Error | null; ok: boolean }>((resolve) =>
    opts.fileFilter({}, file, (err: Error | null, ok: boolean) => resolve({ err, ok })),
  );

describe('safe upload filters', () => {
  it('avatar / logo accepts real images only', async () => {
    expect((await run(imageUploadOptions, { mimetype: 'image/png', originalname: 'a.png' })).ok).toBe(true);
    expect((await run(imageUploadOptions, { mimetype: 'image/jpeg', originalname: 'a.JPG' })).ok).toBe(true);
    for (const f of [
      { mimetype: 'text/html', originalname: 'x.html' },
      { mimetype: 'image/svg+xml', originalname: 'x.svg' },
      { mimetype: 'image/png', originalname: 'x.html' }, // lying mimetype, html extension
      { mimetype: 'application/pdf', originalname: 'x.pdf' },
    ]) {
      const r = await run(imageUploadOptions, f);
      expect(r.ok).toBe(false);
      expect(r.err).toBeInstanceOf(BadRequestException);
    }
  });

  it('proof accepts images and PDFs, nothing else', async () => {
    expect((await run(proofUploadOptions, { mimetype: 'application/pdf', originalname: 'slip.pdf' })).ok).toBe(true);
    expect((await run(proofUploadOptions, { mimetype: 'image/webp', originalname: 'slip.webp' })).ok).toBe(true);
    expect((await run(proofUploadOptions, { mimetype: 'text/html', originalname: 'slip.html' })).ok).toBe(false);
    expect((await run(proofUploadOptions, { mimetype: 'application/pdf', originalname: 'slip.exe' })).ok).toBe(false);
  });

  it('declares hard size limits', () => {
    expect(imageUploadOptions.limits.fileSize).toBe(5 * 1024 * 1024);
    expect(proofUploadOptions.limits.fileSize).toBe(10 * 1024 * 1024);
  });

  it('extension helper only returns a safe token', () => {
    expect(safeFileExtension('a.PNG')).toBe('.png');
    expect(safeFileExtension('a.tar.gz')).toBe('.gz');
    expect(safeFileExtension('weird.<script>')).toBe('');
    expect(safeFileExtension('noext')).toBe('');
    expect(safeFileExtension(undefined)).toBe('');
  });

  it('flags script-capable MIME types', () => {
    for (const m of ['text/html', 'text/html; charset=utf-8', 'image/svg+xml', 'application/xhtml+xml', 'application/javascript']) {
      expect(UNSAFE_UPLOAD_MIME.test(m)).toBe(true);
    }
    for (const m of ['image/png', 'application/pdf', 'video/mp4']) expect(UNSAFE_UPLOAD_MIME.test(m)).toBe(false);
  });
});
