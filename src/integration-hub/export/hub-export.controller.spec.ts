import { HttpStatus } from '@nestjs/common';
import {
  HUB_EXPORT_SUMMARY_PER_MINUTE,
  HubExportController,
} from './hub-export.controller';
import type { HubRequest } from '../security/platform-auth.guard';

const CONN = '11111111-1111-4111-8111-111111111111';

function build(opts: { auditFails?: boolean } = {}) {
  const access = {
    platform: { id: 'plat-1', slug: 'bnu-erp', status: 'live' },
    connection: { id: CONN },
    organization: { id: 'uni-1', name: 'BNU' },
    personalFields: false,
  };
  const exporter = {
    resolveAccess: jest.fn().mockResolvedValue(access),
    students: jest.fn().mockResolvedValue({
      rows: [{ id: 'a' }, { id: 'b' }],
      next_cursor: 'c',
      has_more: true,
    }),
    summary: jest.fn().mockResolvedValue({ period: {} }),
  };
  const audit = {
    logOrThrow: opts.auditFails
      ? jest.fn().mockRejectedValue(new Error('hub db down'))
      : jest.fn().mockResolvedValue(undefined),
    log: jest.fn(),
  };
  const controller = new HubExportController(exporter as never, audit as never);
  const req = {
    hubPlatform: access.platform,
    headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' },
    ip: '10.0.0.1',
  } as unknown as HubRequest;
  const res = { setHeader: jest.fn() };
  return { controller, exporter, audit, req, res };
}

describe('HubExportController', () => {
  it('audits a list read with counts only (no row content) before answering', async () => {
    const { controller, audit, req } = build();
    const body = await controller.students(req, {
      connection_id: CONN,
      limit: '2',
    });
    expect(body).toMatchObject({
      success: true,
      scope: 'export:students',
      connection_id: CONN,
      personal_fields: false,
      page: { limit: 2, count: 2, next_cursor: 'c', has_more: true },
    });
    expect(audit.logOrThrow).toHaveBeenCalledTimes(1);
    type Entry = {
      actor: { type: string; ip: string | null };
      action: string;
      targetId: string;
      connectionId: string;
      details: Record<string, unknown>;
    };
    const entry = (audit.logOrThrow.mock.calls as Entry[][])[0][0];
    expect(entry.action).toBe('export.read');
    expect(entry.targetId).toBe('export:students');
    expect(entry.connectionId).toBe(CONN);
    expect(entry.actor).toMatchObject({ type: 'platform', ip: '203.0.113.9' });
    expect(entry.details).toEqual({
      rows: 2,
      has_more: true,
      limit: 2,
      updated_since: null,
      cursor_used: false,
    });
    expect(JSON.stringify(entry.details)).not.toContain('"id"');
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('refuses to answer when the audit row cannot be written', async () => {
    const { controller, req } = build({ auditFails: true });
    await expect(
      controller.students(req, { connection_id: CONN }),
    ).rejects.toThrow('hub db down');
  });

  it('rejects an unknown community-service source before touching access', () => {
    const { controller, exporter, req } = build();
    let thrown: unknown;
    try {
      void controller.communityService(req, {
        connection_id: CONN,
        source: 'all',
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({
      status: HttpStatus.BAD_REQUEST,
      response: { code: 'SOURCE_INVALID' },
    });
    expect(exporter.resolveAccess).not.toHaveBeenCalled();
  });

  it('gives summary its own per-platform budget with Retry-After', async () => {
    const { controller, exporter, req, res } = build();
    for (let i = 0; i < HUB_EXPORT_SUMMARY_PER_MINUTE; i += 1) {
      await controller.summary(req, { connection_id: CONN }, res as never);
    }
    expect(exporter.summary).toHaveBeenCalledTimes(
      HUB_EXPORT_SUMMARY_PER_MINUTE,
    );
    await expect(
      controller.summary(req, { connection_id: CONN }, res as never),
    ).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
      response: { code: 'RATE_LIMITED' },
    });
    expect(res.setHeader).toHaveBeenCalledWith(
      'Retry-After',
      expect.any(String),
    );
    expect(exporter.summary).toHaveBeenCalledTimes(
      HUB_EXPORT_SUMMARY_PER_MINUTE,
    );
  });

  it('rejects a reversed period', async () => {
    const { controller, req, res } = build();
    await expect(
      controller.summary(
        req,
        { connection_id: CONN, from: '2026-12-01', to: '2026-01-01' },
        res as never,
      ),
    ).rejects.toMatchObject({ response: { code: 'PERIOD_INVALID' } });
  });

  it('marks every route no-store', () => {
    for (const name of [
      'students',
      'opportunities',
      'communityService',
      'fyp',
      'ventures',
      'summary',
    ]) {
      const headers = Reflect.getMetadata(
        '__headers__',
        HubExportController.prototype[name as keyof HubExportController],
      ) as { name: string; value: string }[];
      expect(headers).toEqual([
        {
          name: 'Cache-Control',
          value: 'no-store, no-cache, must-revalidate, private',
        },
      ]);
    }
  });
});
