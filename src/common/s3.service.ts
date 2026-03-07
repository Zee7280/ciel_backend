import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand, ObjectCannedACL } from '@aws-sdk/client-s3';
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

    async uploadFile(file: Express.Multer.File, folder: string): Promise<string> {
        const fileExt = path.extname(file.originalname);
        const fileName = `${folder}/${crypto.randomUUID()}${fileExt}`;

        try {
            const command = new PutObjectCommand({
                Bucket: this.bucket,
                Key: fileName,
                Body: file.buffer,
                ContentType: file.mimetype,
                ACL: 'public-read',
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
                ACL: 'public-read',
            });

            await this.s3Client.send(command);
            return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${fileName}`;
        } catch (error) {
            console.error('S3 Buffer Upload Error:', error);
            throw new InternalServerErrorException('Failed to upload buffer to S3');
        }
    }
}
