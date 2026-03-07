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
    origin: [
      'https://cielpk.com',
      'https://www.cielpk.com',
      'http://localhost:3000',
      'http://localhost:3001',
      'http://localhost:3002',
      'https://ciel-frontend-gamma.vercel.app'
    ],
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

  const portArgIndex = process.argv.indexOf('-port');
  const portArgIndexLong = process.argv.indexOf('--port');
  const index = portArgIndex !== -1 ? portArgIndex : portArgIndexLong;
  const port = index !== -1 ? process.argv[index + 1] : (process.env.PORT ?? 3000);

  await app.listen(port);
  console.log(`Application is running on: ${await app.getUrl()}`);
}
bootstrap();
