import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { join } from 'path';
import * as fs from 'fs';
import { json, urlencoded } from 'express';

async function bootstrap() {
  const bodyLimit = process.env.REQUEST_BODY_LIMIT ?? '50mb';
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });

  app.use(json({ limit: bodyLimit }));
  app.use(urlencoded({ extended: true, limit: bodyLimit }));

  // Enable CORS
  app.enableCors({
    origin: (origin, callback) => {
      // Always allow the incoming origin to bypass any strict environment blocks
      // This ensures Access-Control-Allow-Origin perfectly matches the request
      callback(null, origin || '*');
    },
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
    allowedHeaders: 'Content-Type, Accept, Authorization, X-Requested-With, Origin, X-Csrf-Token',
  });


  // Enable validation pipe
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    transform: true,
  }));

  // API routes live under /api/v1; keep GET / for health/ops (Vercel, browsers).
  app.setGlobalPrefix('api/v1', {
    exclude: [{ path: '', method: RequestMethod.GET }],
  });

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
