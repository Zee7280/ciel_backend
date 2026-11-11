import { PassThrough } from 'stream';
import type { Response } from 'express';
import { NotFoundException } from '@nestjs/common';
import { AdminProjectEvidenceService } from './admin-project-evidence.service';

/** A writable Express-like response that records headers and the ZIP bytes. */
function fakeResponse() {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c));
  const headers: Record<string, string> = {};
  const res = Object.assign(stream, {
    headersSent: false,
    setHeader: (k: string, v: string) => {
      headers[k] = v;
    },
    status: () => res,
  });
  return {
    res: res as unknown as Response,
    headers,
    bytes: () => Buffer.concat(chunks),
  };
}

const restrictedReport = {
  id: '11111111-2222-3333-4444-555555555555',
  opportunityId: 'opp-1',
  studentId: 'stu-1',
  section8: {
    media_visible: 'restricted',
    evidence_files: [
      { url: 'https://b.s3.r.amazonaws.com/a.jpg', name: 'before.jpg' },
    ],
  },
  section4: {
    activity_blocks: [{ photo: 'https://b.s3.r.amazonaws.com/deep/b.png' }],
  },
};

function build() {
  const fetched: string[] = [];
  const service = new AdminProjectEvidenceService(
    {
      findOne: jest
        .fn()
        .mockResolvedValue({ id: 'opp-1', title: 'BinIt Right' }),
    } as never,
    { findOne: jest.fn().mockResolvedValue(restrictedReport) } as never,
    {
      find: jest
        .fn()
        .mockResolvedValue([
          { id: 'log-1', evidenceUrl: 'https://b.s3.r.amazonaws.com/log.jpg' },
        ]),
    } as never,
    {} as never,
    {
      getObjectBufferByPublicUrl: jest.fn((url: string) => {
        fetched.push(url);
        return Promise.resolve({ buffer: Buffer.from(`file:${url}`) });
      }),
    } as never,
  );
  return { service, fetched };
}

describe('AdminProjectEvidenceService.streamReportEvidenceZip', () => {
  it('zips restricted evidence for Super Admin, only URLs from the report itself', async () => {
    const { service, fetched } = build();
    const { res, headers, bytes } = fakeResponse();
    await service.streamReportEvidenceZip(
      restrictedReport.id,
      [
        'https://b.s3.r.amazonaws.com/a.jpg',
        'https://b.s3.r.amazonaws.com/deep/b.png',
        'https://b.s3.r.amazonaws.com/log.jpg',
        'https://b.s3.r.amazonaws.com/someone-else.pdf',
      ],
      res,
    );
    expect(fetched).toEqual([
      'https://b.s3.r.amazonaws.com/a.jpg',
      'https://b.s3.r.amazonaws.com/deep/b.png',
      'https://b.s3.r.amazonaws.com/log.jpg',
    ]);
    expect(headers['X-Evidence-Not-In-Record']).toBe('1');
    expect(headers['Content-Type']).toBe('application/zip');
    expect(headers['Content-Disposition']).toContain(
      'BinIt_Right-11111111-evidence.zip',
    );
    const zip = bytes().toString('latin1');
    expect(zip.startsWith('PK')).toBe(true);
    expect(zip).toContain('BinIt_Right/1_before.jpg');
    expect(zip).toContain('BinIt_Right/2_b.png');
    expect(zip).not.toContain('someone-else');
  });

  it('falls back to every collected file when no list is sent', async () => {
    const { service, fetched } = build();
    const { res } = fakeResponse();
    await service.streamReportEvidenceZip(restrictedReport.id, undefined, res);
    expect(fetched).toEqual(['https://b.s3.r.amazonaws.com/a.jpg']);
  });

  it('never fetches an outside URL; falls back to the report own files', async () => {
    const { service, fetched } = build();
    const { res } = fakeResponse();
    await service.streamReportEvidenceZip(
      restrictedReport.id,
      ['https://evil.example/x.jpg'],
      res,
    );
    expect(fetched).toEqual(['https://b.s3.r.amazonaws.com/a.jpg']);
  });

  it('404 when the report has no evidence at all', async () => {
    const service = new AdminProjectEvidenceService(
      { findOne: jest.fn() } as never,
      {
        findOne: jest
          .fn()
          .mockResolvedValue({ id: restrictedReport.id, section8: {} }),
      } as never,
      { find: jest.fn().mockResolvedValue([]) } as never,
      {} as never,
      { getObjectBufferByPublicUrl: jest.fn() } as never,
    );
    await expect(
      service.streamReportEvidenceZip(
        restrictedReport.id,
        undefined,
        fakeResponse().res,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
