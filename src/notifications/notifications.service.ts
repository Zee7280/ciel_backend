
import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Notification } from './entities/notification.entity';

@Injectable()
export class NotificationsService {
    constructor(
        @InjectRepository(Notification)
        private notificationsRepository: Repository<Notification>,
    ) { }

    async createNotification(
        userId: string,
        input: { type: string; title: string; message: string },
    ) {
        const notification = this.notificationsRepository.create({
            userId,
            type: input.type,
            title: input.title,
            message: input.message,
        });

        return this.notificationsRepository.save(notification);
    }

    async createApprovalNotification(userId: string, title: string, message: string) {
        return this.createNotification(userId, {
            type: 'approval',
            title,
            message,
        });
    }

    async countUnread(userId: string): Promise<number> {
        return this.notificationsRepository.count({
            where: { userId, isRead: false },
        });
    }

    async findAll(userId: string, query: any) {
        const { status, type } = query;
        const whereClause: any = { userId };

        if (status === 'read') {
            whereClause.isRead = true;
        } else if (status === 'unread') {
            whereClause.isRead = false;
        }

        if (type) {
            whereClause.type = type;
        }

        return this.notificationsRepository.find({
            where: whereClause,
            order: { createdAt: 'DESC' },
        });
    }

    async markAsRead(id: number, userId: string) {
        const notification = await this.notificationsRepository.findOne({ where: { id } });

        if (!notification) {
            throw new NotFoundException('Notification not found');
        }

        if (notification.userId !== userId) {
            throw new ForbiddenException('Cannot access this notification');
        }

        notification.isRead = true;
        await this.notificationsRepository.save(notification);

        return { success: true };
    }

    async remove(id: number, userId: string) {
        const notification = await this.notificationsRepository.findOne({ where: { id } });

        if (!notification) {
            throw new NotFoundException('Notification not found');
        }

        if (notification.userId !== userId) {
            throw new ForbiddenException('Cannot access this notification');
        }

        await this.notificationsRepository.remove(notification);
        return { success: true };
    }
}
