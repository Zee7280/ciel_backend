import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { S3Service } from '../common/s3.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Participant } from './entities/participant.entity';
import { AttendanceLog } from './entities/attendance-log.entity';
import { RegisterParticipantDto } from './dto/register-participant.dto';
import { CreateAttendanceLogDto } from './dto/create-attendance-log.dto';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

@Injectable()
export class EngagementService {
    private readonly logger = new Logger(EngagementService.name);
    private readonly ALGORITHM = 'aes-256-cbc';
    private readonly KEY: Buffer;

    constructor(
        @InjectRepository(Participant)
        private participantRepository: Repository<Participant>,
        @InjectRepository(AttendanceLog)
        private attendanceLogRepository: Repository<AttendanceLog>,
        @InjectRepository(Opportunity)
        private opportunityRepository: Repository<Opportunity>,
        private configService: ConfigService,
        private s3Service: S3Service,
    ) {
        const secret = this.configService.get<string>('ENCRYPTION_KEY') || 'default-secret-key-32-chars-long!!';
        this.KEY = crypto.scryptSync(secret, 'salt', 32);
    }

    async preRegister(userId: string | null, projectId: string, data: Partial<Participant>) {
        const opportunity = await this.opportunityRepository.findOne({ where: { id: projectId } });
        if (!opportunity) throw new NotFoundException('Project not found');

        // Check if already registered
        let existing;
        if (userId) {
            existing = await this.participantRepository.findOne({
                where: { userId, projectId: opportunity.id }
            });
        } else if (data.email) {
            existing = await this.participantRepository.findOne({
                where: { email: data.email, projectId: opportunity.id }
            });
        }
        if (existing) return this.decryptParticipant(existing);

        const participantData: any = {
            ...data,
            projectId: opportunity.id,
            status: 'draft',
            emailVerified: true,
            mobileVerified: true,
        };

        if (userId) {
            participantData.userId = userId;
        }

        const participant = this.participantRepository.create(participantData as Partial<Participant>);

        if (data.cnic) {
            participant.cnicHash = this.hashString(data.cnic);
            participant.cnic = this.encrypt(data.cnic);
            participant.cnicLast4 = data.cnic.slice(-4);
        }

        const saved = await this.participantRepository.save(participant);
        return this.decryptParticipant(saved);
    }

    async registerParticipant(userId: string, dto: RegisterParticipantDto) {
        const opportunity = await this.opportunityRepository.findOne({ where: { id: dto.projectId } });
        if (!opportunity) throw new NotFoundException('Project not found');

        // 1. Check if this CNIC is already used by SOMEONE ELSE in this project
        const cnicHash = this.hashString(dto.cnic);
        const existingByCnic = await this.participantRepository.findOne({
            where: { cnicHash, projectId: opportunity.id }
        });

        if (existingByCnic && existingByCnic.userId !== userId) {
            throw new BadRequestException('CNIC already registered for this opportunity');
        }

        // 2. Check if a record already exists for THIS user in this project
        // We update the existing record to maintain idempotency and allow info updates
        const existingByUser = await this.participantRepository.findOne({
            where: { userId, projectId: opportunity.id }
        });

        const encryptedCnic = this.encrypt(dto.cnic);
        let participant: Participant;

        if (existingByUser) {
            // Update existing record
            Object.assign(existingByUser, {
                ...dto,
                cnicHash,
                cnic: encryptedCnic,
                cnicLast4: dto.cnic.slice(-4),
                // Ensure verified flags aren't reset if they were already true
                emailVerified: true,
                mobileVerified: true,
            });
            participant = existingByUser;
        } else {
            // Create new record
            participant = this.participantRepository.create({
                ...dto,
                userId,
                cnicHash,
                cnic: encryptedCnic,
                cnicLast4: dto.cnic.slice(-4),
                emailVerified: true,
                mobileVerified: true,
            });
        }

        const saved = await this.participantRepository.save(participant);
        return this.decryptParticipant(saved);
    }

    async getMyParticipants(userId: string) {
        const result = await this.participantRepository.find({
            where: { userId },
            relations: ['attendanceLogs']
        });
        return result.map(p => this.decryptParticipant(p));
    }

    private decryptParticipant(p: Participant): Participant {
        if (p.cnic && p.cnic.includes(':')) {
            try {
                p.cnic = this.decrypt(p.cnic);
            } catch (e) {
                this.logger.error(`Failed to decrypt CNIC for participant ${p.id}`);
            }
        }
        return p;
    }

    async addAttendanceLog(userId: string, participantId: string, dto: CreateAttendanceLogDto, file?: Express.Multer.File) {
        const participant = await this.participantRepository.findOne({
            where: { id: participantId },
            relations: ['attendanceLogs']
        });
        if (!participant) throw new NotFoundException('Participant record not found');
        if (participant.userId !== userId) throw new BadRequestException('Not authorized');

        // Rule 1: Date Validation (Not in future)
        const date = new Date(dto.dateOfEngagement);
        if (date > new Date()) throw new BadRequestException('Attendance date cannot be in the future');

        // Handle Flexible Project 4-month window
        if (participant.attendanceLogs && participant.attendanceLogs.length > 0) {
            const firstLogDate = new Date(Math.min(...participant.attendanceLogs.map(l => new Date(l.dateOfEngagement).getTime())));
            const fourMonthsLater = new Date(firstLogDate);
            fourMonthsLater.setMonth(fourMonthsLater.getMonth() + 4);

            if (date > fourMonthsLater) {
                throw new BadRequestException('Attendance entries must fall within 4 months from the first log for flexible projects.');
            }
        }

        // Rule 2: Time Validation (End > Start and Max 12h)
        const { startTime, endTime } = dto;
        const sessionHours = this.calculateSessionHours(startTime, endTime);
        if (sessionHours <= 0) throw new BadRequestException('End time must be after start time');
        if (sessionHours > 12) throw new BadRequestException('Daily attendance cannot exceed 12 hours');

        // Rule 3: Word Count Validation (Max 40 words)
        const wordCount = dto.description.trim().split(/\s+/).length;
        if (wordCount > 40) throw new BadRequestException('Description cannot exceed 40 words');

        let evidenceUrl: string | null = null;
        let evidenceUploaded: boolean = false;

        // Process file if provided
        if (file) {
            evidenceUrl = await this.s3Service.uploadFile(file, 'attendance-evidence');
            evidenceUploaded = true;
        } else if (String(dto.evidenceUploaded) === 'true') {
            evidenceUploaded = true;
        }

        const log = this.attendanceLogRepository.create({
            ...dto,
            participantId,
            projectId: participant.projectId,
            sessionHours,
            evidenceUploaded,
            evidenceUrl: evidenceUrl as any,
        });

        return await this.attendanceLogRepository.save(log);
    }

    async deleteAttendanceLog(userId: string, participantId: string, logId: string) {
        const participant = await this.participantRepository.findOne({ where: { id: participantId } });
        if (!participant) throw new NotFoundException('Participant record not found');
        if (participant.userId !== userId) throw new BadRequestException('Not authorized');

        const log = await this.attendanceLogRepository.findOne({ where: { id: logId, participantId } });
        if (!log) throw new NotFoundException('Attendance log not found');

        await this.attendanceLogRepository.delete(logId);
        return { deleted: true };
    }


    async getEngagementMetrics(participantId: string) {
        const participant = await this.participantRepository.findOne({
            where: { id: participantId },
            relations: ['attendanceLogs']
        });
        if (!participant) throw new NotFoundException('Participant not found');

        const logs = participant.attendanceLogs || [];
        const totalHours = logs.reduce((sum, log) => sum + Number(log.sessionHours), 0);
        const activeDays = new Set(logs.map(l => l.dateOfEngagement)).size;

        // Engagement Span
        let spanWeeks = 0;
        if (logs.length > 0) {
            const dates = logs.map(l => new Date(l.dateOfEngagement).getTime());
            const minDate = Math.min(...dates);
            const maxDate = Math.max(...dates);
            const spanDays = Math.max(1, Math.ceil((maxDate - minDate) / (1000 * 60 * 60 * 24)) + 1);
            spanWeeks = Math.ceil(spanDays / 7);
        }

        const attendanceFrequency = spanWeeks > 0 ? (activeDays / spanWeeks) : 0;

        // Weekly Continuity
        const weeksWithLogs = new Set(logs.map(l => {
            const d = new Date(l.dateOfEngagement);
            return `${d.getFullYear()}-W${this.getWeekNumber(d)}`;
        })).size;
        const weeklyContinuity = spanWeeks > 1 ? (weeksWithLogs / spanWeeks) : 1;

        // EIS Calculation (Hours 40%, Continuity 20%, Span 15%, Frequency 15%, Evidence 10%)
        // Spec: normalize hours to 48
        const hoursScore = (Math.min(totalHours, 48) / 48) * 40;
        const continuityScore = weeklyContinuity * 20;
        // Spec: normalize span to 16 weeks
        const spanScore = (Math.min(spanWeeks, 16) / 16) * 15;
        // Spec: target 2 visits/week
        const freqRatio = Math.min(attendanceFrequency / 2, 1);
        const frequencyScore = freqRatio * 15;
        // Spec: evidence link status
        const logsWithEvidence = logs.filter(l => l.evidenceUploaded).length;
        const evidenceRatio = logs.length > 0 ? logsWithEvidence / logs.length : 0;
        const evidenceScore = evidenceRatio * 10;

        const eis = Math.round(hoursScore + continuityScore + spanScore + frequencyScore + evidenceScore);

        return {
            totalHours: Math.round(totalHours * 10) / 10,
            activeDays,
            spanWeeks,
            frequency: Math.round(attendanceFrequency * 10) / 10,
            weeklyContinuity: Math.round(weeklyContinuity * 100),
            eis: Math.min(100, eis),
            hecStatus: this.getHecCode(totalHours),
            hecDisplay: this.getHecDisplay(totalHours),
            category: this.getEngagementCategory(eis),
            evidenceCount: logsWithEvidence,
            evidenceRatio: Math.round(evidenceRatio * 100)
        };
    }

    async finalizeEngagement(userId: string, participantId: string) {
        const participant = await this.participantRepository.findOne({
            where: { id: participantId },
            relations: ['attendanceLogs']
        });

        if (!participant) throw new NotFoundException('Participant record not found');
        if (participant.userId !== userId) throw new BadRequestException('Not authorized');

        const metrics = await this.getEngagementMetrics(participantId);

        participant.status = 'finalized';
        participant.eisScore = metrics.eis;
        participant.hecStatus = metrics.hecStatus;
        participant.finalizedAt = new Date();

        const saved = await this.participantRepository.save(participant);
        return this.decryptParticipant(saved);
    }

    async generateSummary(participantId: string) {
        const metrics = await this.getEngagementMetrics(participantId);
        const participant = await this.participantRepository.findOne({ where: { id: participantId } });

        let summary = `This report includes 1 OTP-verified participant contributing ${metrics.totalHours} verified hours across ${metrics.activeDays} active days over a ${metrics.spanWeeks}-week span. `;
        summary += `The engagement ${metrics.hecDisplay}. `;
        summary += `Participation is classified as ${metrics.category} Engagement `;

        if (metrics.evidenceCount > 0) {
            summary += "based on verified attendance continuity and supporting documentation.";
        } else {
            summary += "based on verified attendance continuity.";
        }

        return summary;
    }

    async getAttendanceLogs(participantId: string) {
        const participant = await this.participantRepository.findOne({
            where: { id: participantId },
            relations: ['attendanceLogs']
        });
        if (!participant) throw new NotFoundException('Participant not found');
        return participant.attendanceLogs;
    }

    private getHecCode(hours: number): string {
        if (hours >= 48) return 'full';
        if (hours >= 32) return 'advanced';
        if (hours >= 16) return 'recognized';
        return 'below';
    }

    private getHecDisplay(hours: number): string {
        if (hours >= 48) return 'meets Full 3-Credit Equivalent requirements (Extraordinary)';
        if (hours >= 32) return 'qualifies for Advanced Engagement status';
        if (hours >= 16) return 'meets HEC Recognized Engagement minimums';
        return 'is currently Below HEC Minimum';
    }

    private getEngagementCategory(eis: number): string {
        if (eis >= 76) return 'High-Intensity';
        if (eis >= 51) return 'Sustained';
        if (eis >= 26) return 'Structured';
        return 'Introductory';
    }

    private calculateSessionHours(start: string, end: string): number {
        const [h1, m1] = start.split(':').map(Number);
        const [h2, m2] = end.split(':').map(Number);
        const diffMinutes = (h2 * 60 + m2) - (h1 * 60 + m1);
        return Math.max(0, diffMinutes / 60);
    }

    private hashString(str: string): string {
        return crypto.createHash('sha256').update(str).digest('hex');
    }

    private encrypt(text: string): string {
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv(this.ALGORITHM, this.KEY, iv);
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        return iv.toString('hex') + ':' + encrypted;
    }

    public decryptCnicInternal(text: string): string {
        if (!text || !text.includes(':')) return text;
        try {
            return this.decrypt(text);
        } catch (e) {
            return text;
        }
    }

    private decrypt(text: string): string {
        const [ivHex, encryptedText] = text.split(':');
        const iv = Buffer.from(ivHex, 'hex');
        const decipher = crypto.createDecipheriv(this.ALGORITHM, this.KEY, iv);
        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    }

    private getWeekNumber(d: Date): number {
        const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
        date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
        const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
        const weekNo = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
        return weekNo;
    }
}
