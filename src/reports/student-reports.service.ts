import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StudentReport } from './entities/student-report.entity';
import { CreateStudentReportDto } from './dto/create-student-report.dto';
import { Multer } from 'multer';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class StudentReportsService {
    private readonly uploadDir = process.env.NODE_ENV === 'production' || process.env.VERCEL
        ? path.join('/tmp', 'uploads', 'student-reports')
        : path.join(process.cwd(), 'uploads', 'student-reports');

    constructor(
        @InjectRepository(StudentReport)
        private studentReportsRepository: Repository<StudentReport>,
    ) {
        // Ensure upload directory exists
        try {
            if (!fs.existsSync(this.uploadDir)) {
                fs.mkdirSync(this.uploadDir, { recursive: true });
            }
        } catch (error) {
            console.error('Failed to create upload directory:', error);
            // Don't crash the app, just log error
        }
    }

    async createReport(studentId: string, dto: any, files: any[]) {
        // Parse form data and convert dot notation to nested objects
        const parsedData = this.parseFormData(dto);

        // Create report entity
        const report = this.studentReportsRepository.create({
            studentId,
            project_id: parsedData.project_id,
            opportunityId: parsedData.opportunityId,
            status: 'submitted',
            section1: parsedData.section1,
            section2: parsedData.section2,
            section3: parsedData.section3,
            section4: parsedData.section4,
            section5: parsedData.section5,
            section6: parsedData.section6,
            section7: parsedData.section7,
            section8: parsedData.section8,
            section10: parsedData.section10,
            section12: parsedData.section12,
        });

        // Save report to get ID
        await this.studentReportsRepository.save(report);

        // Save files if any
        if (files && files.length > 0) {
            const filePaths = await this.saveFiles(files, report.id);

            // Update report with file paths
            this.updateReportWithFilePaths(report, filePaths);
            await this.studentReportsRepository.save(report);
        }

        return {
            success: true,
            message: 'Report submitted successfully.',
            data: {
                report_id: report.id,
                project_id: report.project_id,
                submitted_at: report.submission_date,
                status: report.status,
            },
        };
    }

    async saveDraft(studentId: string, dto: any, files: any[]) {
        const parsedData = this.parseFormData(dto);

        const report = this.studentReportsRepository.create({
            studentId,
            project_id: parsedData.project_id,
            opportunityId: parsedData.opportunityId,
            status: 'draft',
            section1: parsedData.section1,
            section2: parsedData.section2,
            section3: parsedData.section3,
            section4: parsedData.section4,
            section5: parsedData.section5,
            section6: parsedData.section6,
            section7: parsedData.section7,
            section8: parsedData.section8,
            section10: parsedData.section10,
            section12: parsedData.section12,
        });

        await this.studentReportsRepository.save(report);

        if (files && files.length > 0) {
            const filePaths = await this.saveFiles(files, report.id);
            this.updateReportWithFilePaths(report, filePaths);
            await this.studentReportsRepository.save(report);
        }

        return {
            success: true,
            message: 'Draft saved successfully.',
            data: {
                draft_id: report.id,
                last_saved: report.updatedAt,
            },
        };
    }

    async findAll(query: any) {
        const { status, page = 1, limit = 10 } = query;
        const skip = (page - 1) * limit;

        const whereClause: any = {};
        if (status) {
            whereClause.status = status;
        }

        const [reports, total] = await this.studentReportsRepository.findAndCount({
            where: whereClause,
            relations: ['student', 'opportunity'],
            skip,
            take: limit,
            order: { submission_date: 'DESC' },
        });

        return {
            success: true,
            data: reports.map(r => ({
                id: r.id,
                student_name: r.student?.name || 'Unknown',
                student_email: r.student?.email || 'Unknown',
                project_title: r.opportunity?.title || r.project_id,
                status: r.status,
                submission_date: r.submission_date,
                created_at: r.createdAt,
            })),
            pagination: {
                total,
                page: parseInt(page),
                limit: parseInt(limit),
                total_pages: Math.ceil(total / limit),
            },
        };
    }

    async findOne(id: string) {
        const report = await this.studentReportsRepository.findOne({
            where: { id },
            relations: ['student', 'opportunity'],
        });

        if (!report) {
            throw new NotFoundException('Report not found');
        }

        return {
            success: true,
            data: {
                id: report.id,
                student: {
                    id: report.student?.id,
                    name: report.student?.name,
                    email: report.student?.email,
                },
                opportunity: {
                    id: report.opportunity?.id,
                    title: report.opportunity?.title,
                },
                project_id: report.project_id,
                status: report.status,
                submission_date: report.submission_date,
                section1: report.section1,
                section2: report.section2,
                section3: report.section3,
                section4: report.section4,
                section5: report.section5,
                section6: report.section6,
                section7: report.section7,
                section8: report.section8,
                section10: report.section10,
                section12: report.section12,
                created_at: report.createdAt,
                updated_at: report.updatedAt,
            },
        };
    }

    async verifyReport(id: string, action: 'approve' | 'reject', reason?: string) {
        const report = await this.studentReportsRepository.findOne({ where: { id } });

        if (!report) {
            throw new NotFoundException('Report not found');
        }

        if (action === 'approve') {
            report.status = 'verified';
        } else if (action === 'reject') {
            report.status = 'rejected';
            // You could add a rejection_reason field to the entity if needed
        }

        await this.studentReportsRepository.save(report);

        return {
            success: true,
            message: `Report ${action === 'approve' ? 'approved' : 'rejected'} successfully.`,
            data: {
                id: report.id,
                status: report.status,
            },
        };
    }

    async checkReportStatus(studentId: string, opportunityId?: string) {
        if (!opportunityId) {
            // Find ALL reports for this student
            const reports = await this.studentReportsRepository.find({
                where: { studentId },
                relations: ['opportunity'],
                order: { createdAt: 'DESC' },
            });

            return {
                success: true,
                data: reports.map(r => ({
                    status: r.status,
                    report_id: r.id,
                    project_id: r.project_id,
                    opportunity_id: r.opportunityId,
                    opportunity_title: r.opportunity?.title,
                    feedback: null,
                    submission_date: r.submission_date
                }))
            };
        }

        // Existing logic for single check
        const report = await this.studentReportsRepository.findOne({
            where: {
                studentId,
                opportunityId
            },
            order: { createdAt: 'DESC' },
        });

        if (!report) {
            return {
                success: true,
                data: {
                    status: 'none',
                    report_id: null,
                    feedback: null,
                },
            };
        }

        return {
            success: true,
            data: {
                status: report.status,
                report_id: report.id,
                project_id: report.project_id,
                opportunity_id: report.opportunityId,
                feedback: null,
            },
        };
    }

    private parseFormData(formData: any): any {
        const result: any = {};

        for (const key in formData) {
            const value = formData[key];
            this.setNestedProperty(result, key, value);
        }

        return result;
    }

    private setNestedProperty(obj: any, path: string, value: any) {
        const keys = path.split('.');
        let current = obj;

        for (let i = 0; i < keys.length - 1; i++) {
            const key = keys[i];
            const arrayMatch = key.match(/^(.+)\[(\d+)\]$/);

            if (arrayMatch) {
                const arrayKey = arrayMatch[1];
                const index = parseInt(arrayMatch[2]);

                if (!current[arrayKey]) {
                    current[arrayKey] = [];
                }
                if (!current[arrayKey][index]) {
                    current[arrayKey][index] = {};
                }
                current = current[arrayKey][index];
            } else {
                if (!current[key]) {
                    current[key] = {};
                }
                current = current[key];
            }
        }

        const lastKey = keys[keys.length - 1];
        const arrayMatch = lastKey.match(/^(.+)\[(\d+)\]$/);

        if (arrayMatch) {
            const arrayKey = arrayMatch[1];
            const index = parseInt(arrayMatch[2]);
            if (!current[arrayKey]) {
                current[arrayKey] = [];
            }
            current[arrayKey][index] = value;
        } else {
            current[lastKey] = value;
        }
    }

    private async saveFiles(files: any[], reportId: string): Promise<{ [key: string]: string[] }> {
        const filePaths: { [key: string]: string[] } = {};

        for (const file of files) {
            const fieldName = file.fieldname;
            const section = this.getSectionFromFieldName(fieldName);

            // Create section directory
            const sectionDir = path.join(this.uploadDir, reportId, section);
            if (!fs.existsSync(sectionDir)) {
                fs.mkdirSync(sectionDir, { recursive: true });
            }

            // Generate unique filename
            const timestamp = Date.now();
            const sanitizedFilename = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
            const filename = `${timestamp}_${sanitizedFilename}`;
            const filePath = path.join(sectionDir, filename);

            // Save file
            fs.writeFileSync(filePath, file.buffer);

            // Store relative path
            const relativePath = `/uploads/student-reports/${reportId}/${section}/${filename}`;

            if (!filePaths[section]) {
                filePaths[section] = [];
            }
            filePaths[section].push(relativePath);
        }

        return filePaths;
    }

    private getSectionFromFieldName(fieldName: string): string {
        const sectionMatch = fieldName.match(/section(\d+)/);
        return sectionMatch ? `section${sectionMatch[1]}` : 'general';
    }

    private updateReportWithFilePaths(report: StudentReport, filePaths: { [key: string]: string[] }) {
        for (const section in filePaths) {
            if (report[section]) {
                // Merge file paths into existing section data
                if (section === 'section3') {
                    report.section3.secondary_sdgs = report.section3.secondary_sdgs.map((sdg, i) => ({
                        ...sdg,
                        evidence_files: filePaths[section] || []
                    }));
                } else if (section === 'section4') {
                    report.section4.evidence_files = filePaths[section] || [];
                } else if (section === 'section6') {
                    report.section6.evidence_files = filePaths[section] || [];
                } else if (section === 'section7') {
                    report.section7.formalization_files = filePaths[section] || [];
                } else if (section === 'section8') {
                    report.section8.evidence_files = filePaths[section] || [];
                    report.section8.partner_verification_files = filePaths[section] || [];
                } else if (section === 'section12') {
                    report.section12.partner_verification_files = filePaths[section] || [];
                }
            }
        }
    }
}
