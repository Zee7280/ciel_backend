import {
    BadRequestException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import type { Response } from 'express';
import archiver from 'archiver';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { StudentReport } from '../reports/entities/student-report.entity';
import { AttendanceLog } from '../engagement/entities/attendance-log.entity';
import { S3Service } from '../common/s3.service';
import {
    collectReportEvidenceFiles,
    ReportEvidenceFileRef,
} from '../reports/collect-report-evidence.util';

const MAX_FILES_PER_ZIP = 250;

type ZipEntry = ReportEvidenceFileRef & {
    zipPath: string;
};

@Injectable()
export class AdminProjectEvidenceService {
    constructor(
        @InjectRepository(Opportunity)
        private readonly opportunityRepository: Repository<Opportunity>,
        @InjectRepository(StudentReport)
        private readonly studentReportRepository: Repository<StudentReport>,
        @InjectRepository(AttendanceLog)
        private readonly attendanceLogRepository: Repository<AttendanceLog>,
        private readonly s3Service: S3Service,
    ) { }

    async getEvidenceOverview() {
        const opportunities = await this.opportunityRepository.find({
            relations: ['organization'],
            order: { createdAt: 'DESC' },
        });

        const reports = await this.studentReportRepository.find({
            relations: ['student'],
        });

        const attendanceWithEvidence = await this.attendanceLogRepository.find({
            where: { evidenceUrl: Not(IsNull()) },
            relations: ['participant'],
        });

        const reportsByProject = new Map<string, StudentReport[]>();
        for (const report of reports) {
            const projectId = report.opportunityId ?? report.project_id;
            if (!projectId) continue;
            const list = reportsByProject.get(projectId) ?? [];
            list.push(report);
            reportsByProject.set(projectId, list);
        }

        const attendanceByProject = new Map<string, AttendanceLog[]>();
        for (const log of attendanceWithEvidence) {
            if (!log.evidenceUrl?.trim()) continue;
            const list = attendanceByProject.get(log.projectId) ?? [];
            list.push(log);
            attendanceByProject.set(log.projectId, list);
        }

        const projects = opportunities.map((opp) => {
            const projectReports = reportsByProject.get(opp.id) ?? [];
            const projectAttendance = attendanceByProject.get(opp.id) ?? [];

            const fileUrls = new Set<string>();
            for (const report of projectReports) {
                for (const file of collectReportEvidenceFiles(report)) {
                    fileUrls.add(file.url);
                }
            }
            for (const log of projectAttendance) {
                if (log.evidenceUrl) fileUrls.add(log.evidenceUrl);
            }

            return {
                id: opp.id,
                title: opp.title,
                status: opp.status,
                organization_name: opp.organization?.name ?? 'Unknown',
                report_count: projectReports.length,
                evidence_file_count: fileUrls.size,
            };
        });

        return { success: true, data: { projects } };
    }

    async streamProjectEvidenceZip(opportunityId: string, res: Response): Promise<void> {
        const id = opportunityId?.trim();
        if (!id) {
            throw new BadRequestException('Project id is required');
        }

        const opportunity = await this.opportunityRepository.findOne({
            where: { id },
            relations: ['organization'],
        });
        if (!opportunity) {
            throw new NotFoundException('Project not found');
        }

        const reports = await this.studentReportRepository.find({
            where: [{ opportunityId: id }, { project_id: id }],
            relations: ['student'],
        });

        const attendanceLogs = await this.attendanceLogRepository.find({
            where: { projectId: id, evidenceUrl: Not(IsNull()) },
            relations: ['participant'],
        });

        const entries = this.buildZipEntries(opportunity.title, reports, attendanceLogs);
        if (entries.length === 0) {
            throw new NotFoundException('No evidence files found for this project');
        }
        if (entries.length > MAX_FILES_PER_ZIP) {
            throw new BadRequestException(
                `Too many evidence files (${entries.length}). Maximum ${MAX_FILES_PER_ZIP} per download.`,
            );
        }

        const safeTitle = this.sanitizePathSegment(opportunity.title) || 'project';
        const filename = `${safeTitle}-${id.slice(0, 8)}-evidence.zip`;

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

        const archive = archiver('zip', { zlib: { level: 6 } });
        archive.on('error', (err) => {
            console.error('Evidence zip archive error:', err);
            if (!res.headersSent) {
                res.status(500).end();
            } else {
                res.end();
            }
        });

        archive.pipe(res);

        const usedPaths = new Set<string>();
        let added = 0;
        let skipped = 0;

        for (const entry of entries) {
            const downloaded = await this.s3Service.getObjectBufferByPublicUrl(entry.url);
            if (!downloaded || downloaded.buffer.length === 0) {
                skipped += 1;
                continue;
            }
            let zipPath = entry.zipPath;
            let suffix = 1;
            while (usedPaths.has(zipPath)) {
                const dot = entry.zipPath.lastIndexOf('.');
                if (dot > 0) {
                    zipPath = `${entry.zipPath.slice(0, dot)}-${suffix}${entry.zipPath.slice(dot)}`;
                } else {
                    zipPath = `${entry.zipPath}-${suffix}`;
                }
                suffix += 1;
            }
            usedPaths.add(zipPath);
            archive.append(downloaded.buffer, { name: zipPath });
            added += 1;
        }

        if (skipped > 0) {
            archive.append(
                Buffer.from(
                    `Some files could not be downloaded from storage (${skipped} skipped, ${added} included).\n`,
                    'utf8',
                ),
                { name: '_README_skipped_files.txt' },
            );
        }

        if (added === 0) {
            archive.append(
                Buffer.from(
                    'No files could be retrieved from S3 for this project. Check bucket credentials and URLs.\n',
                    'utf8',
                ),
                { name: '_README_no_files_downloaded.txt' },
            );
        }

        await new Promise<void>((resolve, reject) => {
            archive.once('end', () => resolve());
            archive.once('error', (err) => reject(err));
            archive.finalize();
        });
    }

    private buildZipEntries(
        projectTitle: string,
        reports: StudentReport[],
        attendanceLogs: AttendanceLog[],
    ): ZipEntry[] {
        const map = new Map<string, ZipEntry>();
        const projectFolder = this.sanitizePathSegment(projectTitle) || 'project';

        for (const report of reports) {
            const studentLabel = this.studentFolderLabel(report);
            const reportFolder = report.id.slice(0, 8);

            for (const file of collectReportEvidenceFiles(report)) {
                if (map.has(file.url)) continue;
                const fileName = this.sanitizePathSegment(file.name) || 'evidence';
                map.set(file.url, {
                    ...file,
                    zipPath: `${projectFolder}/${studentLabel}/reports/${reportFolder}/${file.source}/${fileName}`,
                });
            }
        }

        for (const log of attendanceLogs) {
            const url = log.evidenceUrl?.trim();
            if (!url || map.has(url)) continue;
            const studentId = log.participant?.studentId ?? 'unknown-student';
            const fileName =
                this.sanitizePathSegment(url.split('?')[0].split('/').pop() || '') ||
                `attendance-${log.id.slice(0, 8)}`;
            map.set(url, {
                url,
                name: fileName,
                source: 'attendance_logs',
                zipPath: `${projectFolder}/${this.sanitizePathSegment(studentId)}/attendance/${fileName}`,
            });
        }

        return Array.from(map.values());
    }

    private studentFolderLabel(report: StudentReport): string {
        const email = report.student?.email?.trim();
        if (email) {
            return this.sanitizePathSegment(email.split('@')[0]) || 'student';
        }
        return this.sanitizePathSegment(report.studentId.slice(0, 8)) || 'student';
    }

    private sanitizePathSegment(value: string): string {
        return value
            .trim()
            .replace(/[/\\?%*:|"<>]/g, '-')
            .replace(/\s+/g, '_')
            .slice(0, 80);
    }
}
