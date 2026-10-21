import { ArgumentMetadata, ValidationPipe } from '@nestjs/common';
import { OpportunityDraftDto } from './opportunity-draft.dto';

describe('OpportunityDraftDto', () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true });
  const metadata: ArgumentMetadata = {
    type: 'body',
    metatype: OpportunityDraftDto,
  };

  it('accepts a full brainstorm and drops unknown keys', async () => {
    const dto = (await pipe.transform(
      {
        idea: 'sos kids classroom upgrade',
        title_hint: 'Classroom Upgradation',
        place: 'Lahore',
        team_mode: 'private_team',
        seats: 10,
        hours: 16,
        beneficiaries: '30',
        main_partner: 'SOS',
        start_date: '2026-10-22',
        end_date: '2026-12-31',
        creator_pathway: 'university',
        faculty_email: 'x@uni.edu',
      },
      metadata,
    )) as OpportunityDraftDto & { faculty_email?: string };
    expect(dto.seats).toBe(10);
    expect(dto.faculty_email).toBeUndefined();
  });

  it.each([
    [{ idea: 'ab' }],
    [{ idea: 'x'.repeat(4001) }],
    [{ idea: 'tree plantation', seats: 0 }],
    [{ idea: 'tree plantation', hours: 501 }],
    [{ idea: 'tree plantation', team_mode: 'private' }],
    [{ idea: 'tree plantation', start_date: '22/10/2026' }],
  ])('rejects %j', async (body) => {
    await expect(pipe.transform(body, metadata)).rejects.toBeTruthy();
  });
});
