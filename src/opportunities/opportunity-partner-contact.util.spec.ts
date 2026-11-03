import {
  isPartnerCreatedOpportunity,
  resolvePartnerContact,
} from './opportunity-partner-contact.util';

describe('opportunity partner contact', () => {
  const partnerOpp = {
    organizationId: 'org-1',
    executing_organization: {
      name: 'Green Pakistan Trust',
      official_email: 'Info@GreenPK.org ',
    },
    supervision: { whatsapp_e164: '+923001234567' },
    organization: {
      name: 'Profile Org',
      contactEmail: 'profile@org.pk',
      contactPhone: '+923111111111',
    },
  };

  it('recognises partner-created listings and nothing else', () => {
    expect(
      isPartnerCreatedOpportunity({ organizationId: 'o' }, 'partner'),
    ).toBe(true);
    expect(isPartnerCreatedOpportunity({ organizationId: 'o' }, 'ngo')).toBe(
      true,
    );
    expect(isPartnerCreatedOpportunity({ organizationId: 'o' })).toBe(true);
    expect(
      isPartnerCreatedOpportunity({ isStudentCreated: true }, 'student'),
    ).toBe(false);
    expect(
      isPartnerCreatedOpportunity({
        isStudentCreated: true,
        organizationId: 'o',
      }),
    ).toBe(false);
    expect(isPartnerCreatedOpportunity({ facultyId: 'f' }, 'faculty')).toBe(
      false,
    );
    expect(isPartnerCreatedOpportunity({ facultyId: 'f' })).toBe(false);
    expect(isPartnerCreatedOpportunity({ organizationId: 'o' }, 'admin')).toBe(
      false,
    );
    expect(isPartnerCreatedOpportunity({})).toBe(false);
  });

  it("prefers the request form's contact, lower-cased and trimmed", () => {
    expect(
      resolvePartnerContact(partnerOpp, {
        role: 'partner',
        email: 'owner@x.pk',
        phone: '+92300000000',
      }),
    ).toEqual({
      organization_name: 'Green Pakistan Trust',
      email: 'info@greenpk.org',
      whatsapp: '+923001234567',
    });
  });

  it('falls back to the organisation profile, then to the creator account', () => {
    const noForm = {
      organizationId: 'org-1',
      organization: partnerOpp.organization,
    };
    expect(
      resolvePartnerContact(noForm, {
        role: 'partner',
        email: 'owner@x.pk',
        phone: '+92300000000',
      }),
    ).toEqual({
      organization_name: 'Profile Org',
      email: 'profile@org.pk',
      whatsapp: '+923111111111',
    });
    expect(
      resolvePartnerContact(
        { organizationId: 'org-1' },
        { role: 'partner', email: 'owner@x.pk', phone: '+92300000000' },
      ),
    ).toEqual({
      organization_name: null,
      email: 'owner@x.pk',
      whatsapp: '+92300000000',
    });
  });

  it('ignores an invalid email and a bare supervision contact that is not an email', () => {
    const r = resolvePartnerContact(
      {
        organizationId: 'o',
        executing_organization: { official_email: 'not-an-email' },
        supervision: { contact: '0300 111' },
      },
      { role: 'partner', email: null, phone: null },
    );
    expect(r).toBeNull();
  });

  it('returns null for student, faculty and admin listings, and when no contact exists', () => {
    expect(
      resolvePartnerContact(
        {
          isStudentCreated: true,
          executing_organization: { official_email: 'a@b.co' },
        },
        { role: 'student', email: 'a@b.co' },
      ),
    ).toBeNull();
    expect(
      resolvePartnerContact(
        { facultyId: 'f', supervision: { whatsapp_e164: '+923001234567' } },
        { role: 'faculty', email: 'f@u.pk' },
      ),
    ).toBeNull();
    expect(
      resolvePartnerContact(
        {
          organizationId: 'o',
          executing_organization: { official_email: 'a@b.co' },
        },
        { role: 'admin', email: 'x@y.co' },
      ),
    ).toBeNull();
    expect(resolvePartnerContact({ organizationId: 'o' }, null)).toBeNull();
  });
});
