import { ArgumentMetadata, ValidationPipe } from '@nestjs/common';
import { CreateOpportunityDto } from './create-opportunity.dto';

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
});

describe('CreateOpportunityDto — field bounds', () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true });
  const metadata: ArgumentMetadata = { type: 'body', metatype: CreateOpportunityDto };
  const base = { title: 'Ok', types: ['Community Service'], mode: 'Remote', verification_method: [] };

  it('rejects a title over 200 chars', async () => {
    await expect(pipe.transform({ ...base, title: 'x'.repeat(201) }, metadata)).rejects.toBeTruthy();
  });
  it('rejects zero volunteers and negative hours', async () => {
    await expect(pipe.transform({ ...base, timeline: { volunteers_required: 0 } }, metadata)).rejects.toBeTruthy();
    await expect(pipe.transform({ ...base, timeline: { expected_hours: -1 } }, metadata)).rejects.toBeTruthy();
  });
  it('accepts unicode/emoji titles and in-range numbers', async () => {
    const r: any = await pipe.transform(
      { ...base, title: 'صفائی مہم 🌳', timeline: { volunteers_required: 5, expected_hours: 10 } },
      metadata,
    );
    expect(r.title).toBe('صفائی مہم 🌳');
  });
});
