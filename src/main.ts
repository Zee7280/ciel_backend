import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { join } from 'path';
import * as fs from 'fs';
import { json, urlencoded } from 'express';
import compression from 'compression';
import { StripSecretsInterceptor } from './common/interceptors/strip-secrets.interceptor';

async function bootstrap() {
  const bodyLimit = process.env.REQUEST_BODY_LIMIT ?? '50mb';
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });

  app.use(compression());
  app.use(json({ limit: bodyLimit }));
  app.use(urlencoded({ extended: true, limit: bodyLimit }));

  // Basic security headers (no extra dependency). The API serves JSON, so these are safe everywhere.
  app.use((_req: any, res: any, next: () => void) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    if (process.env.NODE_ENV === 'production') {
      res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    }
    next();
  });

  // CORS. Auth is a Bearer token (not a cookie), so reflecting an origin cannot be abused for CSRF —
  // but production should still pin the origins. Set CORS_ALLOWED_ORIGINS (comma-separated) to
  // enforce an allowlist; without it the previous permissive behaviour is kept.
  const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  if (process.env.NODE_ENV === 'production' && allowedOrigins.length === 0) {
    // eslint-disable-next-line no-console
    console.warn('[security] CORS_ALLOWED_ORIGINS is not set — any origin may call this API. Set it in production.');
  }
  if (process.env.NODE_ENV === 'production' && !process.env.FRONTEND_URL && !process.env.APP_URL) {
    // eslint-disable-next-line no-console
    console.warn('[config] FRONTEND_URL / APP_URL is not set — emailed links and QR codes may point to the wrong site.');
  }
  app.enableCors({
    origin: (origin, callback) => {
      if (allowedOrigins.length === 0) {
        callback(null, origin || '*');
      } else if (!origin || allowedOrigins.includes(origin.replace(/\/+$/, ''))) {
        callback(null, origin || true);
      } else {
        callback(null, false);
      }
    },
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
    allowedHeaders: 'Content-Type, Accept, Authorization, X-Requested-With, Origin, X-Csrf-Token',
  });


  // Never let a password hash / reset token leave the server, even if a service serialises a User.
  app.useGlobalInterceptors(new StripSecretsInterceptor());

  // Enable validation pipe
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    transform: true,
  }));

  // API routes live under /api/v1; keep GET / for health/ops (Vercel, browsers).
  app.setGlobalPrefix('api/v1', {
    exclude: [
      { path: '', method: RequestMethod.GET },
      // Browsers/bots hit backend origin for favicon — avoid 404 noise in logs (API has no UI asset).
      { path: 'favicon.ico', method: RequestMethod.GET },
      { path: 'favicon.ico', method: RequestMethod.HEAD },
    ],
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
