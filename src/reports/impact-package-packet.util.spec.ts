import { BadRequestException } from '@nestjs/common';
import {
  assertPacketReadyForAnalysis,
  buildCanonicalImpactPacket,
  IMPACT_PACKAGE_SYNC_CONTRACT,
  validateImpactPackagePacket,
} from './impact-package-packet.util';

const complete = {
  id: 'rep-1',
  opportunityId: 'opp-1',
  project_id: 'opp-1',
  status: 'submitted',
  reportSubmittedAt: new Date('2026-10-06T10:00:00.000Z'),
  opportunity: { title: 'SOS Classroom Learning' },
  section1: { participation_type: 'team' },
  section2: { problem_statement: 'Need' },
  section3: { contribution_intent_statement: 'SDG' },
  section4: { activity_blocks: [{ title: 'Session' }] },
  section5: { observed_change: 'Change' },
  section6: { use_resources: 'no' },
  section7: { has_partners: 'no' },
  section8: { evidence_files: [{ url: 'https://cdn.example/a.jpg', name: 'a.jpg' }] },
  section9: { reflection_biggest_learning: 'Learned' },
  section10: { continuation_status: 'yes' },
};

describe('impact-package-packet.util', () => {
  it('passes a complete 9-section student packet and counts evidence', () => {
    const v = validateImpactPackagePacket(complete);
    expect(v.ok).toBe(true);
    expect(v.content_sections).toBe(9);
    expect(v.evidence_files).toBe(1);
    expect(v.answer_fields).toBeGreaterThan(0);
  });

  it('HOLDs when a mapped content section is missing', () => {
    const { section3: _drop, ...broken } = complete;
    const v = validateImpactPackagePacket(broken);
    expect(v.ok).toBe(false);
    expect(v.issues.some((issue) => /section 3/i.test(issue))).toBe(true);
    expect(() => assertPacketReadyForAnalysis(broken)).toThrow(BadRequestException);
  });

  it('treats empty section objects as present so submitted shells still analyse', () => {
    const v = validateImpactPackagePacket({
      id: 'r',
      section1: {},
      section2: {},
      section3: {},
      section4: {},
      section5: {},
      section6: {},
      section7: {},
      section8: {},
      section9: {},
      section10: {},
    });
    expect(v.ok).toBe(true);
    expect(v.content_sections).toBe(9);
  });

  it('builds the canonical packet Admin/analyser consume', () => {
    const packet = buildCanonicalImpactPacket(complete as never);
    expect(packet.schema_version).toBe(IMPACT_PACKAGE_SYNC_CONTRACT.schema_version);
    expect(packet.flashcard.title).toBe('SOS Classroom Learning');
    expect(packet.detailed_report.sections).toHaveLength(9);
    expect(packet.detailed_report.sections[3]).toMatchObject({
      id: '4',
      source: ['section4', 'section5'],
      present: true,
    });
    expect(packet.evidence.files).toHaveLength(1);
    expect(packet.signoff.final_authority).toBe('CIEL PK Super Admin');
    expect(packet.packet_integrity.ok).toBe(true);
  });
});
