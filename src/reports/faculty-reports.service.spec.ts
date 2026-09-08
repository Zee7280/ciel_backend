import { BadRequestException } from '@nestjs/common';
import { FacultyReportsService } from './faculty-reports.service';

function makeService(report: Record<string, unknown> | null) {
    const qb: any = {
        leftJoin: jest.fn(() => qb),
        where: jest.fn(() => qb),
        andWhere: jest.fn(() => qb),
        getOne: jest.fn(async () => report),
    };
    const studentReportsRepository = {
        createQueryBuilder: jest.fn(() => qb),
        save: jest.fn(async (row: Record<string, unknown>) => row),
    };
    const facultyService = {
        getScopedOpportunityIds: jest.fn().mockResolvedValue([]),
    };
    const service = new FacultyReportsService(
        studentReportsRepository as any,
        {} as any,
        facultyService as any,
    );
    return { service, studentReportsRepository };
}

describe('FacultyReportsService — updateAction', () => {
    it('rejects with no remarks are refused — a student is entitled to know why', async () => {
        const { service, studentReportsRepository } = makeService({
            id: 'report-1',
            faculty_status: 'pending',
        });

        await expect(
            service.updateAction('report-1', 'faculty-1', 'teacher@uni.edu', 'rejected'),
        ).rejects.toBeInstanceOf(BadRequestException);
        await expect(
            service.updateAction('report-1', 'faculty-1', 'teacher@uni.edu', 'rejected', '   '),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(studentReportsRepository.save).not.toHaveBeenCalled();
    });

    it('accepts a reject with a real reason', async () => {
        const { service } = makeService({ id: 'report-1', faculty_status: 'pending' });

        const result = await service.updateAction(
            'report-1',
            'faculty-1',
            'teacher@uni.edu',
            'rejected',
            'Attendance hours look inflated.',
        );

        expect(result.success).toBe(true);
    });

    it('approve does not require remarks', async () => {
        const { service } = makeService({ id: 'report-1', faculty_status: 'pending' });

        const result = await service.updateAction('report-1', 'faculty-1', 'teacher@uni.edu', 'approved');

        expect(result.success).toBe(true);
    });
});
