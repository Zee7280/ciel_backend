import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
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
                secretAccessKey: this.configService.get<string>('AWS_SECRET_ACCESS_KEY')!,
            },
        });
    }

    /** Returns a presigned PUT URL and corresponding public URL for the configured bucket. */
    async presignPutObject(opts: {
        folder: string;
        originalName: string;
        contentType: string;
        expiresInSeconds?: number;
    }): Promise<{ uploadUrl: string; publicUrl: string; key: string }> {
        const fileExt = path.extname(opts.originalName || '').slice(0, 12);
        const key = `${opts.folder}/${crypto.randomUUID()}${fileExt}`;
        try {
            const command = new PutObjectCommand({
                Bucket: this.bucket,
                Key: key,
                ContentType: opts.contentType,
            });
            const uploadUrl = await getSignedUrl(this.s3Client, command, {
                expiresIn: opts.expiresInSeconds ?? 15 * 60,
            });
            const publicUrl = `https://${this.bucket}.s3.${this.region}.amazonaws.com/${key}`;
            return { uploadUrl, publicUrl, key };
        } catch (error) {
            console.error('S3 Presign Error:', error);
            throw new InternalServerErrorException('Failed to create S3 upload URL');
        }
    }

    async uploadFile(file: Express.Multer.File, folder: string): Promise<string> {
        const fileExt = path.extname(file.originalname);
        const fileName = `${folder}/${crypto.randomUUID()}${fileExt}`;

        try {
            const command = new PutObjectCommand({
                Bucket: this.bucket,
                Key: fileName,
                Body: file.buffer,
                ContentType: file.mimetype,
            });

            await this.s3Client.send(command);

            // Return the public URL
            return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${fileName}`;
        } catch (error) {
            console.error('S3 Upload Error:', error);
            throw new InternalServerErrorException('Failed to upload file to S3');
        }
    }

    async uploadBuffer(buffer: Buffer, fileName: string, contentType: string): Promise<string> {
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

    /** Deletes an object whose public URL was produced by this service for the configured bucket. */
    async deleteByPublicUrl(url: string | null | undefined): Promise<void> {
        if (!url || typeof url !== 'string') return;
        const prefix = `https://${this.bucket}.s3.${this.region}.amazonaws.com/`;
        if (!url.startsWith(prefix)) {
            return;
        }
        const key = decodeURIComponent(url.slice(prefix.length));
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
