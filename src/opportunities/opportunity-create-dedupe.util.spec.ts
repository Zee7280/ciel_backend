import {
  createPayloadFingerprint,
  normalizeCreateTitle,
  stableStringify,
} from './opportunity-create-dedupe.util';

describe('opportunity-create-dedupe.util', () => {
  const base = { creatorId: 'u1', organizationId: 'o1' };

  it('stableStringify ignores key order and undefined fields', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: undefined } })).toBe(stableStringify({ a: { d: 2 }, b: 1 }));
  });

  it('same payload (any key order, title case / spacing) -> same fingerprint', () => {
    const a = createPayloadFingerprint({ ...base, body: { title: 'Beach  Cleanup', mode: 'Remote', x: [1, 2] } });
    const b = createPayloadFingerprint({ ...base, body: { x: [1, 2], mode: 'Remote', title: ' beach cleanup ' } });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('different payload, creator or organization -> different fingerprint', () => {
    const f = (o: object, body: Record<string, unknown> = { title: 't', mode: 'Remote' }) =>
      createPayloadFingerprint({ ...base, ...o, body });
    const ref = f({});
    expect(f({}, { title: 't', mode: 'Onsite' })).not.toBe(ref);
    expect(f({}, { title: 't2', mode: 'Remote' })).not.toBe(ref);
    expect(f({ creatorId: 'u2' })).not.toBe(ref);
    expect(f({ organizationId: null })).not.toBe(ref);
  });

  it('normalizeCreateTitle collapses whitespace and case', () => {
    expect(normalizeCreateTitle('  A   B\tC ')).toBe('a b c');
  });
});
