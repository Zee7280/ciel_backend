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
  Between,
  FindOptionsWhere,
  LessThanOrEqual,
  Like,
  MoreThanOrEqual,
  Repository,
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

@Injectable()
export class IssueLogsService {
  private readonly logger = new Logger(IssueLogsService.name);
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
        stack: statusCode >= 500 ? this.getStack(exception) : null,
        userId: request.user?.id ?? null,
        userEmail: request.user?.email ?? null,
        userRole: request.user?.role ?? null,
        targetType: this.getTargetType(path),
        targetId: this.getTargetId(params, body, query),
        requestId,
        ip: request.ip,
        userAgent: this.getHeader(request, 'user-agent') ?? null,
        metadata: this.compactMetadata({
          routePath,
          params,
          query,
          body,
          contentType: this.getHeader(request, 'content-type'),
          contentLength: this.getHeader(request, 'content-length'),
          response: this.sanitizeForLog(responseBody),
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
    const where = this.buildWhere(query);

    const [logs, total] = await this.issueLogRepository.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip,
      take: limit,
    });

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

  async findOne(id: string) {
    const log = await this.issueLogRepository.findOne({ where: { id } });
    return {
      success: Boolean(log),
      data: log,
    };
  }

  private buildWhere(
    query: IssueLogListQuery,
  ): FindOptionsWhere<IssueLog>[] | FindOptionsWhere<IssueLog> {
    const base: FindOptionsWhere<IssueLog> = {};

    if (query.userId) base.userId = query.userId;
    if (query.userEmail) base.userEmail = Like(`%${query.userEmail}%`);
    if (query.module) base.module = query.module;
    if (query.action) base.action = Like(`%${query.action}%`);
    if (query.stage) base.stage = query.stage;
    if (query.severity) base.severity = query.severity;
    if (query.statusCode)
      base.statusCode = this.toPositiveInt(query.statusCode, 0);
    if (query.method) base.method = query.method.toUpperCase();
    if (query.path) base.path = Like(`%${query.path}%`);
    if (query.requestId) base.requestId = query.requestId;

    if (query.dateFrom && query.dateTo) {
      base.createdAt = Between(
        new Date(query.dateFrom),
        new Date(query.dateTo),
      );
    } else if (query.dateFrom) {
      base.createdAt = MoreThanOrEqual(new Date(query.dateFrom));
    } else if (query.dateTo) {
      base.createdAt = LessThanOrEqual(new Date(query.dateTo));
    }

    if (!query.search) {
      return base;
    }

    const search = Like(`%${query.search}%`);
    return [
      { ...base, message: search },
      { ...base, userEmail: search },
      { ...base, path: search },
      { ...base, requestId: search },
      { ...base, targetId: search },
    ];
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
      if (Array.isArray(message)) return message.join(', ');
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
      return typeof stack === 'string' ? stack.slice(0, 8000) : null;
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
    return null;
  }

  private getTargetType(path?: string): string | null {
    const cleanPath = path?.toLowerCase() ?? '';
    if (cleanPath.includes('/reports')) return 'report';
    if (cleanPath.includes('/projects') || cleanPath.includes('/opportunit'))
      return 'project';
    if (cleanPath.includes('/payments')) return 'payment';
    if (cleanPath.includes('/support')) return 'support_ticket';
    return null;
  }

  private getTargetId(params?: any, body?: any, query?: any): string | null {
    const value =
      params?.id ??
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
    if (depth > 4) return '[Max depth reached]';
    if (typeof value === 'string')
      return value.length > 1000 ? `${value.slice(0, 1000)}...` : value;
    if (typeof value !== 'object') return value;
    if (Array.isArray(value)) {
      return value
        .slice(0, 20)
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
    const json = JSON.stringify(metadata);
    if (json.length <= 12000) return metadata;
    return {
      ...metadata,
      body: '[Body omitted because log metadata exceeded size limit]',
    };
  }

  private toPositiveInt(value: unknown, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.floor(parsed);
  }
}
