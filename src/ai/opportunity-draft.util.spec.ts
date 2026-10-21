import {
  buildOpportunityDraftPrompt,
  parseOpportunityDraftResponse,
} from './opportunity-draft.util';

const goodResponse = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    title: 'SOS Classroom Upgradation',
    hook: 'Turn tired classrooms into bright learning spaces with SOS children.',
    summary:
      'Students will work with SOS instructors to create curriculum charts and refresh classroom furniture.',
    activity_types: ['Community Service', 'training / teaching', 'Painting'],
    mode: 'on site',
    schedule_notes:
      '1. Meet instructors\n2. Prepare charts\n3. Install and review',
    objective: 'Improve two SOS classrooms with curriculum-linked displays.',
    outputs: '12 teaching charts; 20 desks repainted',
    outcome: 'Host confirms the classrooms are in use.',
    beneficiary_types: ['Children', 'Aliens'],
    responsibilities: '• Plan with instructors\n• Prepare **charts**',
    skills: ['Teaching', 'Teamwork', 'Juggling'],
    prerequisites: 'Follow safeguarding rules.',
    resources: 'Materials to be confirmed.',
    feasibility_warning: '10 students × 16 hours = 160 student-hours.',
    primary_sdg: {
      sdg_id: '4',
      target_id: '4.a',
      indicator_id: '4.a.1',
      why: 'Better learning environments.',
      local_metric: 'Classrooms improved',
    },
    supporting_sdg: {
      sdg_id: 12,
      target_id: '12.5',
      indicator_id: '12.5.1',
      why: 'Reuse furniture.',
    },
    faculty_email: 'should-be-ignored@uni.edu',
    ...over,
  });

describe('buildOpportunityDraftPrompt', () => {
  it('passes the fixed facts and fences the notes as data, with personal details removed', () => {
    const prompt = buildOpportunityDraftPrompt({
      idea: 'sos kids classroom. call me 0300-1234567 or ali@uni.edu',
      title_hint: 'Classroom Upgradation',
      place: 'SOS Village, Lahore',
      team_mode: 'private_team',
      seats: 10,
      hours: 16,
      main_partner: 'SOS Children’s Villages',
    });
    expect(prompt).toContain('private team of up to 10 students');
    expect(prompt).toContain('Potential student-hours (places × hours): 160');
    expect(prompt).toContain('SOS Village, Lahore');
    expect(prompt).toContain('<<<NOTES');
    expect(prompt).toContain('SDG 9: 9.1 [9.1.1, 9.1.2]');
    expect(prompt).toMatch(/SDG 4: .*4\.a \[4\.a\.1\]/);
    expect(prompt).toContain('NOTES>>>');
    expect(prompt).toContain('[phone removed]');
    expect(prompt).toContain('[email removed]');
    expect(prompt).not.toContain('0300-1234567');
    expect(prompt).not.toContain('ali@uni.edu');
  });

  it('describes an open opportunity and missing facts honestly', () => {
    const prompt = buildOpportunityDraftPrompt({ idea: 'tree plantation' });
    expect(prompt).toContain('open opportunity');
    expect(prompt).toContain('Total places: not given');
    expect(prompt).toContain('Main partner organisation: none named');
  });
});

describe('parseOpportunityDraftResponse', () => {
  it('keeps only wizard options, canonical casing, and ignores unknown keys', () => {
    const f = parseOpportunityDraftResponse(goodResponse());
    expect(f).not.toBeNull();
    expect(f!.title).toBe('SOS Classroom Upgradation');
    expect(f!.activity_types).toEqual([
      'Community Service',
      'Training / Teaching',
    ]);
    expect(f!.mode).toBe('On site');
    expect(f!.beneficiary_types).toEqual(['Children']);
    expect(f!.skills).toEqual(['Teaching', 'Teamwork']);
    expect(f!.responsibilities).toBe(
      '• Plan with instructors\n• Prepare charts',
    );
    expect(f!.primary_sdg).toEqual({
      sdg_id: '4',
      target_id: '4.a',
      indicator_id: '4.a.1',
      why: 'Better learning environments.',
      local_metric: 'Classrooms improved',
    });
    expect(f!.supporting_sdg).toEqual({
      sdg_id: '12',
      target_id: '12.5',
      indicator_id: '12.5.1',
      why: 'Reuse furniture.',
    });
    expect(f).not.toHaveProperty('faculty_email');
  });

  it('drops SDG targets that do not belong to the SDG and a supporting SDG equal to the primary', () => {
    const f = parseOpportunityDraftResponse(
      goodResponse({
        primary_sdg: { sdg_id: '4', target_id: '10.2', why: 'x' },
        supporting_sdg: { sdg_id: '4', target_id: '4.1', why: 'dup' },
      }),
    );
    expect(f!.primary_sdg!.target_id).toBe('');
    expect(f!.supporting_sdg).toBeNull();
    const bad = parseOpportunityDraftResponse(
      goodResponse({ primary_sdg: { sdg_id: '18' }, mode: 'Underwater' }),
    );
    expect(bad!.primary_sdg).toBeNull();
    expect(bad!.supporting_sdg).toBeNull();
    expect(bad!.mode).toBe('');
  });

  it('keeps only catalog targets / indicators, so the SDG dropdowns can show them', () => {
    const f = parseOpportunityDraftResponse(
      goodResponse({
        primary_sdg: {
          sdg_id: '9',
          target_id: '9.C',
          indicator_id: '9.c.1',
          why: 'x',
        },
        supporting_sdg: {
          sdg_id: '4',
          target_id: '4.9',
          indicator_id: '4.9.1',
          why: 'y',
        },
      }),
    );
    expect(f!.primary_sdg).toMatchObject({
      sdg_id: '9',
      target_id: '9.c',
      indicator_id: '9.c.1',
    });
    // 4.9 is not an official target: both ids are dropped, the SDG itself is kept.
    expect(f!.supporting_sdg).toMatchObject({
      sdg_id: '4',
      target_id: '',
      indicator_id: '',
    });
    // An indicator that belongs to another target is dropped.
    const g = parseOpportunityDraftResponse(
      goodResponse({
        primary_sdg: { sdg_id: '4', target_id: '4.1', indicator_id: '4.a.1' },
      }),
    );
    expect(g!.primary_sdg).toMatchObject({
      target_id: '4.1',
      indicator_id: '',
    });
  });

  it('ignores object-prototype names as SDG ids instead of throwing', () => {
    for (const bad of [
      'constructor',
      '__proto__',
      'toString',
      'hasOwnProperty',
    ]) {
      const f = parseOpportunityDraftResponse(
        goodResponse({
          primary_sdg: { sdg_id: '4', target_id: bad, indicator_id: bad },
          supporting_sdg: { sdg_id: '9', target_id: '9.1', indicator_id: bad },
        }),
      );
      expect(f!.primary_sdg).toMatchObject({ target_id: '', indicator_id: '' });
      expect(f!.supporting_sdg).toMatchObject({
        target_id: '9.1',
        indicator_id: '',
      });
    }
  });

  it('caps long text and scrubs personal details the model echoed back', () => {
    const f = parseOpportunityDraftResponse(
      goodResponse({
        title: 'word '.repeat(80),
        summary: 'Contact 0300-1234567 for details. ' + 'x'.repeat(900),
      }),
    );
    expect(f!.title.length).toBeLessThanOrEqual(200);
    expect(f!.summary.length).toBeLessThanOrEqual(520);
    expect(f!.summary).toContain('[phone removed]');
  });

  it('accepts JSON wrapped in a code fence or prose', () => {
    const f = parseOpportunityDraftResponse(
      'Here you go:\n```json\n' + goodResponse() + '\n```',
    );
    expect(f?.title).toBe('SOS Classroom Upgradation');
  });

  it('returns null for unusable responses', () => {
    expect(parseOpportunityDraftResponse('not json')).toBeNull();
    expect(parseOpportunityDraftResponse('[1,2,3]')).toBeNull();
    expect(
      parseOpportunityDraftResponse(goodResponse({ title: '' })),
    ).toBeNull();
    expect(
      parseOpportunityDraftResponse(goodResponse({ summary: 42 })),
    ).toBeNull();
  });
});
