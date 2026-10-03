import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { PlatformSettingsService } from '../../settings/platform-settings.service';

export const MAINTENANCE_MESSAGE =
  'The platform is under maintenance. Please try again shortly.';

/** Paths (relative to the /api/v1 prefix) reachable during maintenance so admins can sign in. */
const ALLOWED_PATHS: ReadonlyArray<{ method?: string; path: string }> = [
  { method: 'POST', path: '/auth/login' },
  { method: 'POST', path: '/auth/forgot-password' },
  { method: 'POST', path: '/auth/reset-password' },
  { method: 'GET', path: '/public/config' },
  { method: 'GET', path: '' },
  { method: 'GET', path: '/' },
  { method: 'GET', path: '/favicon.ico' },
  { method: 'HEAD', path: '/favicon.ico' },
];

type ReqLike = {
  method?: string;
  originalUrl?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
};

/** Global guard: while maintenance_mode is on, only admins (and sign-in / config endpoints) get through. */
/** 503 raised while maintenance mode is on. The issue-log filter skips it so blocked requests don't flood issue_logs. */
export class MaintenanceException extends ServiceUnavailableException {
  constructor() {
    super(MAINTENANCE_MESSAGE);
  }
}

@Injectable()
export class MaintenanceGuard implements CanActivate {
  constructor(
    private readonly platformSettings: PlatformSettingsService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    let maintenance = false;
    try {
      maintenance = await this.platformSettings.isMaintenanceMode();
    } catch {
      return true; // never lock the API out because the settings read failed
    }
    if (!maintenance) return true;

    const req = context.switchToHttp().getRequest<ReqLike>();
    const method = (req.method || 'GET').toUpperCase();
    if (method === 'OPTIONS') return true;
    if (this.isAllowedPath(method, req.originalUrl ?? req.url ?? '')) {
      return true;
    }
    if (this.isAdminToken(req)) return true;

    throw new MaintenanceException();
  }

  private isAllowedPath(method: string, rawUrl: string): boolean {
    let path = (rawUrl.split('?')[0] || '').replace(/\/+$/, '');
    path = path.replace(/^\/api\/v1(?=\/|$)/, '');
    return ALLOWED_PATHS.some(
      (a) => a.path === path && (!a.method || a.method === method),
    );
  }

  private isAdminToken(req: ReqLike): boolean {
    try {
      const header = req.headers?.authorization;
      const value = Array.isArray(header) ? header[0] : header;
      const match = /^Bearer\s+(.+)$/i.exec(value ?? '');
      if (!match) return false;
      const secret =
        this.config?.get<string>('JWT_SECRET') ||
        process.env.JWT_SECRET ||
        'secretKey';
      const payload = jwt.verify(match[1], secret) as { role?: string };
      return payload?.role === 'admin';
    } catch {
      return false;
    }
  }
}
