import {
  formatActivityDate,
  isPartnerEmailOnLog,
  partnerImpactFacts,
  partnerRecipients,
  type PartnerImpactLog,
} from './quick-impact-partner.util';

const log = (over: Partial<PartnerImpactLog> = {}): PartnerImpactLog => ({
  id: 'abcdef12-0000-0000-0000-000000000000',
  title: 'Pinktober awareness circle',
  activityType: 'Pinktober event',
  activityTypeOther: null,
  activityDate: '2026-11-03',
  location: 'Campus courtyard, Lahore',
  summary: 'We ran a desk.',
  sdg: 3,
  peopleReached: 40,
  peopleTarget: 35,
  host: 'BNU Health Society',
  hostEmail: 'Health@BNU.edu.pk',
  partners: [
    { name: 'Shaukat Khanum', email: 'info@skm.org.pk', contact: null },
    { name: 'No email org', email: null, contact: null },
    'Legacy name only',
  ],
  facultyEmail: 'dr@bnu.edu.pk',
  evidence: [{}, {}],
  participants: [
    { email: 'ayesha@bnu.edu.pk', present: true, minutes: 90 },
    { email: 'bilal@bnu.edu.pk', present: true, minutes: 75 },
    { email: 'sana@bnu.edu.pk', present: false, minutes: 0 },
  ],
  ...over,
});

describe('Quick Impact → partner recipients', () => {
  it('mails the host and every partner that has an email, once each, lower-cased', () => {
    expect(partnerRecipients(log())).toEqual([
      { email: 'health@bnu.edu.pk', name: 'BNU Health Society' },
      { email: 'info@skm.org.pk', name: 'Shaukat Khanum' },
    ]);
    const dup = log({
      partners: [{ name: 'Same', email: 'HEALTH@bnu.edu.pk', contact: null }],
    });
    expect(partnerRecipients(dup)).toHaveLength(1);
  });

  it('never mails a participant or the faculty reviewer, and skips malformed addresses', () => {
    const l = log({
      hostEmail: 'ayesha@bnu.edu.pk',
      partners: [
        { name: 'Faculty as partner', email: 'DR@bnu.edu.pk', contact: null },
        { name: 'Broken', email: 'not-an-email', contact: null },
        { name: 'Fine', email: 'ok@org.pk', contact: null },
      ],
    });
    expect(partnerRecipients(l)).toEqual([
      { email: 'ok@org.pk', name: 'Fine' },
    ]);
  });

  it('nobody to mail when no host or partner gave an email', () => {
    expect(partnerRecipients(log({ hostEmail: null, partners: [] }))).toEqual(
      [],
    );
  });

  it('matches a partner account to a log only by an address on it', () => {
    expect(isPartnerEmailOnLog(log(), 'HEALTH@bnu.edu.pk')).toBe(true);
    expect(isPartnerEmailOnLog(log(), 'info@skm.org.pk')).toBe(true);
    expect(isPartnerEmailOnLog(log(), 'ayesha@bnu.edu.pk')).toBe(false);
    expect(isPartnerEmailOnLog(log(), '')).toBe(false);
  });
});

describe('Quick Impact → partner facts', () => {
  it('counts credited hours and students, and carries no student names or contacts', () => {
    const facts = partnerImpactFacts(log());
    expect(facts).toMatchObject({
      title: 'Pinktober awareness circle',
      date: '3 Nov 2026',
      hours: 2.75,
      students: 2,
      peopleReached: 40,
      peopleTarget: 35,
      evidenceCount: 2,
      sdg: 3,
      sdgName: 'Good Health and Well-being',
      host: 'BNU Health Society',
      partners: ['Shaukat Khanum', 'No email org', 'Legacy name only'],
    });
    const text = JSON.stringify(facts);
    expect(text).not.toContain('ayesha');
    expect(text).not.toContain('@');
  });

  it('lists every goal, the main one first, with the main goal fields kept for older readers', () => {
    const facts = partnerImpactFacts(
      log({ sdg: 3, secondarySdgs: [13, 3, 7] }),
    );
    expect(facts.sdgs.map((g) => [g.n, g.main])).toEqual([
      [3, true],
      [13, false],
      [7, false],
    ]);
    expect(facts.sdgs[1]).toMatchObject({
      name: 'Climate Action',
      color: '#3f7e44',
    });
    expect(facts.sdg).toBe(3);
    expect(facts.sdgName).toBe('Good Health and Well-being');
    // No main but others: the first other is promoted; none at all: empty.
    expect(
      partnerImpactFacts(log({ sdg: null, secondarySdgs: [13] })).sdg,
    ).toBe(13);
    expect(partnerImpactFacts(log({ sdg: null })).sdgs).toEqual([]);
  });

  it('describes an "Other" activity with the student’s own words and tolerates a missing SDG', () => {
    const facts = partnerImpactFacts(
      log({
        activityType: 'Other service activity',
        activityTypeOther: 'Blood donation camp',
        sdg: null,
      }),
    );
    expect(facts.activityType).toBe('Other: Blood donation camp');
    expect(facts.sdg).toBeNull();
    expect(facts.sdgName).toBeNull();
  });

  it('formats dates and survives a bad one', () => {
    expect(formatActivityDate('2026-01-09')).toBe('9 Jan 2026');
    expect(formatActivityDate(null)).toBe('Date not recorded');
    expect(formatActivityDate('sometime')).toBe('sometime');
  });
});
