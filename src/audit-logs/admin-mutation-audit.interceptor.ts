import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Request } from 'express';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { AuditLogsService } from './audit-logs.service';

type RequestUser = { id?: string; email?: string; role?: string };

@Injectable()
export class AdminMutationAuditInterceptor implements NestInterceptor {
  constructor(private readonly auditLogs: AuditLogsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      tap({
        next: () => {
          void this.recordIfMutation(context);
        },
      }),
    );
  }

  private async recordIfMutation(context: ExecutionContext): Promise<void> {
    const req = context.switchToHttp().getRequest<
      Request & { user?: RequestUser }
    >();
    const method = (req.method || '').toUpperCase();
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      return;
    }

    const expressRoute = req.route as { path?: string } | undefined;
    const routePath = expressRoute?.path;
    const baseUrl = typeof req.baseUrl === 'string' ? req.baseUrl : '';
    const template =
      routePath != null
        ? `${baseUrl}${routePath}`
        : (req.originalUrl ?? req.url ?? '').split('?')[0] || '';

    const action =
      template.length > 0 ? `${method} ${template}` : `${method} (unknown-route)`;

    const user = req.user;
    const userLabel = user?.email ?? user?.id ?? null;
    const userEmail = user?.email ?? null;

    const params = req.params ?? {};
    const detailParams: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) {
      if (typeof v === 'string' && v.length > 0) {
        detailParams[k] = v.length > 200 ? `${v.slice(0, 200)}…` : v;
      }
    }

    const paramKeys = Object.keys(detailParams);
    const preferredKey =
      paramKeys.find((k) => /id$/i.test(k)) ??
      paramKeys.find((k) => /slug$/i.test(k)) ??
      paramKeys[0];
    const target = preferredKey ? detailParams[preferredKey] ?? null : null;

    let target_type: string | null = null;
    if (preferredKey) {
      target_type = preferredKey
        .replace(/Id$/i, '')
        .replace(/_id$/i, '')
        .replace(/^:/, '');
      if (!target_type) {
        target_type = preferredKey;
      }
    }

    await this.auditLogs.recordMutation({
      action,
      user: userLabel,
      user_email: userEmail,
      ip: (req.ip as string | undefined) ?? null,
      target,
      target_type,
      details: {
        routeTemplate: template,
        params: detailParams,
        query: this.sanitizeQuery(req.query),
        body: this.sanitizeBody(req.body),
        user_role: user?.role ?? undefined,
      },
    });
  }

  private sanitizeQuery(query: unknown): Record<string, unknown> | undefined {
    if (!query || typeof query !== 'object' || Array.isArray(query)) {
      return undefined;
    }
    const out: Record<string, unknown> = {};
    let n = 0;
    const maxEntries = 30;
    for (const [k, v] of Object.entries(query as Record<string, unknown>)) {
      if (n++ >= maxEntries) {
        break;
      }
      out[k] = this.sanitizeValue(v);
    }
    return Object.keys(out).length ? out : undefined;
  }

  private sanitizeBody(body: unknown, depth = 0): unknown {
    if (body === null || body === undefined) {
      return body;
    }
    const sensitiveKey = /^password|^token|^secret|^authorization|^credential|^otp|^refresh/i;
    if (depth > 6) {
      return '[truncated-depth]';
    }
    if (typeof body === 'string') {
      return body.length > 2000 ? `${body.slice(0, 2000)}…` : body;
    }
    if (typeof body !== 'object') {
      return body;
    }
    if (Array.isArray(body)) {
      return body.slice(0, 80).map((x) => this.sanitizeBody(x, depth + 1));
    }
    const obj = body as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, v] of Object.entries(obj)) {
      if (n++ >= 80) {
        out['…'] = 'extra keys omitted';
        break;
      }
      if (sensitiveKey.test(k)) {
        out[k] = '[redacted]';
        continue;
      }
      out[k] = this.sanitizeBody(v, depth + 1);
    }
    return out;
  }

  private sanitizeValue(value: unknown): unknown {
    if (typeof value === 'string') {
      return value.length > 500 ? `${value.slice(0, 500)}…` : value;
    }
    if (Array.isArray(value)) {
      return value.slice(0, 20).map((v) => this.sanitizeValue(v));
    }
    return value;
  }
}
