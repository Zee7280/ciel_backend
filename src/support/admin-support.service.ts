import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { SupportFaq } from './entities/support-faq.entity';
import { SupportTicket } from './entities/support-ticket.entity';
import { User } from '../users/entities/user.entity';
import { UpdateSupportTicketDto } from './dto/update-support-ticket.dto';
import { CreateSupportFaqDto } from './dto/create-support-faq.dto';
import { UpdateSupportFaqDto } from './dto/update-support-faq.dto';

@Injectable()
export class AdminSupportService {
    constructor(
        @InjectRepository(SupportFaq)
        private readonly faqRepo: Repository<SupportFaq>,
        @InjectRepository(SupportTicket)
        private readonly ticketRepo: Repository<SupportTicket>,
        @InjectRepository(User)
        private readonly userRepo: Repository<User>,
    ) { }

    async listFaqs() {
        const rows = await this.faqRepo.find({
            order: { sortOrder: 'ASC', id: 'ASC' },
        });
        const items = rows.map((r) => this.toFaqRow(r));
        return { success: true, data: { items } };
    }

    async createFaq(dto: CreateSupportFaqDto) {
        const faq = this.faqRepo.create({
            question: dto.question.trim(),
            answer: dto.answer.trim(),
            category: dto.category?.trim() || null,
            isPublished: dto.isPublished ?? true,
            sortOrder: dto.sortOrder ?? 0,
        });
        const saved = await this.faqRepo.save(faq);
        return { success: true, data: this.toFaqRow(saved) };
    }

    async updateFaq(id: number, dto: UpdateSupportFaqDto) {
        const faq = await this.faqRepo.findOne({ where: { id } });
        if (!faq) {
            throw new NotFoundException('FAQ not found');
        }
        if (dto.question !== undefined) faq.question = dto.question.trim();
        if (dto.answer !== undefined) faq.answer = dto.answer.trim();
        if (dto.category !== undefined) faq.category = dto.category.trim() || null;
        if (dto.isPublished !== undefined) faq.isPublished = dto.isPublished;
        if (dto.sortOrder !== undefined) faq.sortOrder = dto.sortOrder;
        const saved = await this.faqRepo.save(faq);
        return { success: true, data: this.toFaqRow(saved) };
    }

    async deleteFaq(id: number): Promise<void> {
        const faq = await this.faqRepo.findOne({ where: { id } });
        if (!faq) {
            throw new NotFoundException('FAQ not found');
        }
        await this.faqRepo.delete({ id });
    }

    private toFaqRow(r: SupportFaq) {
        return {
            id: r.id,
            question: r.question,
            answer: r.answer,
            category: r.category ?? undefined,
            isPublished: r.isPublished,
            sortOrder: r.sortOrder,
        };
    }

    async listTickets(status?: string) {
        const where =
            status && status.trim().length > 0
                ? { status: status.trim() }
                : {};
        const tickets = await this.ticketRepo.find({
            where,
            order: { createdAt: 'DESC' },
            take: 500,
        });
        const userIds = [...new Set(tickets.map((t) => t.studentUserId))];
        const users =
            userIds.length > 0
                ? await this.userRepo.find({
                    where: { id: In(userIds) },
                    select: ['id', 'name', 'email', 'university', 'phone'],
                })
                : [];
        const byId = new Map(users.map((u) => [u.id, u]));
        const list = tickets.map((t) => ({
            ...this.toTicketRow(t),
            student: this.formatStudent(byId.get(t.studentUserId)),
        }));
        return { success: true, data: { tickets: list } };
    }

    async getTicket(idOrRef: string) {
        const ticket = await this.findTicketByIdOrReference(idOrRef);
        if (!ticket) {
            throw new NotFoundException('Ticket not found');
        }
        const user = await this.userRepo.findOne({
            where: { id: ticket.studentUserId },
            select: ['id', 'name', 'email', 'university', 'phone'],
        });
        return {
            success: true,
            data: {
                ...this.toTicketRow(ticket),
                student: this.formatStudent(user ?? undefined),
            },
        };
    }

    async updateTicket(idOrRef: string, dto: UpdateSupportTicketDto) {
        const ticket = await this.findTicketByIdOrReference(idOrRef);
        if (!ticket) {
            throw new NotFoundException('Ticket not found');
        }
        if (dto.status !== undefined) {
            ticket.status = dto.status.trim();
            await this.ticketRepo.save(ticket);
        }
        return this.getTicket(idOrRef);
    }

    async deleteTicket(idOrRef: string): Promise<void> {
        const ticket = await this.findTicketByIdOrReference(idOrRef);
        if (!ticket) {
            throw new NotFoundException('Ticket not found');
        }
        await this.ticketRepo.softDelete({ id: ticket.id });
    }

    private toTicketRow(t: SupportTicket) {
        return {
            id: t.id,
            reference: t.reference,
            subject: t.subject,
            category: t.category,
            status: t.status,
            createdAt: t.createdAt,
            updatedAt: t.updatedAt,
            description: t.description,
            studentUserId: t.studentUserId,
        };
    }

    private formatStudent(u: User | undefined) {
        if (!u) {
            return null;
        }
        return {
            id: u.id,
            name: u.name,
            email: u.email,
            university: u.university ?? null,
            phone: u.phone ?? null,
        };
    }

    private async findTicketByIdOrReference(
        idOrRef: string,
    ): Promise<SupportTicket | null> {
        const raw = decodeURIComponent(idOrRef).trim();
        if (/^\d+$/.test(raw)) {
            return this.ticketRepo.findOne({
                where: { id: Number.parseInt(raw, 10) },
            });
        }
        return this.ticketRepo.findOne({ where: { reference: raw } });
    }
}
