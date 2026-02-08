import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Report } from './entities/report.entity';
import { CreateReportDto } from './dto/create-report.dto';
import { UpdateReportDto } from './dto/update-report.dto';

@Injectable()
export class ReportsService {
    constructor(
        @InjectRepository(Report)
        private reportsRepository: Repository<Report>,
    ) { }

    async findAllForPartner(userId: string, query: any) {
        const { status, page = 1, limit = 10 } = query;
        const skip = (page - 1) * limit;

        const whereClause: any = { organizationId: userId };
        if (status) {
            whereClause.status = status;
        }

        const [reports, total] = await this.reportsRepository.findAndCount({
            where: whereClause,
            skip,
            take: limit,
            order: { createdAt: 'DESC' },
        });

        return {
            success: true,
            data: reports.map(r => ({
                id: r.id,
                title: r.title,
                status: r.status,
                submittedDate: r.submittedDate || r.createdAt,
                beneficiaries: r.beneficiaries || 0,
                hoursLogged: r.hoursLogged || 0,
                sdgs: r.sdgs || [],
            })),
            pagination: {
                total,
                page: parseInt(page),
                limit: parseInt(limit),
            },
        };
    }

    async createReport(userId: string, dto: CreateReportDto) {
        const report = this.reportsRepository.create({
            ...dto,
            organizationId: userId,
            status: 'draft',
        });

        await this.reportsRepository.save(report);

        return {
            success: true,
            data: report,
        };
    }

    async updateReport(id: string, userId: string, dto: UpdateReportDto) {
        const report = await this.reportsRepository.findOne({ where: { id } });

        if (!report) {
            throw new NotFoundException('Report not found');
        }

        if (report.organizationId !== userId) {
            throw new ForbiddenException('You can only update your own reports');
        }

        Object.assign(report, dto);

        if (dto.status === 'submitted' && !report.submittedDate) {
            report.submittedDate = new Date();
        }

        await this.reportsRepository.save(report);

        return {
            success: true,
            data: report,
        };
    }

    async deleteReport(id: string, userId: string) {
        const report = await this.reportsRepository.findOne({ where: { id } });

        if (!report) {
            throw new NotFoundException('Report not found');
        }

        if (report.organizationId !== userId) {
            throw new ForbiddenException('You can only delete your own reports');
        }

        if (report.status !== 'draft') {
            throw new ForbiddenException('Only draft reports can be deleted');
        }

        await this.reportsRepository.remove(report);

        return {
            success: true,
            message: 'Report deleted successfully',
        };
    }
}
