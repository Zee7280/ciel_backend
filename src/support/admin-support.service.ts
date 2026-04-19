import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { SupportFaq } from './entities/support-faq.entity';
import { SupportTicket } from './entities/support-ticket.entity';
import { User } from '../users/entities/user.entity';

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
        const items = rows.map((r) => ({
            id: r.id,
            question: r.question,
            answer: r.answer,
            category: r.category ?? undefined,
            isPublished: r.isPublished,
            sortOrder: r.sortOrder,
        }));
        return { success: true, data: { items } };
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
