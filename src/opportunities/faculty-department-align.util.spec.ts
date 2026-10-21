import {
  alignFacultyDepartments,
  applyFacultyDepartments,
  collectFacultyEmails,
} from './faculty-department-align.util';

const opp = (dept: string, contact = 'Prof@uni.edu ') => ({
  id: 'o1',
  supervision: {
    contact,
    faculty_department: dept,
    supervisor_name: 'Zubair Ali',
  },
});

describe('faculty department alignment', () => {
  it('replaces the student-typed department with the registered faculty profile department', async () => {
    const body = { success: true, data: opp('BS Botany') };
    const query = jest.fn<Promise<any>, [string, unknown[]?]>();
    query.mockResolvedValue([
      { email: 'prof@uni.edu', dept: 'Computer Science' },
    ]);
    const ds = { query };
    await alignFacultyDepartments(body, ds);
    expect(body.data.supervision.faculty_department).toBe('Computer Science');
    expect(query.mock.calls[0][1]).toEqual([['prof@uni.edu']]);
  });

  it('works on lists, nested payloads and the detail-view faculty block', () => {
    const body = {
      items: [opp('A', 'a@u.edu'), opp('B', 'b@u.edu')],
      detail: {
        supervision: {
          faculty: { email: 'A@u.edu', department: 'BS Botany', name: 'x' },
        },
      },
    };
    expect(collectFacultyEmails(body).sort()).toEqual(['a@u.edu', 'b@u.edu']);
    applyFacultyDepartments(body, new Map([['a@u.edu', 'Physics']]));
    expect(body.items[0].supervision.faculty_department).toBe('Physics');
    expect(body.items[1].supervision.faculty_department).toBe('B'); // not a registered faculty -> untouched
    expect(body.detail.supervision.faculty.department).toBe('Physics');
  });

  it('leaves the stored value when the faculty is unknown or has no profile department', async () => {
    const body = { data: opp('BS Botany') };
    await alignFacultyDepartments(body, {
      query: jest.fn().mockResolvedValue([]),
    });
    expect(body.data.supervision.faculty_department).toBe('BS Botany');
  });

  it('never breaks the response when the lookup fails', async () => {
    const body = { data: opp('BS Botany') };
    await expect(
      alignFacultyDepartments(body, {
        query: jest.fn().mockRejectedValue(new Error('db down')),
      }),
    ).resolves.toBe(body);
    expect(body.data.supervision.faculty_department).toBe('BS Botany');
  });

  it('ignores bodies without any faculty email (no DB call)', async () => {
    const ds = { query: jest.fn() };
    await alignFacultyDepartments(
      { a: 1, b: [{ supervision: { faculty_department: 'x' } }] },
      ds,
    );
    expect(ds.query).not.toHaveBeenCalled();
  });
});
