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
