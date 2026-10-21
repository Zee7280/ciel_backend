import { StudentController } from './student.controller';
import { StudentsService } from './students.service';
import { StudentParticipationService } from './student-participation.service';
import { StudentReportsService } from '../reports/student-reports.service';
import { S3Service } from '../common/s3.service';
import { CreateOpportunityDto } from '../opportunities/dto/create-opportunity.dto';

type StudentRequest = Parameters<
  StudentController['createIndependentProject']
>[0];

const asRequest = (user: { id: string }) => ({ user }) as StudentRequest;
const asCreateDto = (dto: Record<string, unknown>) =>
  dto as unknown as CreateOpportunityDto;

function makeController() {
  const studentsService = {
    saveStudentOpportunityDraft: jest
      .fn()
      .mockResolvedValue({ success: true, data: { id: 'draft-1' } }),
    createStudentOpportunity: jest
      .fn<Promise<unknown>, [string, Partial<CreateOpportunityDto>]>()
      .mockResolvedValue({ success: true, data: { id: 'created-1' } }),
    updateStudentOpportunity: jest
      .fn()
      .mockResolvedValue({ success: true, data: { id: 'updated-1' } }),
  };
  const controller = new StudentController(
    studentsService as unknown as StudentsService,
    {} as StudentReportsService,
    {} as StudentParticipationService,
    {} as S3Service,
  );
  return { controller, studentsService };
}

describe('StudentController — student-created opportunity create/update', () => {
  // Regression test: StudentController's POST/PATCH `student/opportunity[/:id]` routes previously
  // had no draft-awareness at all, while a second controller (StudentOpportunitySingularController)
  // registered the exact same paths with the draft-save branch — but that controller lost route
  // resolution (module import order), making its draft branch permanently unreachable. A mid-wizard
  // "save draft" request would silently hit full-submission validation here instead and throw.

  it('routes a draft create (draft: true) to saveStudentOpportunityDraft, not the full-validation create', async () => {
    const { controller, studentsService } = makeController();

    await controller.createIndependentProject(
      asRequest({ id: 'student-1' }),
      asCreateDto({
        draft: true,
        title: 'Untitled',
      }),
    );

    expect(studentsService.saveStudentOpportunityDraft).toHaveBeenCalledWith(
      'student-1',
      null,
      expect.objectContaining({ draft: true }),
    );
    expect(studentsService.createStudentOpportunity).not.toHaveBeenCalled();
  });

  it('routes a non-draft create to the full-validation createStudentOpportunity', async () => {
    const { controller, studentsService } = makeController();

    await controller.createIndependentProject(
      asRequest({ id: 'student-1' }),
      asCreateDto({
        title: 'Complete submission',
      }),
    );

    expect(studentsService.createStudentOpportunity).toHaveBeenCalledWith(
      'student-1',
      expect.objectContaining({ title: 'Complete submission' }),
    );
    expect(studentsService.saveStudentOpportunityDraft).not.toHaveBeenCalled();
  });

  it('routes a draft update (draft: true) to saveStudentOpportunityDraft with the opportunity id', async () => {
    const { controller, studentsService } = makeController();

    await controller.updateIndependentProject(
      asRequest({ id: 'student-1' }),
      'opp-1',
      asCreateDto({
        draft: true,
        title: 'Still editing',
      }),
    );

    expect(studentsService.saveStudentOpportunityDraft).toHaveBeenCalledWith(
      'student-1',
      'opp-1',
      expect.objectContaining({ draft: true }),
    );
    expect(studentsService.updateStudentOpportunity).not.toHaveBeenCalled();
  });

  it('routes a non-draft update to the full-validation updateStudentOpportunity', async () => {
    const { controller, studentsService } = makeController();

    await controller.updateIndependentProject(
      asRequest({ id: 'student-1' }),
      'opp-1',
      asCreateDto({
        title: 'Final submission',
      }),
    );

    expect(studentsService.updateStudentOpportunity).toHaveBeenCalledWith(
      'student-1',
      'opp-1',
      expect.objectContaining({ title: 'Final submission' }),
    );
    expect(studentsService.saveStudentOpportunityDraft).not.toHaveBeenCalled();
  });

  it('strips draft from a full create so it cannot leak onto the opportunity row', async () => {
    const { controller, studentsService } = makeController();

    await controller.createIndependentProject(
      asRequest({ id: 'student-1' }),
      asCreateDto({
        draft: false,
        title: 'Complete submission',
      }),
    );

    const passed = studentsService.createStudentOpportunity.mock.calls[0][1];
    expect(passed.title).toBe('Complete submission');
    expect(passed.draft).toBeUndefined();
  });
});
