import {
  ArgumentsHost,
  HttpException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Request } from 'express';
import {
  Brackets,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';
import { IssueLog } from './entities/issue-log.entity';

type RequestUser = {
  id?: string;
  email?: string;
  role?: string;
};

export type IssueLogListQuery = {
  page?: string | number;
  limit?: string | number;
  userId?: string;
  userEmail?: string;
  module?: string;
  action?: string;
  stage?: string;
  severity?: string;
  statusCode?: string | number;
  method?: string;
  path?: string;
  requestId?: string;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
};

/** Max JSON size for `metadata` before we drop bulky fields (Postgres handles large JSONB; still cap for safety). */
const METADATA_JSON_MAX_CHARS = 384 * 1024;

@Injectable()
export class IssueLogsService {
  private readonly logger = new Logger(IssueLogsService.name);
  private readonly safeHeaderAllowlist = new Set([
    'accept',
    'accept-encoding',
    'accept-language',
    'content-type',
    'referer',
    'origin',
    'x-forwarded-for',
    'x-forwarded-proto',
    'x-forwarded-host',
    'x-real-ip',
    'cf-connecting-ip',
    'cf-ray',
    'sec-fetch-dest',
    'sec-fetch-mode',
    'sec-fetch-site',
    'sec-ch-ua',
    'sec-ch-ua-mobile',
    'sec-ch-ua-platform',
  ]);

  /** Per-string cap inside sanitized JSON payloads (raised for diagnosis — still excludes secrets via key rules). */
  private readonly sanitizationStringCap = 16_384;
  private readonly sanitizationArrayCap = 100;
  private readonly sanitizationMaxDepth = 6;
  private readonly stackMaxChars = 32_768;
  private readonly causeStackChars = 4_096;
  private readonly causeDepthMax = 4;

  private readonly sensitiveKeyFragments = [
    'authorization',
    'cookie',
    'password',
    'token',
    'secret',
    'otp',
    'cnic',
    'card',
    'cvv',
  ];

  constructor(
    @InjectRepository(IssueLog)
    private readonly issueLogRepository: Repository<IssueLog>,
  ) {}

  async logException(exception: unknown, host: ArgumentsHost): Promise<void> {
    try {
      const ctx = host.switchToHttp();
      const request = ctx.getRequest<Request & { user?: RequestUser }>();
      const statusCode = this.getStatusCode(exception);
      const responseBody =
        exception instanceof HttpException
          ? exception.getResponse()
          : undefined;
      const message = this.getErrorMessage(exception, responseBody);
      const body = this.sanitizeForLog(request.body);
      const query = this.sanitizeForLog(request.query);
      const params = this.sanitizeForLog(request.params);
      const routePath = request.route?.path
        ? String(request.route.path)
        : undefined;
      const path =
        request.path || request.originalUrl?.split('?')[0] || request.url;
      const requestId =
        this.getHeader(request, 'x-request-id') ||
        this.getHeader(request, 'x-correlation-id') ||
        randomUUID();

      const log = this.issueLogRepository.create({
        eventType: 'exception',
        severity: statusCode >= 500 ? 'error' : 'warning',
        module: this.getModule(path),
        action: this.getAction(request.method, path),
        stage: this.getStage(path, body, query),
        statusCode,
        method: request.method,
        path,
        message,
        errorName: this.getErrorName(exception),
        stack: this.getStack(exception),
        userId: request.user?.id ?? null,
        userEmail: request.user?.email ?? null,
        userRole: request.user?.role ?? null,
        targetType: this.getTargetType(path),
        targetId: this.getTargetId(params, body, query),
        requestId,
        ip: request.ip,
        userAgent: this.getHeader(request, 'user-agent') ?? null,
        metadata: this.compactMetadata({
          requestTrace: this.summarizeRequestRouting(request),
          safeHeaders: this.pickSafeHeaders(request),
          routePath,
          params,
          query,
          body,
          contentType: this.getHeader(request, 'content-type'),
          contentLength: this.getHeader(request, 'content-length'),
          response: this.sanitizeForLog(responseBody),
          exceptionConstructName: this.getExceptionConstructorName(exception),
          errorCauseChain: this.sanitizeForLog(
            this.collectErrorCauseChain(exception),
          ),
        }),
      });

      await this.issueLogRepository.save(log);
    } catch (logError) {
      this.logger.warn(
        `Issue log write failed: ${this.getErrorMessage(logError)}`,
      );
    }
  }

  async findAll(query: IssueLogListQuery = {}) {
    const page = this.toPositiveInt(query.page, 1);
    const limit = Math.min(this.toPositiveInt(query.limit, 20), 100);
    const skip = (page - 1) * limit;

    const qb = this.issueLogRepository.createQueryBuilder('log');
    this.applyIssueLogListFilters(qb, query);
    qb.orderBy('log.createdAt', 'DESC');

    const [logs, total] = await qb.skip(skip).take(limit).getManyAndCount();

    return {
      success: true,
      data: logs,
      meta: {
        page,
        limit,
        total,
      },
    };
  }

  /** Module dropdown aliases (student vs students) and shared student routes. */
  private resolveModuleFilterValues(module: string): string[] {
    const key = module.trim().toLowerCase();
    if (key === 'student' || key === 'students') {
      return ['student', 'students'];
    }
    return [module.trim()];
  }

  private applyIssueLogListFilters(
    qb: SelectQueryBuilder<IssueLog>,
    query: IssueLogListQuery,
  ): void {
    if (query.userId) {
      qb.andWhere('log.userId = :userId', { userId: query.userId });
    }
    if (query.userEmail?.trim()) {
      qb.andWhere('log.userEmail ILIKE :userEmail', {
        userEmail: `%${query.userEmail.trim()}%`,
      });
    }
    if (query.module?.trim()) {
      const modules = this.resolveModuleFilterValues(query.module);
      if (modules.length === 1) {
        qb.andWhere('log.module = :module', { module: modules[0] });
      } else {
        qb.andWhere('log.module IN (:...modules)', { modules });
      }
    }
    if (query.action?.trim()) {
      qb.andWhere('log.action ILIKE :action', {
        action: `%${query.action.trim()}%`,
      });
    }
    if (query.stage?.trim()) {
      qb.andWhere('log.stage = :stage', { stage: query.stage.trim() });
    }
    if (query.severity?.trim()) {
      qb.andWhere('log.severity = :severity', {
        severity: query.severity.trim(),
      });
    }
    if (query.statusCode) {
      const statusCode = this.toPositiveInt(query.statusCode, 0);
      if (statusCode > 0) {
        qb.andWhere('log.statusCode = :statusCode', { statusCode });
      }
    }
    if (query.method?.trim()) {
      qb.andWhere('log.method = :method', {
        method: query.method.trim().toUpperCase(),
      });
    }
    if (query.path?.trim()) {
      qb.andWhere('log.path ILIKE :path', {
        path: `%${query.path.trim()}%`,
      });
    }
    if (query.requestId?.trim()) {
      qb.andWhere('log.requestId = :requestId', {
        requestId: query.requestId.trim(),
      });
    }
    if (query.dateFrom && query.dateTo) {
      qb.andWhere('log.createdAt BETWEEN :dateFrom AND :dateTo', {
        dateFrom: new Date(query.dateFrom),
        dateTo: new Date(query.dateTo),
      });
    } else if (query.dateFrom) {
      qb.andWhere('log.createdAt >= :dateFrom', {
        dateFrom: new Date(query.dateFrom),
      });
    } else if (query.dateTo) {
      qb.andWhere('log.createdAt <= :dateTo', {
        dateTo: new Date(query.dateTo),
      });
    }

    const search = (query.search || '').trim();
    if (search) {
      const term = `%${search}%`;
      qb.andWhere(
        new Brackets((sub) => {
          sub
            .where('log.message ILIKE :term', { term })
            .orWhere('log.userEmail ILIKE :term', { term })
            .orWhere('log.path ILIKE :term', { term })
            .orWhere('log.requestId ILIKE :term', { term })
            .orWhere('log.targetId ILIKE :term', { term })
            .orWhere('log.module ILIKE :term', { term })
            .orWhere('log.stage ILIKE :term', { term })
            .orWhere('log.errorName ILIKE :term', { term })
            .orWhere('log.action ILIKE :term', { term })
            .orWhere('log.userRole ILIKE :term', { term });
        }),
      );
    }
  }

  async findOne(id: string) {
    const log = await this.issueLogRepository.findOne({ where: { id } });
    return {
      success: Boolean(log),
      data: log,
    };
  }

  /**
   * Structured issue row for attendance (and similar) business-rule failures.
   * Fire-and-forget from services; never throws to callers.
   */
  async logOperationalIssue(input: {
    eventType?: string;
    severity?: 'warning' | 'error' | 'info';
    module: string;
    stage: string;
    message: string;
    statusCode?: number;
    method?: string | null;
    path?: string | null;
    userId?: string | null;
    userEmail?: string | null;
    userRole?: string | null;
    targetType?: string | null;
    targetId?: string | null;
    requestId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    try {
      const log = this.issueLogRepository.create({
        eventType: input.eventType ?? 'operational_failure',
        severity: input.severity ?? 'warning',
        module: input.module,
        action: input.path
          ? `${input.method ?? 'POST'} ${input.path}`.trim()
          : null,
        stage: input.stage,
        statusCode: input.statusCode ?? null,
        method: input.method ?? null,
        path: input.path ?? null,
        message: input.message,
        errorName: null,
        stack: null,
        userId: input.userId ?? null,
        userEmail: input.userEmail ?? null,
        userRole: input.userRole ?? null,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        requestId: input.requestId ?? randomUUID(),
        ip: null,
        userAgent: null,
        metadata: this.compactMetadata(
          this.sanitizeForLog(input.metadata ?? {}) as Record<string, unknown>,
        ),
      });
      await this.issueLogRepository.save(log);
    } catch (logError) {
      this.logger.warn(
        `Operational issue log write failed: ${this.getErrorMessage(logError)}`,
      );
    }
  }

  private summarizeRequestRouting(request: Request): Record<string, unknown> {
    const r = request as Request & {
      protocol?: string;
      hostname?: string;
      baseUrl?: string;
    };
    return {
      method: request.method ?? null,
      originalUrl:
        typeof request.originalUrl === 'string' ? request.originalUrl : null,
      path: typeof request.path === 'string' ? request.path : null,
      url: typeof request.url === 'string' ? request.url : null,
      baseUrl: typeof r.baseUrl === 'string' ? r.baseUrl : null,
      protocol: typeof r.protocol === 'string' ? r.protocol : null,
      hostname: typeof r.hostname === 'string' ? r.hostname : null,
      host:
        typeof request.headers?.host === 'string'
          ? request.headers.host
          : null,
    };
  }

  private pickSafeHeaders(request: Request): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {};
    for (const [key, raw] of Object.entries(request.headers)) {
      if (!this.safeHeaderAllowlist.has(key.toLowerCase())) continue;
      if (raw === undefined) continue;
      if (Array.isArray(raw)) {
        out[key] = raw.map((segment) =>
          segment.length > 512 ? `${segment.slice(0, 512)}…` : segment,
        );
      } else if (typeof raw === 'string') {
        out[key] = raw.length > 512 ? `${raw.slice(0, 512)}…` : raw;
      }
    }
    return out;
  }

  private getExceptionConstructorName(exception: unknown): string | null {
    if (typeof exception !== 'object' || exception === null) return null;
    const ctor = (exception as { constructor?: { name?: string } }).constructor;
    const name = ctor?.name;
    return typeof name === 'string' && name.length > 0 ? name : null;
  }

  private collectErrorCauseChain(exception: unknown): unknown[] {
    const chain: unknown[] = [];
    let cur: unknown = exception;

    for (let depth = 0; depth < this.causeDepthMax; depth++) {
      if (!cur || typeof cur !== 'object') break;
      const cause = (cur as { cause?: unknown }).cause;
      if (cause === undefined || cause === null) break;

      if (typeof cause === 'string') {
        chain.push({
          kind: 'stringCause',
          message:
            cause.length > this.sanitizationStringCap
              ? `${cause.slice(0, this.sanitizationStringCap)}…`
              : cause,
        });
        break;
      }

      if (cause instanceof Error) {
        const msg = cause.message ?? '';
        chain.push({
          kind: 'Error',
          name: cause.name,
          message:
            msg.length > this.sanitizationStringCap
              ? `${msg.slice(0, this.sanitizationStringCap)}…`
              : msg,
          stack:
            typeof cause.stack === 'string'
              ? cause.stack.slice(0, this.causeStackChars)
              : null,
        });
        cur = cause;
        continue;
      }

      chain.push({
        kind: 'objectCause',
        value: this.sanitizeForLog(cause),
      });
      break;
    }

    return chain;
  }

  private getStatusCode(exception: unknown): number {
    if (exception instanceof HttpException) {
      return exception.getStatus();
    }
    return 500;
  }

  private getErrorMessage(exception: unknown, responseBody?: unknown): string {
    if (responseBody && typeof responseBody === 'object') {
      const message = (responseBody as { message?: unknown }).message;
      if (Array.isArray(message)) {
        return message
          .map((item) => {
            if (typeof item === 'string') return item;
            if (item && typeof item === 'object') {
              const o = item as Record<string, unknown>;
              if (
                typeof o.property === 'string' &&
                o.constraints &&
                typeof o.constraints === 'object'
              ) {
                const parts = Object.values(
                  o.constraints as Record<string, string>,
                );
                return `${o.property}: ${parts.join(', ')}`;
              }
              return JSON.stringify(this.sanitizeForLog(item));
            }
            return String(item);
          })
          .join('; ');
      }
      if (typeof message === 'string') return message;
    }
    if (typeof exception === 'object' && exception && 'message' in exception) {
      const message = (exception as { message?: unknown }).message;
      if (typeof message === 'string') return message;
    }
    if (typeof exception === 'string') return exception;
    return 'Unhandled exception';
  }

  private getErrorName(exception: unknown): string | null {
    if (typeof exception === 'object' && exception && 'name' in exception) {
      const name = (exception as { name?: unknown }).name;
      return typeof name === 'string' ? name : null;
    }
    return null;
  }

  private getStack(exception: unknown): string | null {
    if (typeof exception === 'object' && exception && 'stack' in exception) {
      const stack = (exception as { stack?: unknown }).stack;
      return typeof stack === 'string'
        ? stack.slice(0, this.stackMaxChars)
        : null;
    }
    return null;
  }

  private getHeader(request: Request, key: string): string | null {
    const value = request.headers[key.toLowerCase()];
    if (Array.isArray(value)) return value[0] ?? null;
    return typeof value === 'string' ? value : null;
  }

  private getModule(path?: string): string | null {
    if (!path) return null;
    const cleanPath = path.split('?')[0].replace(/^\/+/, '');
    const parts = cleanPath.split('/').filter(Boolean);
    const apiIndex = parts.findIndex((part) => part === 'api');
    const moduleIndex = apiIndex >= 0 ? apiIndex + 2 : 0;
    return parts[moduleIndex] ?? parts[0] ?? null;
  }

  private getAction(method?: string, path?: string): string | null {
    if (!method && !path) return null;
    return `${method ?? 'UNKNOWN'} ${path ?? ''}`.trim();
  }

  private getStage(path?: string, body?: any, query?: any): string | null {
    const directStage =
      body?.stage ??
      body?.report_stage ??
      body?.currentStage ??
      body?.current_step ??
      body?.currentStep ??
      body?.section ??
      query?.stage;
    if (typeof directStage === 'string' && directStage.trim()) {
      return directStage.trim();
    }

    const cleanPath = path?.toLowerCase() ?? '';
    if (
      cleanPath.includes('/reports/upload') ||
      cleanPath.includes('/evidence')
    )
      return 'report_file_upload';
    if (cleanPath.includes('/reports/draft') || cleanPath.includes('/draft'))
      return 'report_draft';
    if (cleanPath.includes('/reports') && cleanPath.includes('/submit'))
      return 'report_submit';
    if (cleanPath.includes('/reports')) return 'report_flow';
    if (cleanPath.includes('/engagement') && cleanPath.includes('/attendance'))
      return 'attendance_submit';
    return null;
  }

  private getTargetType(path?: string): string | null {
    const cleanPath = path?.toLowerCase() ?? '';
    if (cleanPath.includes('/reports')) return 'report';
    if (cleanPath.includes('/engagement')) return 'participation';
    if (cleanPath.includes('/projects') || cleanPath.includes('/opportunit'))
      return 'project';
    if (cleanPath.includes('/payments')) return 'payment';
    if (cleanPath.includes('/support')) return 'support_ticket';
    return null;
  }

  private getTargetId(params?: any, body?: any, query?: any): string | null {
    const value =
      params?.id ??
      params?.participantId ??
      params?.projectId ??
      body?.report_id ??
      body?.reportId ??
      body?.opportunityId ??
      body?.project_id ??
      query?.report_id ??
      query?.reportId ??
      query?.opportunityId ??
      query?.project_id;
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private sanitizeForLog(value: unknown, depth = 0): unknown {
    if (value === null || value === undefined) return value;
    if (depth > this.sanitizationMaxDepth) return '[Max depth reached]';
    if (typeof value === 'string') {
      const cap = this.sanitizationStringCap;
      return value.length > cap ? `${value.slice(0, cap)}…` : value;
    }
    if (typeof value !== 'object') return value;
    if (Array.isArray(value)) {
      return value
        .slice(0, this.sanitizationArrayCap)
        .map((item) => this.sanitizeForLog(item, depth + 1));
    }

    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (this.isSensitiveKey(key)) {
        output[key] = '[REDACTED]';
        continue;
      }
      output[key] = this.sanitizeForLog(item, depth + 1);
    }
    return output;
  }

  private isSensitiveKey(key: string): boolean {
    const normalized = key.toLowerCase();
    return this.sensitiveKeyFragments.some((fragment) =>
      normalized.includes(fragment),
    );
  }

  private compactMetadata(metadata: Record<string, unknown>) {
    const stringify = (m: Record<string, unknown>) => {
      try {
        return JSON.stringify(m);
      } catch {
        return null;
      }
    };

    let current: Record<string, unknown> = { ...metadata };
    let json = stringify(current);

    if (json === null) {
      return { error: '[metadata not serializable]' };
    }

    if (json.length <= METADATA_JSON_MAX_CHARS) return current;

    current = {
      ...current,
      body: '[Omitted — metadata size cap; see response column details]',
    };
    json = stringify(current);
    if (json && json.length <= METADATA_JSON_MAX_CHARS) return current;

    current = {
      ...current,
      query: '[Omitted]',
    };
    json = stringify(current);
    if (json && json.length <= METADATA_JSON_MAX_CHARS) return current;

    current = {
      ...current,
      response: '[Omitted — see message / stack / exceptionConstructName]',
    };
    json = stringify(current);
    if (json && json.length <= METADATA_JSON_MAX_CHARS) return current;

    current = {
      ...current,
      safeHeaders: {},
      errorCauseChain: '[Omitted]',
    };
    json = stringify(current);
    if (json && json.length <= METADATA_JSON_MAX_CHARS) return current;

    return {
      requestTrace: current.requestTrace ?? null,
      routePath: current.routePath ?? null,
      note: 'Heavy truncation applied to satisfy metadata size limit',
    };
  }

  private toPositiveInt(value: unknown, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.floor(parsed);
  }
}
