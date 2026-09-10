import { StudentController } from './student.controller';

function makeController() {
  const studentsService = {
    saveStudentOpportunityDraft: jest
      .fn()
      .mockResolvedValue({ success: true, data: { id: 'draft-1' } }),
    createStudentOpportunity: jest
      .fn()
      .mockResolvedValue({ success: true, data: { id: 'created-1' } }),
    updateStudentOpportunity: jest
      .fn()
      .mockResolvedValue({ success: true, data: { id: 'updated-1' } }),
  };
  const controller = new StudentController(
    studentsService as any,
    {} as any,
    {} as any,
    {} as any,
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
      { user: { id: 'student-1' } } as any,
      {
        draft: true,
        title: 'Untitled',
      } as any,
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
      { user: { id: 'student-1' } } as any,
      {
        title: 'Complete submission',
      } as any,
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
      { user: { id: 'student-1' } } as any,
      'opp-1',
      {
        draft: true,
        title: 'Still editing',
      } as any,
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
      { user: { id: 'student-1' } } as any,
      'opp-1',
      {
        title: 'Final submission',
      } as any,
    );

    expect(studentsService.updateStudentOpportunity).toHaveBeenCalledWith(
      'student-1',
      'opp-1',
      expect.objectContaining({ title: 'Final submission' }),
    );
    expect(studentsService.saveStudentOpportunityDraft).not.toHaveBeenCalled();
  });
});
