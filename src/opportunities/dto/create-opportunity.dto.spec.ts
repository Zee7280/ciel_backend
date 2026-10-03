import { ArgumentMetadata, ValidationPipe } from '@nestjs/common';
import { CreateOpportunityDto, UpdateOpportunityDto } from './create-opportunity.dto';

describe('CreateOpportunityDto — draft flag survives whitelist', () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true });
  const metadata: ArgumentMetadata = {
    type: 'body',
    metatype: CreateOpportunityDto,
  };

  it('keeps draft:true so StudentController can route to saveStudentOpportunityDraft', async () => {
    const result = (await pipe.transform(
      {
        draft: true,
        title: 'Campus cleanup',
        types: ['Community Service'],
        mode: 'On site',
        verification_method: [],
      },
      metadata,
    )) as CreateOpportunityDto;

    expect(result.draft).toBe(true);
    expect(result.title).toBe('Campus cleanup');
  });

  it('still requires types/mode/verification_method for a non-draft create', async () => {
    await expect(
      pipe.transform({ title: 'Only title' }, metadata),
    ).rejects.toBeTruthy();
  });

  it('does not require types/mode/verification_method when draft:true', async () => {
    const result = (await pipe.transform(
      { draft: true, title: 'Untitled opportunity' },
      metadata,
    )) as CreateOpportunityDto;
    expect(result.draft).toBe(true);
    expect(result.title).toBe('Untitled opportunity');
  });

  it('accepts a first-step wizard Save draft payload (incomplete form, draft:true)', async () => {
    const firstStepDraft = {
      draft: true,
      title: 'Untitled opportunity',
      types: [],
      student_contact: '',
      mode: '',
      location: { city: '', venue: '', pin: '', mapSearch: '', mapLink: '' },
      timeline: {
        type: 'Fixed dates',
        start_date: '',
        end_date: '',
        close_applications_early: false,
        application_deadline: null,
        expected_hours: 0,
        volunteers_required: 0,
      },
      sdg_info: {
        sdg_id: '',
        target_id: '',
        indicator_id: '',
        sub_indicator_id: '',
        why_relevant: '',
      },
      objectives: {
        description: '',
        summary: '',
        hook: '',
        outputs: '',
        beneficiaries_count: 0,
        beneficiaries_type: [],
      },
      activity_details: {
        student_responsibilities: '',
        skills_gained: [],
      },
      supervision: {
        supervisor_name: '',
        role: '',
        contact: '',
        faculty_department: '',
        faculty_university_name: 'Beaconhouse National University (BNU)',
        private_candidate: false,
        electronic_signature: '',
        safe_environment: false,
        supervised: false,
        information_accurate: false,
      },
      external_partner_collaboration: null,
      executing_context: {
        type: 'independent',
        student_pathway: 'university',
        independent_community_activity: {
          activity_site_description: 'Student-organized community activity',
          local_contact_person: 'FATIMA KHALID',
          contact_number: '',
        },
      },
      safety_declaration: {
        environment_safe_and_appropriate: false,
        students_guided_and_supervised: false,
        lawful_ethical_and_non_hazardous: false,
        precautions_and_basic_safety: false,
      },
      submission_confirmations: {
        academically_valid_and_accurately_described: false,
        activity_properly_supervised: false,
        environment_safe_and_appropriate: false,
        information_correct_and_verifiable: false,
      },
      participation_scope: {
        rule: 'own_university_only',
        apply_scope: 'student_uni_all',
        creator_university_name: 'Beaconhouse National University (BNU)',
        university_names: ['Beaconhouse National University (BNU)'],
        department_restriction: {
          scope: 'all',
          departments: [],
          sections_or_class_note: null,
        },
      },
      verification_method: [],
      visibility: 'restricted',
      restricted_universities: ['Beaconhouse National University (BNU)'],
    };

    const result = (await pipe.transform(
      firstStepDraft,
      metadata,
    )) as CreateOpportunityDto;

    expect(result.draft).toBe(true);
    expect(result.title).toBe('Untitled opportunity');
  });
});

describe('CreateOpportunityDto / UpdateOpportunityDto — hardened validation', () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true });
  const create = { type: 'body', metatype: CreateOpportunityDto } as ArgumentMetadata;
  const update = { type: 'body', metatype: UpdateOpportunityDto } as ArgumentMetadata;
  const full = {
    title: 'Campus cleanup',
    types: ['Community Service'],
    mode: 'Remote',
    verification_method: [],
    timeline: { expected_hours: 16, volunteers_required: 10 },
  };

  it('accepts a valid full submit', async () => {
    await expect(pipe.transform(full, create)).resolves.toBeTruthy();
  });

  it.each([
    ['blank title', { title: '   ' }],
    ['empty title', { title: '' }],
    ['no types', { types: [] }],
    ['empty mode', { mode: '' }],
    ['negative hours', { timeline: { expected_hours: -5 } }],
    ['zero hours', { timeline: { expected_hours: 0 } }],
    ['hours over cap', { timeline: { expected_hours: 501 } }],
    ['zero seats', { timeline: { volunteers_required: 0 } }],
    ['seats over cap', { timeline: { volunteers_required: 5001 } }],
  ])('rejects a full submit with %s', async (_label, patch) => {
    await expect(pipe.transform({ ...full, ...patch }, create)).rejects.toBeTruthy();
  });

  it('still lets an incomplete draft through (0 hours / empty title)', async () => {
    await expect(
      pipe.transform(
        { draft: true, title: '', types: [], mode: '', timeline: { expected_hours: 0, volunteers_required: 0 } },
        create,
      ),
    ).resolves.toBeTruthy();
  });

  it('UpdateOpportunityDto no longer accepts status / sdg / admin_approval_required', async () => {
    const out = (await pipe.transform(
      { id: 'o1', title: 'x', status: 'active', sdg: 'forged', admin_approval_required: false },
      update,
    )) as Record<string, unknown>;
    expect(out).not.toHaveProperty('status');
    expect(out).not.toHaveProperty('sdg');
    expect(out).not.toHaveProperty('admin_approval_required');
    expect(out.title).toBe('x');
  });
});
