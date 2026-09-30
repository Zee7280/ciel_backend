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
    expect(out.data[0]).toEqual({ partnerToken: REDACTED_TOKEN_PLACEHOLDER, title: 'T' });
    expect(out.emptyToken).toEqual({ partnerToken: null, faculty_verification_token: '' });
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
      partner_organization: { organization_name: 'Org', official_email: 'o@org.org' },
      detail_view: { supervision: { faculty: { name: 'Dr X', email: 'fac@uni.edu', whatsapp: '+92' } } },
      approvalHistory: [{ line: 'faculty', action: 'approved', actorId: 'u1', actorName: 'fac@uni.edu', at: 'x', version: 1 }],
      creator: { name: 'N', email: null },
    }) as any;
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/fac@uni\.edu|p@org\.org|o@org\.org|\+92/);
    expect(out.supervision).toEqual({ supervisor_name: 'Dr X' });
    expect(out.partner_organization).toEqual({ organization_name: 'Org' });
    expect(out.approvalHistory[0]).toEqual({ line: 'faculty', action: 'approved', at: 'x', version: 1 });
    expect(out.title).toBe('Clean-up');
  });

  it('only treats `contact` as an email inside `supervision`', () => {
    const out = redactOpportunityContactDetails({ other: { contact: 'kept' }, supervision: { contact: 'gone' } }) as any;
    expect(out.other.contact).toBe('kept');
    expect(out.supervision.contact).toBeUndefined();
  });
});
