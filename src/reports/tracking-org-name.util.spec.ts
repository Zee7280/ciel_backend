import {
  isDisplayableOrgName,
  trackingOrganizationName,
} from './tracking-org-name.util';

describe('trackingOrganizationName', () => {
  it('keeps a real linked organization name', () => {
    expect(
      trackingOrganizationName({ organization: { name: 'NGO' } }),
    ).toBe('NGO');
  });

  it('hides create-form helper copy and N/A', () => {
    expect(
      isDisplayableOrgName(
        'add only if theres another organization connected (eg.SOS)',
      ),
    ).toBe(false);
    expect(isDisplayableOrgName('N/A')).toBe(false);
    expect(
      trackingOrganizationName({
        organization: {
          name: 'add only if theres another organization connected (eg.SOS)',
        },
      }),
    ).toBeNull();
  });

  it('prefers a real partner organization over helper linked-org text', () => {
    expect(
      trackingOrganizationName({
        organization: {
          name: 'add only if theres another organization connected (eg.SOS)',
        },
        partner_organization: { organization_name: "SOS Children's Villages" },
      }),
    ).toBe("SOS Children's Villages");
  });

  it('reads executing-context partner when linked org is empty', () => {
    expect(
      trackingOrganizationName({
        organization: { name: '' },
        executing_context: {
          partner: { organization_name: 'City Parks Trust' },
        },
      }),
    ).toBe('City Parks Trust');
  });
});
