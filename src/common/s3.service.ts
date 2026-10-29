import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { UNSAFE_UPLOAD_MIME, safeFileExtension } from './safe-upload';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as crypto from 'crypto';
import * as path from 'path';

@Injectable()
export class S3Service {
  private readonly s3Client: S3Client;
  private readonly bucket: string;
  private readonly region: string;

  constructor(private readonly configService: ConfigService) {
    this.region = this.configService.get<string>('AWS_REGION')!;
    this.bucket = this.configService.get<string>('AWS_S3_BUCKET')!;

    this.s3Client = new S3Client({
      region: this.region,
      credentials: {
        accessKeyId: this.configService.get<string>('AWS_ACCESS_KEY_ID')!,
        secretAccessKey: this.configService.get<string>(
          'AWS_SECRET_ACCESS_KEY',
        )!,
      },
    });
  }

  /**
   * Returns a presigned PUT URL and corresponding public URL for the configured bucket.
   * `Content-Type` is part of the signature, so the PUT must send exactly the presigned type — an
   * unsigned header would let a "file.pdf" presign be uploaded as text/html. When the declared
   * size is given, `Content-Length` is signed too, so the upload cannot exceed it.
   */
  async presignPutObject(opts: {
    folder: string;
    originalName: string;
    contentType: string;
    expiresInSeconds?: number;
    contentLength?: number;
  }): Promise<{ uploadUrl: string; publicUrl: string; key: string }> {
    const fileExt = path.extname(opts.originalName || '').slice(0, 12);
    const key = `${opts.folder}/${crypto.randomUUID()}${fileExt}`;
    const contentLength =
      Number.isInteger(opts.contentLength) && (opts.contentLength ?? 0) > 0
        ? opts.contentLength
        : undefined;
    try {
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: opts.contentType,
        ...(contentLength ? { ContentLength: contentLength } : {}),
      });
      const uploadUrl = await getSignedUrl(this.s3Client, command, {
        expiresIn: opts.expiresInSeconds ?? 15 * 60,
        signableHeaders: new Set(['content-type']),
      });
      const publicUrl = `https://${this.bucket}.s3.${this.region}.amazonaws.com/${key}`;
      return { uploadUrl, publicUrl, key };
    } catch (error) {
      console.error('S3 Presign Error:', error);
      throw new InternalServerErrorException('Failed to create S3 upload URL');
    }
  }

  async uploadFile(file: Express.Multer.File, folder: string): Promise<string> {
    // Public bucket: never store something a browser would execute when the URL is opened.
    if (UNSAFE_UPLOAD_MIME.test(String(file.mimetype || ''))) {
      throw new BadRequestException('This file type is not allowed.');
    }
    const fileExt = safeFileExtension(file.originalname);
    const fileName = `${folder}/${crypto.randomUUID()}${fileExt}`;
    const inline = /^(image\/|application\/pdf$|video\/|audio\/)/i.test(
      String(file.mimetype || ''),
    );

    try {
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: fileName,
        Body: file.buffer,
        ContentType: file.mimetype,
        // Anything that is not media / PDF downloads instead of rendering in the browser.
        ContentDisposition: inline ? 'inline' : 'attachment',
      });

      await this.s3Client.send(command);

      // Return the public URL
      return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${fileName}`;
    } catch (error) {
      console.error('S3 Upload Error:', error);
      throw new InternalServerErrorException('Failed to upload file to S3');
    }
  }

  async uploadBuffer(
    buffer: Buffer,
    fileName: string,
    contentType: string,
  ): Promise<string> {
    try {
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: fileName,
        Body: buffer,
        ContentType: contentType,
      });

      await this.s3Client.send(command);
      return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${fileName}`;
    } catch (error) {
      console.error('S3 Buffer Upload Error:', error);
      throw new InternalServerErrorException('Failed to upload buffer to S3');
    }
  }

  /**
   * Short-lived signed GET link to one object. It works whether or not the bucket allows public
   * reads, so files can be kept private and shown only to people the API authorises.
   */
  async presignGetObject(
    key: string,
    expiresInSeconds = 60 * 60,
  ): Promise<string> {
    return getSignedUrl(
      this.s3Client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: expiresInSeconds },
    );
  }

  keyFromPublicUrl(url: string | null | undefined): string | null {
    if (!url || typeof url !== 'string') return null;
    const prefix = `https://${this.bucket}.s3.${this.region}.amazonaws.com/`;
    if (!url.startsWith(prefix)) {
      return null;
    }
    return decodeURIComponent(url.slice(prefix.length));
  }

  async getObjectBufferByPublicUrl(
    url: string,
  ): Promise<{ buffer: Buffer; contentType?: string } | null> {
    const key = this.keyFromPublicUrl(url);
    if (!key) return null;
    try {
      const response = await this.s3Client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
      const buffer = await this.bodyToBuffer(response.Body);
      return { buffer, contentType: response.ContentType };
    } catch (error) {
      console.error('S3 GetObject Error:', error);
      return null;
    }
  }

  private async bodyToBuffer(body: unknown): Promise<Buffer> {
    if (!body) return Buffer.alloc(0);
    if (Buffer.isBuffer(body)) return body;
    if (body instanceof Uint8Array) return Buffer.from(body);
    if (body instanceof Readable) {
      const chunks: Buffer[] = [];
      for await (const chunk of body as AsyncIterable<Buffer | string>) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    }
    return Buffer.alloc(0);
  }

  /** Deletes an object whose public URL was produced by this service for the configured bucket. */
  async deleteByPublicUrl(url: string | null | undefined): Promise<void> {
    if (!url || typeof url !== 'string') return;
    const key = this.keyFromPublicUrl(url);
    if (!key) {
      return;
    }
    try {
      await this.s3Client.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
    } catch (error) {
      console.error('S3 Delete Error:', error);
    }
  }
}
