import {
  attestationSufficient,
  findPersonalFields,
  validateEnvelope,
} from './envelope.util';

const CONN = '11111111-2222-4333-8444-555555555555';

function base(over: Record<string, unknown> = {}) {
  return {
    schema_version: '1.0',
    event_id: 'evt-1',
    event_type: 'activity.session',
    connection_id: CONN,
    occurred_at: '2026-10-03T09:00:00+05:00',
    activity: {
      external_id: 'plant-7',
      type: 'plantation',
      title: 'Lahore drive',
    },
    payload: { location: 'Lahore', session_hours: 4, participants_count: 8 },
    metrics: [{ code: 'trees_planted', value: 40 }],
    ...over,
  };
}

describe('validateEnvelope', () => {
  it('accepts a well-formed event and normalizes it', () => {
    const r = validateEnvelope(base());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.occurred_at).toBe('2026-10-03T04:00:00.000Z');
      expect(r.value.correlation).toEqual({ corrects: null, voids: null });
      expect(r.value.metrics?.[0]).toEqual({
        code: 'trees_planted',
        value: 40,
      });
      expect(r.bytes).toBeGreaterThan(50);
    }
  });

  it('reports every structural problem at once', () => {
    const r = validateEnvelope({
      event_type: 'nope',
      connection_id: 'x',
      occurred_at: 'yesterday',
      activity: {},
      metrics: [{ code: 1 }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('ENVELOPE_INVALID');
      expect(r.errors.join('\n')).toMatch(/event_id/);
      expect(r.errors.join('\n')).toMatch(/schema_version/);
      expect(r.errors.join('\n')).toMatch(/event_type/);
      expect(r.errors.join('\n')).toMatch(/connection_id/);
      expect(r.errors.join('\n')).toMatch(/occurred_at/);
      expect(r.errors.join('\n')).toMatch(/external_id/);
      expect(r.errors.join('\n')).toMatch(/metrics\[0\]/);
    }
  });

  it('requires correlation.corrects for corrections', () => {
    const r = validateEnvelope(base({ event_type: 'activity.corrected' }));
    expect(r.ok).toBe(false);
    const ok = validateEnvelope(
      base({
        event_type: 'activity.corrected',
        correlation: { corrects: 'evt-0' },
      }),
    );
    expect(ok.ok).toBe(true);
  });

  it('rejects non-object payloads and oversized events', () => {
    expect(validateEnvelope(base({ payload: 'x' })).ok).toBe(false);
    const big = validateEnvelope(
      base({ payload: { blob: 'x'.repeat(70_000) } }),
    );
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.code).toBe('EVENT_TOO_LARGE');
  });
});

describe('findPersonalFields', () => {
  it('flags personal keys and personal-looking values at any depth', () => {
    expect(
      findPersonalFields({
        participants_count: 8,
        participants: [{ student_name: 'A', hours: 4 }],
        contact: { email_address: 'x@y.com' },
        note: 'reach me at someone@example.org',
        ref: '35202-1234567-1',
      }),
    ).toEqual([
      'participants.0.student_name',
      'contact.email_address',
      'note',
      'ref',
    ]);
    expect(findPersonalFields({ trees: 40, location: 'Lahore' })).toEqual([]);
    // Vendor domain fields that merely contain "name" are not personal.
    expect(
      findPersonalFields({
        site_name: 'Model Town Park',
        species_name: 'Neem',
        organizer: { team_name: 'Green Squad' },
      }),
    ).toEqual([]);
    expect(findPersonalFields({ name: 'Ali', volunteer_name: 'B' })).toEqual([
      'name',
      'volunteer_name',
    ]);
  });
});

describe('attestationSufficient', () => {
  it('needs lawful basis and a consent reference', () => {
    expect(attestationSufficient(undefined)).toBe(false);
    expect(attestationSufficient({ lawful_basis: 'consent' })).toBe(false);
    expect(
      attestationSufficient({ lawful_basis: 'consent', consent_ref: 'C-1' }),
    ).toBe(true);
  });
});
