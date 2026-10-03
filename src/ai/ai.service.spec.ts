import { AiService } from './ai.service';

const OK_BODY = JSON.stringify({ choices: [{ message: { content: 'Plain summary text' } }] });
const res = (status: number, body: string) => ({ ok: status >= 200 && status < 300, status, text: async () => body });

describe('AiService — OpenAI transport hardening', () => {
  const realFetch = global.fetch;
  const realKey = process.env.OPENAI_API_KEY;
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'sk-test';
  });
  afterEach(() => {
    global.fetch = realFetch;
    process.env.OPENAI_API_KEY = realKey;
    jest.useRealTimers();
  });

  const run = (svc: AiService) => svc.summarize('section2_context_unknown_section', { x: 1 });

  it('passes an abort-signal timeout to every request', async () => {
    const f = jest.fn().mockResolvedValue(res(200, OK_BODY));
    global.fetch = f as never;
    await run(new AiService());
    expect(f.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('retries once on a 5xx and then succeeds', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const f = jest.fn().mockResolvedValueOnce(res(503, JSON.stringify({ error: { message: 'overloaded' } }))).mockResolvedValue(res(200, OK_BODY));
    global.fetch = f as never;
    const p = run(new AiService());
    await jest.advanceTimersByTimeAsync(2000);
    await expect(p).resolves.toMatchObject({ summary: 'Plain summary text' });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a 400 and reports the provider message', async () => {
    const f = jest.fn().mockResolvedValue(res(400, JSON.stringify({ error: { message: 'bad request' } })));
    global.fetch = f as never;
    await expect(run(new AiService())).rejects.toBeTruthy();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('a non-JSON (HTML) error page is reported, not a JSON parse crash', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const f = jest.fn().mockResolvedValue(res(502, '<html>Bad gateway</html>'));
    global.fetch = f as never;
    const p = run(new AiService());
    const assertion = expect(p).rejects.toBeTruthy();
    await jest.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(f).toHaveBeenCalledTimes(2); // 5xx retried once
  });

  it('a timeout is retried once, then surfaces a clear "took too long" error', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const timeoutErr = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const f = jest.fn().mockRejectedValue(timeoutErr);
    global.fetch = f as never;
    const p = run(new AiService());
    const assertion = expect(p).rejects.toBeTruthy();
    await jest.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe('AiService — CII v2 sees the real evidence images', () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'sk-test';
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  const CII_JSON = JSON.stringify({
    framework_version: 'v2.0',
    sections: [{ id: 1, criteria: [] }],
    bonus: {},
    integrityPenalty: 0,
    evidence: [],
    redFlags: [],
  });

  it('attaches bucket images as image_url parts, lists documents / unfetchable files as NOT inspected, never fetches foreign URLs', async () => {
    const bucketImg = 'https://bkt.s3.eu.amazonaws.com/evidence/a.jpg';
    const foreign = 'https://evil.example.com/steal.png';
    const s3 = {
      getObjectBufferByPublicUrl: jest.fn(async (url: string) =>
        url === bucketImg ? { buffer: Buffer.from('JPEGDATA'), contentType: 'image/jpeg' } : null,
      ),
    };
    const f = jest.fn().mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: CII_JSON } }] }) });
    global.fetch = f as never;
    const svc = new AiService(s3 as never);

    const out = await svc.summarize('cii_v2_evaluation', {
      uploaded_evidence_files: [
        { file_id: 'E1', file_name: 'a.jpg', file_type: 'jpg', url: bucketImg, linked_claims: ['Repaint day'] },
        { file_id: 'E2', file_name: 'register.pdf', file_type: 'pdf', url: 'https://bkt.s3.eu.amazonaws.com/evidence/r.pdf' },
        { file_id: 'E3', file_name: 'steal.png', file_type: 'png', url: foreign },
      ],
    });

    const sent = JSON.parse(f.mock.calls[0][1].body);
    const userContent = sent.messages[1].content;
    expect(Array.isArray(userContent)).toBe(true);
    const images = userContent.filter((p: any) => p.type === 'image_url');
    expect(images).toHaveLength(1);
    expect(images[0].image_url.url).toMatch(/^data:image\/jpeg;base64,/);
    expect(userContent[0].text).toMatch(/NOT shown/);
    expect(userContent[0].text).toMatch(/E2/);
    expect(s3.getObjectBufferByPublicUrl).toHaveBeenCalledWith(foreign); // refused by the S3 service (not our bucket)
    expect(out.evidenceInspection?.inspected.map((x) => x.id)).toEqual(['E1']);
    expect(out.evidenceInspection?.notInspected.map((x) => x.id).sort()).toEqual(['E2', 'E3']);
  });

  it('caps the number of inspected images', async () => {
    const urls = Array.from({ length: 12 }, (_, i) => `https://bkt.s3.eu.amazonaws.com/e/${i}.png`);
    const s3 = { getObjectBufferByPublicUrl: jest.fn(async () => ({ buffer: Buffer.from('x'), contentType: 'image/png' })) };
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: CII_JSON } }] }) }) as never;
    const out = await new AiService(s3 as never).summarize('cii_v2_evaluation', {
      uploaded_evidence_files: urls.map((url, i) => ({ file_id: `E${i}`, file_name: `${i}.png`, file_type: 'png', url })),
    });
    expect(out.evidenceInspection?.inspected).toHaveLength(8);
    expect(out.evidenceInspection?.notInspected).toHaveLength(4);
  });

  it('with no S3 service every image is reported as not inspected (the model is told so)', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: CII_JSON } }] }) }) as never;
    const out = await new AiService().summarize('cii_v2_evaluation', {
      uploaded_evidence_files: [{ file_id: 'E1', file_name: 'a.png', file_type: 'png', url: 'https://x/a.png' }],
    });
    expect(out.evidenceInspection?.inspected).toHaveLength(0);
    expect(out.evidenceInspection?.notInspected).toHaveLength(1);
  });
});
