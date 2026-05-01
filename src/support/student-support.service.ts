import {
    BadRequestException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomBytes } from 'crypto';
import { SupportFaq } from './entities/support-faq.entity';
import { SupportTicket } from './entities/support-ticket.entity';
import { CreateSupportTicketDto } from './dto/create-support-ticket.dto';

@Injectable()
export class StudentSupportService {
    constructor(
        @InjectRepository(SupportFaq)
        private readonly faqRepo: Repository<SupportFaq>,
        @InjectRepository(SupportTicket)
        private readonly ticketRepo: Repository<SupportTicket>,
    ) { }

    async listFaqs() {
        const rows = await this.faqRepo.find({
            where: { isPublished: true },
            order: { sortOrder: 'ASC', id: 'ASC' },
            select: ['id', 'question', 'answer', 'category'],
        });
        const items = rows.map((r) => ({
            id: r.id,
            question: r.question,
            answer: r.answer,
            category: r.category ?? undefined,
        }));
        return { success: true, data: { items } };
    }

    async listTickets(studentUserId: string) {
        const tickets = await this.ticketRepo.find({
            where: { studentUserId },
            order: { createdAt: 'DESC' },
        });
        return {
            success: true,
            data: { tickets: tickets.map((t) => this.toTicketSummary(t)) },
        };
    }

    async createTicket(studentUserId: string, dto: CreateSupportTicketDto) {
        const reference = await this.nextReference();
        const entity = this.ticketRepo.create({
            reference,
            studentUserId,
            category: dto.category.trim(),
            subject: dto.subject.trim(),
            description: dto.description.trim(),
            status: 'open',
        });
        const saved = await this.ticketRepo.save(entity);
        return { success: true, data: this.toTicketSummary(saved) };
    }

    async getTicket(studentUserId: string, idOrRef: string) {
        const ticket = await this.findTicketForStudent(studentUserId, idOrRef);
        if (!ticket) {
            throw new NotFoundException('Ticket not found');
        }
        return { success: true, data: this.toTicketSummary(ticket) };
    }

    async trackByReference(studentUserId: string, reference: string | undefined) {
        const ref = reference?.trim();
        if (!ref) {
            throw new BadRequestException('Query parameter reference is required');
        }
        const ticket = await this.ticketRepo.findOne({
            where: { reference: ref, studentUserId },
        });
        if (!ticket) {
            throw new NotFoundException('Ticket not found');
        }
        return { success: true, data: this.toTicketSummary(ticket) };
    }

    private toTicketSummary(t: SupportTicket) {
        return {
            id: t.id,
            reference: t.reference,
            subject: t.subject,
            category: t.category,
            status: t.status,
            createdAt: t.createdAt,
            updatedAt: t.updatedAt,
            description: t.description,
        };
    }

    private async findTicketForStudent(
        studentUserId: string,
        idOrRef: string,
    ): Promise<SupportTicket | null> {
        const raw = decodeURIComponent(idOrRef).trim();
        if (/^\d+$/.test(raw)) {
            const id = Number.parseInt(raw, 10);
            const ticket = await this.ticketRepo.findOne({ where: { id } });
            if (!ticket || ticket.studentUserId !== studentUserId) {
                return null;
            }
            return ticket;
        }
        const ticket = await this.ticketRepo.findOne({
            where: { reference: raw, studentUserId },
        });
        return ticket ?? null;
    }

    private async nextReference(): Promise<string> {
        for (let attempt = 0; attempt < 8; attempt++) {
            const ref = `ST-${randomBytes(4).toString('hex').toUpperCase()}`;
            const taken = await this.ticketRepo.findOne({
                where: { reference: ref },
                withDeleted: true,
            });
            if (!taken) {
                return ref;
            }
        }
        throw new BadRequestException('Could not allocate ticket reference; try again');
    }
}
