import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CourseProjectEntry } from './entities/course-project-entry.entity';
import { DEFAULT_FYP_MILESTONES, FypEntry } from './entities/fyp-entry.entity';
import { VentureEntry } from './entities/venture-entry.entity';
import { UpdateCourseProjectDto } from './dto/update-course-project.dto';
import { AddFypDeliverableDto, UpdateFypDto } from './dto/update-fyp.dto';
import { UpdateVentureDto } from './dto/update-venture.dto';
import { ventureCompletenessPercent, ventureMissingItems, VENTURE_VISIBILITY_THRESHOLD } from './venture-completeness.constants';

@Injectable()
export class PathsService {
    constructor(
        @InjectRepository(CourseProjectEntry)
        private readonly courseProjectRepo: Repository<CourseProjectEntry>,
        @InjectRepository(FypEntry)
        private readonly fypRepo: Repository<FypEntry>,
        @InjectRepository(VentureEntry)
        private readonly ventureRepo: Repository<VentureEntry>,
    ) { }

    // ---------- Course Project ----------

    async getCourseProject(userId: string) {
        return this.courseProjectRepo.findOne({ where: { userId } });
    }

    async upsertCourseProject(userId: string, dto: UpdateCourseProjectDto) {
        let entry = await this.courseProjectRepo.findOne({ where: { userId } });
        if (!entry) entry = this.courseProjectRepo.create({ userId });
        if (dto.course !== undefined) entry.course = dto.course;
        if (dto.projectTitle !== undefined) entry.projectTitle = dto.projectTitle;
        if (dto.projectDescription !== undefined) entry.projectDescription = dto.projectDescription;
        if (dto.sdgs !== undefined) entry.sdgs = dto.sdgs;
        if (dto.evidenceUrls !== undefined) entry.evidenceUrls = dto.evidenceUrls;
        if (dto.stepCompleted !== undefined) entry.stepCompleted = dto.stepCompleted;
        if (dto.status !== undefined) entry.status = dto.status;
        return this.courseProjectRepo.save(entry);
    }

    // ---------- FYP / Thesis ----------

    async getFyp(userId: string) {
        return this.fypRepo.findOne({ where: { userId } });
    }

    async upsertFyp(userId: string, dto: UpdateFypDto) {
        let entry = await this.fypRepo.findOne({ where: { userId } });
        if (!entry) entry = this.fypRepo.create({ userId, milestones: DEFAULT_FYP_MILESTONES });
        if (dto.projectTitle !== undefined) entry.projectTitle = dto.projectTitle;
        if (dto.overview !== undefined) entry.overview = dto.overview;
        if (dto.milestones !== undefined) entry.milestones = dto.milestones;
        if (dto.communityLinkage !== undefined) entry.communityLinkage = dto.communityLinkage;
        return this.fypRepo.save(entry);
    }

    async addFypDeliverable(userId: string, dto: AddFypDeliverableDto) {
        let entry = await this.fypRepo.findOne({ where: { userId } });
        if (!entry) entry = this.fypRepo.create({ userId, milestones: DEFAULT_FYP_MILESTONES });
        const nextVersion = (entry.deliverables?.length ?? 0) + 1;
        entry.deliverables = [
            ...(entry.deliverables ?? []),
            { version: nextVersion, label: dto.label, fileUrl: dto.fileUrl, uploadedAt: new Date().toISOString() },
        ];
        return this.fypRepo.save(entry);
    }

    // ---------- Startup / Business ----------

    async getVenture(userId: string) {
        const entry = await this.ventureRepo.findOne({ where: { userId } });
        return this.withCompleteness(entry);
    }

    async upsertVenture(userId: string, dto: UpdateVentureDto) {
        let entry = await this.ventureRepo.findOne({ where: { userId } });
        if (!entry) entry = this.ventureRepo.create({ userId });
        if (dto.ventureName !== undefined) entry.ventureName = dto.ventureName;
        if (dto.description !== undefined) entry.description = dto.description;
        if (dto.stage !== undefined) entry.stage = dto.stage;
        if (dto.tractionRows !== undefined) entry.tractionRows = dto.tractionRows;
        if (dto.team !== undefined) entry.team = dto.team;
        if (dto.materialUrls !== undefined) entry.materialUrls = dto.materialUrls;
        const saved = await this.ventureRepo.save(entry);
        return this.withCompleteness(saved);
    }

    async setVentureVisibility(userId: string, isVisible: boolean) {
        let entry = await this.ventureRepo.findOne({ where: { userId } });
        if (!entry) entry = this.ventureRepo.create({ userId });
        const percent = ventureCompletenessPercent(entry);
        if (isVisible && percent < VENTURE_VISIBILITY_THRESHOLD) {
            return {
                error: 'incomplete_profile',
                message: `Your venture profile is ${percent}% complete. Reach ${VENTURE_VISIBILITY_THRESHOLD}% before making it visible.`,
                data: this.withCompleteness(entry),
            };
        }
        entry.isVisible = isVisible;
        const saved = await this.ventureRepo.save(entry);
        return { data: this.withCompleteness(saved) };
    }

    private withCompleteness(entry: VentureEntry | null) {
        if (!entry) return null;
        return {
            ...entry,
            completenessPercent: ventureCompletenessPercent(entry),
            missingItems: ventureMissingItems(entry),
        };
    }
}
