import {
  REDACTED_TOKEN_PLACEHOLDER,
  redactOpportunityContactDetails,
  redactOpportunitySecrets,
} from './opportunity-secrets.util';

describe('redactOpportunitySecrets', () => {
  it('replaces every magic-link credential (deeply) but keeps a non-empty "gate exists" flag', () => {
    const at = new Date('2026-01-01T00:00:00Z');
    const out = redactOpportunitySecrets({
      id: 'o1',
      createdAt: at,
      faculty_verification_token: 'f-tok',
      partnerToken: 'p-tok',
      liaisonToken: 'l-tok',
      execution_verification_token: 'e-tok',
      data: [{ partnerToken: 'nested', title: 'T' }],
      emptyToken: { partnerToken: null, faculty_verification_token: '' },
    });
    expect(out.faculty_verification_token).toBe(REDACTED_TOKEN_PLACEHOLDER);
    expect(out.partnerToken).toBe(REDACTED_TOKEN_PLACEHOLDER);
    expect(out.liaisonToken).toBe(REDACTED_TOKEN_PLACEHOLDER);
    expect(out.execution_verification_token).toBe(REDACTED_TOKEN_PLACEHOLDER);
    expect(out.data[0]).toEqual({
      partnerToken: REDACTED_TOKEN_PLACEHOLDER,
      title: 'T',
    });
    expect(out.emptyToken).toEqual({
      partnerToken: null,
      faculty_verification_token: '',
    });
    expect(out.createdAt).toBe(at);
    expect(JSON.stringify(out)).not.toMatch(/f-tok|p-tok|l-tok|e-tok|nested/);
  });

  it('does not mutate its input', () => {
    const src = { partnerToken: 'keep' };
    redactOpportunitySecrets(src);
    expect(src.partnerToken).toBe('keep');
  });
});

describe('redactOpportunityContactDetails', () => {
  it('drops third-party emails / whatsapp numbers / reviewer actor names but keeps names and content', () => {
    const out = redactOpportunityContactDetails({
      title: 'Clean-up',
      supervision: {
        contact: 'fac@uni.edu',
        supervisor_name: 'Dr X',
        whatsapp_e164: '+923001234567',
        partner_email: 'p@org.org',
      },
      partner_organization: {
        organization_name: 'Org',
        official_email: 'o@org.org',
      },
      detail_view: {
        supervision: {
          faculty: { name: 'Dr X', email: 'fac@uni.edu', whatsapp: '+92' },
        },
      },
      approvalHistory: [
        {
          line: 'faculty',
          action: 'approved',
          actorId: 'u1',
          actorName: 'fac@uni.edu',
          at: 'x',
          version: 1,
        },
      ],
      creator: { name: 'N', email: null },
    }) as {
      title: string;
      supervision: Record<string, unknown>;
      partner_organization: Record<string, unknown>;
      approvalHistory: Record<string, unknown>[];
    };
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/fac@uni\.edu|p@org\.org|o@org\.org|\+92/);
    expect(out.supervision).toEqual({ supervisor_name: 'Dr X' });
    expect(out.partner_organization).toEqual({ organization_name: 'Org' });
    expect(out.approvalHistory[0]).toEqual({
      line: 'faculty',
      action: 'approved',
      at: 'x',
      version: 1,
    });
    expect(out.title).toBe('Clean-up');
  });

  it('only treats `contact` as an email inside `supervision`', () => {
    const out = redactOpportunityContactDetails({
      other: { contact: 'kept' },
      supervision: { contact: 'gone' },
    }) as {
      other: { contact?: string };
      supervision: { contact?: string };
    };
    expect(out.other.contact).toBe('kept');
    expect(out.supervision.contact).toBeUndefined();
  });
});

describe('redactOpportunityContactDetails — authorised partner_contact', () => {
  it('keeps only the display fields of the response-level partner_contact block, while every other contact key is still dropped', () => {
    const out = redactOpportunityContactDetails({
      success: true,
      data: {
        title: 'Clean-up',
        partner_contact: {
          organization_name: 'Green Trust',
          email: 'info@green.org',
          whatsapp: '+923001234567',
          phone: 'extra-field-must-not-leak',
        },
        supervision: { whatsapp_e164: '+923009998888', contact: 'fac@uni.edu' },
        executing_organization: { official_email: 'o@org.org' },
      },
    }) as { data: Record<string, unknown> };
    expect(out.data.partner_contact).toEqual({
      organization_name: 'Green Trust',
      email: 'info@green.org',
      whatsapp: '+923001234567',
    });
    expect(out.data.supervision).toEqual({});
    expect(out.data.executing_organization).toEqual({});
  });

  it('does not honour partner_contact anywhere else (list rows, nested objects, top level)', () => {
    const block = { email: 'x@y.org', whatsapp: '+923001234567' };
    const out = redactOpportunityContactDetails({
      partner_contact: block,
      data: [{ partner_contact: block }],
      other: { data: { partner_contact: block } },
    }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toMatch(/x@y\.org|923001234567/);
  });

  it('collapses an empty or malformed block to null', () => {
    const run = (pc: unknown) =>
      (
        redactOpportunityContactDetails({ data: { partner_contact: pc } }) as {
          data: { partner_contact: unknown };
        }
      ).data.partner_contact;
    expect(run(null)).toBeNull();
    expect(run('a@b.co')).toBeNull();
    expect(run([{ email: 'a@b.co' }])).toBeNull();
    expect(run({ organization_name: 'Only name' })).toBeNull();
  });
});
