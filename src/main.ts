import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { join } from 'path';
import * as fs from 'fs';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Enable CORS
  app.enableCors({
    origin: process.env.FRONTEND_URL || 'http://localhost:3001',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });

  // Enable validation pipe
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    transform: true,
  }));

  // Set global API prefix
  app.setGlobalPrefix('api/v1');

  // Serve static files from uploads directory (only if it exists)
  // For Vercel/Production, we might need a different strategy (S3/Cloudinary)
  const uploadDir = join(process.cwd(), 'uploads');
  if (fs.existsSync(uploadDir)) {
    app.useStaticAssets(uploadDir, {
      prefix: '/uploads/',
    });
  }

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
