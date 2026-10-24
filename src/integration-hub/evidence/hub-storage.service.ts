import { Injectable, Logger } from '@nestjs/common';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as crypto from 'crypto';
import { Readable } from 'stream';

/**
 * Object storage for third-party evidence. Deliberately NOT the core S3Service: the hub uses its
 * own private bucket (HUB_EVIDENCE_BUCKET; falls back to AWS_S3_BUCKET with the isolated prefix
 * `external-hub/` only for local development). Nothing here is ever served publicly.
 */
@Injectable()
export class HubStorageService {
  private readonly logger = new Logger(HubStorageService.name);
  private readonly client: S3Client | null;
  readonly bucket: string;
  readonly prefix: string;

  constructor() {
    const region = process.env.AWS_REGION;
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    const dedicated = (process.env.HUB_EVIDENCE_BUCKET ?? '').trim();
    this.bucket = dedicated || (process.env.AWS_S3_BUCKET ?? '').trim();
    this.prefix = dedicated ? '' : 'external-hub/';
    this.client =
      region && accessKeyId && secretAccessKey && this.bucket
        ? new S3Client({
            region,
            credentials: { accessKeyId, secretAccessKey },
          })
        : null;
    if (!this.client) {
      this.logger.warn(
        'Hub evidence storage not configured (AWS_* / HUB_EVIDENCE_BUCKET); evidence endpoints will refuse',
      );
    }
  }

  get configured(): boolean {
    return this.client !== null;
  }

  private need(): S3Client {
    if (!this.client) throw new Error('Hub evidence storage is not configured');
    return this.client;
  }

  quarantineKey(connectionId: string, uploadId: string, ext: string): string {
    return `${this.prefix}quarantine/${connectionId}/${uploadId}${ext}`;
  }

  acceptedKey(connectionId: string, uploadId: string, ext: string): string {
    return `${this.prefix}accepted/${connectionId}/${uploadId}${ext}`;
  }

  /** Short-lived, content-type + length bound PUT URL into quarantine. */
  async presignUpload(opts: {
    key: string;
    contentType: string;
    contentLength: number;
    expiresInSeconds: number;
  }): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: opts.key,
      ContentType: opts.contentType,
      ContentLength: opts.contentLength,
    });
    return getSignedUrl(this.need(), command, {
      expiresIn: opts.expiresInSeconds,
      signableHeaders: new Set(['content-type', 'content-length']),
    });
  }

  async head(
    key: string,
  ): Promise<{ size: number; contentType: string | null } | null> {
    try {
      const out = await this.need().send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        size: Number(out.ContentLength ?? 0),
        contentType: out.ContentType ?? null,
      };
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'NotFound' || name === 'NoSuchKey') return null;
      throw err;
    }
  }

  /** Streams the object and returns its SHA-256; aborts past maxBytes. */
  async sha256(key: string, maxBytes: number): Promise<string> {
    const out = await this.need().send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const hash = crypto.createHash('sha256');
    let total = 0;
    const body = out.Body as Readable | undefined;
    if (!body) throw new Error('Empty object body');
    for await (const chunk of body) {
      const buf = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk as Uint8Array);
      total += buf.length;
      if (total > maxBytes)
        throw new Error('Object larger than the allowed size');
      hash.update(buf);
    }
    return hash.digest('hex');
  }

  async move(fromKey: string, toKey: string): Promise<void> {
    const client = this.need();
    await client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${encodeURIComponent(fromKey).replace(/%2F/g, '/')}`,
        Key: toKey,
      }),
    );
    await client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: fromKey }),
    );
  }

  async delete(key: string): Promise<void> {
    await this.need().send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  /** Short-lived GET URL for an authorized viewer; never stored or shared with vendors. */
  async presignView(key: string, expiresInSeconds = 300): Promise<string> {
    return getSignedUrl(
      this.need(),
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: expiresInSeconds },
    );
  }
}
