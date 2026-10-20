import { AiService } from './ai.service';
import { readFileSync } from 'fs';
import { join } from 'path';
import { NPE_CRITERION_KEYS } from '../ranking/npe-ranking.constants';

const fixture = (name: string) =>
  readFileSync(join(__dirname, '../../test/fixtures/pdf', name));

const JPG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
const validEvaluation = () => {
  const criteria = Object.fromEntries(
    NPE_CRITERION_KEYS.map((k) => [
      k,
      { anchor: 4, confidence: 'high', reason: 'ok', claimIds: [`${k}-1`] },
    ]),
  );
  const claims = NPE_CRITERION_KEYS.map((k) => ({
    id: `${k}-1`,
    criterion: k,
    statement: 's',
    source: 'report',
    locator: 'S4',
    support: 'high',
    limitation: 'l',
  }));
  return JSON.stringify({
    projectId: 'r1',
    packageVersion: 'v1',
    readComplete: true,
    flags: [],
    summary: 's',
    limitations: 'l',
    criteria,
    claims,
  });
};

const BKT = 'https://bkt.s3.eu.amazonaws.com/e';
const file = (
  id: string,
  name: string,
  type: string,
  source = 'section8.evidence_files',
) => ({
  file_id: id,
  file_name: name,
  file_type: type,
  url: `${BKT}/${name}`,
  source,
});

describe('NPE ranking: evidence given to the model', () => {
  const realFetch = global.fetch;
  const realKey = process.env.OPENAI_API_KEY;
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'sk-test';
  });
  afterEach(() => {
    global.fetch = realFetch;
    process.env.OPENAI_API_KEY = realKey;
  });

  async function run(
    files: any[],
    store: Record<string, { buffer: Buffer; contentType: string } | null>,
  ) {
    const s3 = {
      getObjectBufferByPublicUrl: jest.fn(
        async (url: string) => store[url.split('/').pop()!] ?? null,
      ),
    };
    const f = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [{ message: { content: validEvaluation() } }],
        }),
    });
    global.fetch = f as never;
    const out = await new AiService(s3 as never).summarize(
      'npe_ranking_evaluation',
      { projectId: 'r1', uploaded_evidence_files: files },
    );
    const content = JSON.parse(f.mock.calls[0][1].body).messages[1]
      .content as Array<{ type: string; text?: string; image_url?: unknown }>;
    const texts = (
      Array.isArray(content)
        ? content
        : [{ type: 'text', text: content as unknown as string }]
    )
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('\n');
    return { out, content, texts, s3 };
  }

  it('reads PDF originals as text (the receipt amount reaches the model) and says so in the read status', async () => {
    const { out, texts } = await run([file('E1', 'receipt.pdf', 'pdf')], {
      'receipt.pdf': {
        buffer: fixture('receipt.pdf'),
        contentType: 'application/pdf',
      },
    });
    expect(texts).toContain('Evidence document E1');
    expect(texts).toContain('PKR 48250');
    expect(texts).toContain('EVIDENCE READ STATUS');
    expect(out.evidenceInspection?.inspected).toEqual([
      { id: 'E1', name: 'receipt.pdf' },
    ]);
    expect(out.evidenceInspection?.notInspected).toEqual([]);
  });

  it('scrubs personal identifiers out of PDF text before it leaves the platform', async () => {
    const { texts } = await run([file('E1', 'letter.pdf', 'pdf')], {
      'letter.pdf': {
        buffer: fixture('letter.pdf'),
        contentType: 'application/pdf',
      },
    });
    expect(texts).not.toContain('head@school.pk');
    expect(texts).not.toContain('35202-1234567-1');
    expect(texts).not.toContain('0300-1234567');
    expect(texts).toContain('Signed by');
  });

  it('sends images as images, spread across the report sections instead of the first four in order', async () => {
    const files = [
      file('E1', 'a1.jpg', 'jpg', 'section1.media_urls'),
      file('E2', 'a2.jpg', 'jpg', 'section1.media_urls'),
      file('E3', 'a3.jpg', 'jpg', 'section1.media_urls'),
      file('E4', 'a4.jpg', 'jpg', 'section1.media_urls'),
      file('E5', 'b1.jpg', 'jpg', 'section5.media_urls'),
      file('E6', 'c1.jpg', 'jpg', 'section8.evidence_files'),
    ];
    const store = Object.fromEntries(
      files.map((f) => [
        f.file_name,
        { buffer: JPG, contentType: 'image/jpeg' },
      ]),
    );
    const { out, content } = await run(files, store);
    const shown = out.evidenceInspection!.inspected.map((i) => i.id).sort();
    expect(shown).toHaveLength(4);
    expect(shown).toEqual(expect.arrayContaining(['E5', 'E6'])); // later sections are not starved by section 1
    expect(
      (content as any[]).filter((p) => p.type === 'image_url'),
    ).toHaveLength(4);
    expect(out.evidenceInspection!.notInspected).toHaveLength(2);
    expect(out.evidenceInspection!.notInspected[0].reason).toMatch(
      /only 4 images/,
    );
  });

  it('is honest about what it could not read: video, office files, scanned PDFs, missing and oversized files', async () => {
    const files = [
      file('E1', 'clip.mp4', 'mp4'),
      file('E2', 'report.docx', 'docx'),
      file('E3', 'ok.pdf', 'pdf'),
      file('E4', 'gone.pdf', 'pdf'),
      file('E5', 'huge.pdf', 'pdf'),
      file('E6', 'scan.pdf', 'pdf'), // 4th PDF: beyond the per-package PDF cap
    ];
    const { out, texts } = await run(files, {
      'scan.pdf': {
        buffer: fixture('blank.pdf'),
        contentType: 'application/pdf',
      },
      'huge.pdf': {
        buffer: Buffer.alloc(9 * 1024 * 1024, 1),
        contentType: 'application/pdf',
      },
      'ok.pdf': {
        buffer: fixture('register.pdf'),
        contentType: 'application/pdf',
      },
      'gone.pdf': null,
    });
    const reasons = Object.fromEntries(
      out.evidenceInspection!.notInspected.map((n) => [n.id, n.reason]),
    );
    expect(reasons.E1).toMatch(/cannot be read/);
    expect(reasons.E2).toMatch(/cannot be read/);
    expect(reasons.E4).toMatch(/could not be loaded/);
    expect(reasons.E5).toMatch(/too large/);
    expect(reasons.E6).toMatch(/only 3 PDF/);
    expect(out.evidenceInspection!.inspected).toEqual([
      { id: 'E3', name: 'ok.pdf' },
    ]);
    // the model is told, in the same request, which files it did not see
    expect(texts).toContain('Files NOT shown to you');
    expect(texts).toContain('E1 "clip.mp4"');
    expect(texts).toContain('Attendance register');
  });

  it('a scanned / unreadable PDF is reported as not read rather than silently skipped', async () => {
    const { out, texts } = await run([file('E1', 'scan.pdf', 'pdf')], {
      'scan.pdf': {
        buffer: fixture('blank.pdf'),
        contentType: 'application/pdf',
      },
    });
    expect(out.evidenceInspection!.inspected).toEqual([]);
    expect(out.evidenceInspection!.notInspected[0].reason).toMatch(
      /could not be read as text/,
    );
    expect(texts).toContain('E1 "scan.pdf"');
  });

  it('caps PDF documents per package and the text it reads', async () => {
    const files = [1, 2, 3, 4, 5].map((n) => file(`E${n}`, `d${n}.pdf`, 'pdf'));
    const store = Object.fromEntries(
      files.map((f) => [
        f.file_name,
        { buffer: fixture('register.pdf'), contentType: 'application/pdf' },
      ]),
    );
    const { out } = await run(files, store);
    expect(out.evidenceInspection!.inspected).toHaveLength(3);
    expect(
      out.evidenceInspection!.notInspected.filter((n) =>
        /only 3 PDF/.test(n.reason),
      ),
    ).toHaveLength(2);
  });

  it('a package with no evidence files still yields a clean, explicit status and a valid evaluation', async () => {
    const { out, texts } = await run([], {});
    expect(texts).toContain('EVIDENCE READ STATUS');
    expect(out.npeRanking?.readComplete).toBe(true);
    expect(out.evidenceInspection).toEqual({ inspected: [], notInspected: [] });
  });
});
