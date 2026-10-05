import { AiService } from './ai.service';

const OK_BODY = JSON.stringify({ choices: [{ message: { content: 'Plain summary text' } }] });
const res = (status: number, body: string) => ({ ok: status >= 200 && status < 300, status, text: async () => body });

describe('AiService — OpenAI transport hardening', () => {
  const realFetch = global.fetch;
  const realKey = process.env.OPENAI_API_KEY;
  const realSummaryModel = process.env.OPENAI_SUMMARY_MODEL;
  const realCiiModel = process.env.OPENAI_CII_MODEL;
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'sk-test';
    delete process.env.OPENAI_SUMMARY_MODEL;
    delete process.env.OPENAI_CII_MODEL;
  });
  afterEach(() => {
    global.fetch = realFetch;
    process.env.OPENAI_API_KEY = realKey;
    if (realSummaryModel === undefined) delete process.env.OPENAI_SUMMARY_MODEL;
    else process.env.OPENAI_SUMMARY_MODEL = realSummaryModel;
    if (realCiiModel === undefined) delete process.env.OPENAI_CII_MODEL;
    else process.env.OPENAI_CII_MODEL = realCiiModel;
    jest.useRealTimers();
  });

  const run = (svc: AiService) => svc.summarize('section2_context_unknown_section', { x: 1 });

  it('passes an abort-signal timeout to every request', async () => {
    const f = jest.fn().mockResolvedValue(res(200, OK_BODY));
    global.fetch = f as never;
    await run(new AiService());
    expect(f.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    const sent = JSON.parse(f.mock.calls[0][1].body);
    expect(sent.model).toBe('gpt-5.4');
    expect(sent.reasoning_effort).toBeUndefined();
    expect(sent.response_format).toBeUndefined();
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

describe('AiService — CII v4.5 evaluation branch', () => {
  const realFetch = global.fetch;
  const realKey = process.env.OPENAI_API_KEY;
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'sk-test';
  });
  afterEach(() => {
    global.fetch = realFetch;
    process.env.OPENAI_API_KEY = realKey;
  });

  const DIMENSIONS: Array<[string, number]> = [
    ['1', 4], ['2', 5], ['3', 4], ['4A', 5], ['4B', 5],
    ['5', 4], ['6', 4], ['8', 4], ['9', 4],
  ];
  const CII_V45_JSON = JSON.stringify({
    frameworkVersion: '5.0',
    reportId: 'report-1',
    inputFingerprint: 'fp-1',
    inputCompleteness: {
      gaps: [],
      individualHours: [{ studentId: 's1', hours: 20, requiredHours: 16, verified: true, recordComplete: true }],
      mandatoryFieldsComplete: true,
    },
    claimInventory: [],
    evidenceAudit: [],
    sectionScores: DIMENSIONS.map(([dimension, count]) => ({
      dimension,
      criterionScores: Array.from({ length: count }, (_, i) => ({
        criterion: `c${i}`,
        anchor: 2,
        qualityAnchor: 2,
        verificationStatus: 'VERIFIED',
        sourceRefs: ['s1'],
        evidenceIds: [],
        reasoningSummary: 'Sound.',
        deductionReason: null,
      })),
    })),
    deductionLedger: [],
    extraMileUplift: { assessmentStatus: 'ASSESSED', items: [] },
    integrityPenalty: { points: 0, issues: [] },
    exceptionalFeature: null,
    adminReviewReasons: [],
    strengths: ['Good attendance.'],
    developmentPriorities: ['Add a baseline.'],
    analysisSummary: 'Sound.',
    evidenceSummary: 'Partially inspected.',
    studentFeedback: 'Good work.',
  });

  it('sends the v5.0 prompt/model and parses the response into ciiV45', async () => {
    const f = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: CII_V45_JSON } }] }) });
    global.fetch = f as never;

    const out = await new AiService().summarize('cii_v4_5_evaluation', {
      uploaded_evidence_files: [{ file_id: 'EV-001', file_name: 'a.jpg', file_type: 'jpg', url: 'https://bkt.s3.amazonaws.com/a.jpg' }],
    });

    const sent = JSON.parse(f.mock.calls[0][1].body);
    expect(sent.model).toBe('gpt-5.6-sol');
    expect(sent.reasoning_effort).toBe('low');
    expect(sent.max_completion_tokens).toBe(32000);
    expect(sent.response_format).toEqual({ type: 'json_object' });
    expect(sent.messages[0].content).toContain('CII AI ANALYSER v5.0');
    expect(JSON.stringify(sent.messages)).not.toContain('uploaded_evidence_files');
    expect(out.ciiV45?.frameworkVersion).toBe('5.0');
    expect(out.ciiV45?.sectionScores).toHaveLength(10);
    expect(out.ciiV45?.adminEvidenceAssessment).toEqual({ status: 'PENDING' });
  });

  it('never fetches or attaches evidence originals on the report-quality call', async () => {
    const s3 = { getObjectBufferByPublicUrl: jest.fn() };
    const f = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: CII_V45_JSON } }] }) });
    global.fetch = f as never;

    const out = await new AiService(s3 as never).summarize(
      'cii_v4_5_evaluation',
      { uploaded_evidence_files: [{ file_id: 'EV-001', file_name: 'a.jpg', file_type: 'jpg', url: 'https://bkt.s3.amazonaws.com/a.jpg' }] },
    );

    expect(s3.getObjectBufferByPublicUrl).not.toHaveBeenCalled();
    const sent = JSON.parse(f.mock.calls[0][1].body);
    expect(typeof sent.messages[1].content).toBe('string');
    expect(sent.messages[1].content).toContain('EVIDENCE FIREWALL');
    expect(out.evidenceInspection?.inspected).toEqual([]);
    expect(out.ciiV45?.frameworkVersion).toBe('5.0');
  });

  it('rejects with a 502 when the model returns an unparseable CII v4.5 response', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '{not json' } }] }) }) as never;

    await expect(
      new AiService().summarize('cii_v4_5_evaluation', { uploaded_evidence_files: [] }),
    ).rejects.toMatchObject({ status: 502 });
  });

  it('does not attach evidence images even when files are present on the payload', async () => {
    const bucketImg = 'https://bkt.s3.eu.amazonaws.com/evidence/a.jpg';
    const s3 = { getObjectBufferByPublicUrl: jest.fn() };
    const f = jest.fn().mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: CII_V45_JSON } }] }) });
    global.fetch = f as never;

    const out = await new AiService(s3 as never).summarize('cii_v4_5_evaluation', {
      uploaded_evidence_files: [
        { file_id: 'E1', file_name: 'a.jpg', file_type: 'jpg', url: bucketImg },
        { file_id: 'E2', file_name: 'register.pdf', file_type: 'pdf', url: 'https://bkt.s3.eu.amazonaws.com/evidence/r.pdf' },
      ],
    });

    expect(s3.getObjectBufferByPublicUrl).not.toHaveBeenCalled();
    const userContent = JSON.parse(f.mock.calls[0][1].body).messages[1].content;
    expect(typeof userContent).toBe('string');
    expect(userContent).toContain('EVIDENCE FIREWALL');
    expect(out.evidenceInspection?.inspected).toEqual([]);
    expect(out.evidenceInspection?.notInspected).toEqual([]);
  });

  it('parses CII JSON from array-shaped message content', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [{ message: { content: [{ type: 'text', text: CII_V45_JSON }] } }],
        }),
    }) as never;
    const out = await new AiService().summarize('cii_v4_5_evaluation', { uploaded_evidence_files: [] });
    expect(out.ciiV45?.frameworkVersion).toBe('5.0');
  });

  it('retries empty length once without images and with a larger token budget', async () => {
    const bucketImg = 'https://bkt.s3.eu.amazonaws.com/evidence/a.jpg';
    const s3 = {
      getObjectBufferByPublicUrl: jest.fn(async () => ({ buffer: Buffer.from('JPEGDATA'), contentType: 'image/jpeg' })),
    };
    const empty = JSON.stringify({
      choices: [{ finish_reason: 'length', message: { content: '' } }],
    });
    const ok = JSON.stringify({ choices: [{ message: { content: CII_V45_JSON } }] });
    const f = jest.fn().mockResolvedValueOnce(res(200, empty)).mockResolvedValueOnce(res(200, ok));
    global.fetch = f as never;

    const out = await new AiService(s3 as never).summarize('cii_v4_5_evaluation', {
      uploaded_evidence_files: [{ file_id: 'E1', file_name: 'a.jpg', file_type: 'jpg', url: bucketImg }],
    });

    expect(out.ciiV45?.frameworkVersion).toBe('5.0');
    expect(f).toHaveBeenCalledTimes(2);
    const first = JSON.parse(f.mock.calls[0][1].body);
    const second = JSON.parse(f.mock.calls[1][1].body);
    expect(first.max_completion_tokens).toBe(32000);
    expect(typeof first.messages[1].content).toBe('string');
    expect(second.max_completion_tokens).toBe(48000);
    expect(second.reasoning_effort).toBe('low');
    expect(typeof second.messages[1].content).toBe('string');
  });

  it('surfaces a token-budget error when the retry is also empty', async () => {
    const empty = JSON.stringify({
      choices: [{ finish_reason: 'length', message: { content: null } }],
    });
    global.fetch = jest.fn().mockResolvedValue(res(200, empty)) as never;
    await expect(
      new AiService().summarize('cii_v4_5_evaluation', { uploaded_evidence_files: [] }),
    ).rejects.toMatchObject({
      status: 500,
      response: { error: expect.stringContaining('token budget') },
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
