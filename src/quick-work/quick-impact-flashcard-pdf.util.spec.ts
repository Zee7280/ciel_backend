import { quickImpactFlashcardPdf } from './quick-impact-flashcard-pdf.util';
import {
  partnerImpactFacts,
  type PartnerImpactLog,
} from './quick-impact-partner.util';

const base: PartnerImpactLog = {
  id: 'abcdef12-0000-0000-0000-000000000000',
  title: 'Pinktober awareness circle',
  activityType: 'Pinktober event',
  activityDate: '2026-11-03',
  location: 'Campus courtyard, Lahore',
  summary: 'We ran a desk. Shared leaflets.',
  sdg: 3,
  peopleReached: 40,
  peopleTarget: 35,
  host: 'BNU Health Society',
  hostEmail: null,
  partners: ['Shaukat Khanum'],
  facultyEmail: 'dr@bnu.edu.pk',
  evidence: [{}],
  participants: [{ email: 'a@bnu.edu.pk', present: true, minutes: 90 }],
};

describe('Quick Impact flashcard PDF', () => {
  it('renders a real one-page PDF', async () => {
    const pdf = await quickImpactFlashcardPdf(partnerImpactFacts(base), {
      partnerName: 'BNU Health Society',
    });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(1500);
    expect(
      (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length,
    ).toBe(1);
  });

  it('renders a main goal plus up to four others on one page', async () => {
    const pdf = await quickImpactFlashcardPdf(
      partnerImpactFacts({ ...base, sdg: 3, secondarySdgs: [13, 7, 11, 15] }),
    );
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(
      (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length,
    ).toBe(1);
  });

  it('does not throw on empty, very long or non-Latin text and with no SDG or target', async () => {
    const facts = partnerImpactFacts({
      ...base,
      title: 'T'.repeat(400),
      summary: 'لمبا متن '.repeat(800),
      sdg: null,
      peopleTarget: null,
      peopleReached: null,
      host: null,
      partners: [],
    });
    const pdf = await quickImpactFlashcardPdf(facts);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const empty = await quickImpactFlashcardPdf(
      partnerImpactFacts({ ...base, summary: '', location: '', title: '' }),
    );
    expect(empty.length).toBeGreaterThan(1000);
  });
});
