import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, Not } from 'typeorm';
import { Conversation } from './entities/conversation.entity';
import { Message } from './entities/message.entity';
import { ConversationParticipant } from './entities/conversation-participant.entity';
import { CreateConversationDto, CreateMessageDto } from './dto/chat.dto';
import { User } from '../users/entities/user.entity';

@Injectable()
export class ChatService {
    constructor(
        @InjectRepository(Conversation)
        private conversationRepository: Repository<Conversation>,
        @InjectRepository(Message)
        private messageRepository: Repository<Message>,
        @InjectRepository(ConversationParticipant)
        private participantRepository: Repository<ConversationParticipant>,
        @InjectRepository(User)
        private usersRepository: Repository<User>,
    ) { }

    async createConversation(createConversationDto: CreateConversationDto, creatorId: string) {
        const { participantIds, type = 'DIRECT' } = createConversationDto;

        // Ensure creator is included
        const allParticipants = Array.from(new Set([...participantIds, creatorId]));

        // Check if direct conversation already exists
        if (type === 'DIRECT' && allParticipants.length === 2) {
            const existingConversation = await this.conversationRepository.createQueryBuilder('conversation')
                .innerJoinAndSelect('conversation.participants', 'p')
                .innerJoinAndSelect('p.user', 'user')
                .leftJoinAndSelect('conversation.lastMessage', 'lastMessage')
                .where('conversation.type = :type', { type: 'DIRECT' })
                .andWhere('EXISTS (SELECT 1 FROM conversation_participants cp WHERE cp."conversationId" = conversation.id AND cp."userId" = :u1)', { u1: allParticipants[0] })
                .andWhere('EXISTS (SELECT 1 FROM conversation_participants cp WHERE cp."conversationId" = conversation.id AND cp."userId" = :u2)', { u2: allParticipants[1] })
                .getOne();

            if (existingConversation) {
                const otherParticipants = existingConversation.participants
                    .filter(p => p.userId !== creatorId)
                    .map(p => ({
                        id: p.user.id,
                        name: p.user.name,
                        avatar: p.user.avatar,
                        role: p.user.role
                    }));

                return {
                    ...existingConversation,
                    otherParticipants
                };
            }
        }

        const conversation = this.conversationRepository.create({
            type
        });
        const savedConversation = await this.conversationRepository.save(conversation);

        const participants = allParticipants.map(userId =>
            this.participantRepository.create({
                conversationId: savedConversation.id,
                userId
            })
        );
        await this.participantRepository.save(participants);

        // Fetch the full conversation with relations to return to frontend
        const fullConversation = await this.conversationRepository.findOne({
            where: { id: savedConversation.id },
            relations: ['participants', 'participants.user', 'lastMessage']
        });

        if (!fullConversation) {
            throw new NotFoundException('Conversation could not be created');
        }

        const otherParticipants = fullConversation.participants
            .filter(p => p.userId !== creatorId)
            .map(p => ({
                id: p.user.id,
                name: p.user.name,
                avatar: p.user.avatar,
                role: p.user.role
            }));

        return {
            ...fullConversation,
            otherParticipants
        };
    }

    async getConversations(userId: string) {
        // Find conversation IDs where the user is a participant
        const userParticipants = await this.participantRepository.find({
            where: { userId },
            select: ['conversationId']
        });

        if (userParticipants.length === 0) return [];

        const conversationIds = userParticipants.map(p => p.conversationId);

        // Fetch those conversations fully populated
        const conversations = await this.conversationRepository.find({
            where: { id: In(conversationIds) },
            relations: ['participants', 'participants.user', 'lastMessage'],
            order: { updatedAt: 'DESC' }
        });

        // Fallback: manually fetch users if TypeORM failed to map participants.user
        const allUserIds = new Set<string>();
        conversations.forEach(c => c.participants.forEach(p => {
            if (!p.user) allUserIds.add(p.userId);
        }));

        let fallbackUsers = new Map<string, any>();
        if (allUserIds.size > 0) {
            const users = await this.usersRepository.find({
                where: { id: In(Array.from(allUserIds)) },
                select: ['id', 'name', 'avatar', 'role']
            });
            fallbackUsers = new Map(users.map(u => [u.id, u]));
        }

        return conversations.map(conv => {
            const otherParticipants = (conv.participants || []).filter(cp => cp.userId !== userId);

            return {
                id: conv.id,
                type: conv.type,
                lastMessageId: conv.lastMessageId,
                lastMessage: conv.lastMessage,
                createdAt: conv.createdAt,
                updatedAt: conv.updatedAt,
                otherParticipants: otherParticipants.map(op => {
                    const foundUser = op.user || fallbackUsers.get(op.userId);
                    return {
                        id: foundUser?.id || op.userId,
                        name: foundUser?.name || 'Unknown',
                        avatar: foundUser?.avatar,
                        role: foundUser?.role
                    };
                })
            };
        });
    }

    async getMessages(conversationId: string, userId: string) {
        // Check if user is a participant
        const isParticipant = await this.participantRepository.findOne({
            where: { conversationId, userId }
        });

        if (!isParticipant) {
            throw new ForbiddenException('You are not a participant in this conversation');
        }

        const messages = await this.messageRepository.find({
            where: { conversationId },
            order: { createdAt: 'ASC' },
            relations: ['sender']
        });

        return messages;
    }

    async sendMessage(createMessageDto: CreateMessageDto, senderId: string) {
        try {
            console.log('--- START sendMessage ---');
            const { conversationId, content } = createMessageDto;
            console.log('Payload:', { conversationId, content, senderId });

            // Check if user is a participant
            const isParticipant = await this.participantRepository.findOne({
                where: { conversationId, userId: senderId }
            });

            if (!isParticipant) {
                console.log('Validation failed: User is not participant');
                throw new ForbiddenException('You are not a participant in this conversation');
            }
            console.log('Participant check passed.');

            const message = this.messageRepository.create({
                conversationId,
                senderId,
                content
            });
            console.log('Message instance created.');

            const savedMessage = await this.messageRepository.save(message);
            console.log('Message saved successfully with id:', savedMessage.id);

            // Update last message in conversation
            await this.conversationRepository.update(conversationId, {
                lastMessageId: savedMessage.id
            });
            console.log('Conversation lastMessageId updated.');

            // Return plain object (avoid circular JSON serialization error)
            const sender = await this.usersRepository.findOne({ where: { id: senderId } });
            console.log('Sender found?', !!sender);

            return {
                id: savedMessage.id,
                conversationId: savedMessage.conversationId,
                senderId: savedMessage.senderId,
                content: savedMessage.content,
                isRead: savedMessage.isRead,
                createdAt: savedMessage.createdAt,
                updatedAt: savedMessage.updatedAt,
                sender: sender ? {
                    id: sender.id,
                    name: sender.name,
                    avatar: sender.avatar,
                    role: sender.role
                } : null
            };
        } catch (error) {
            console.error('--- ERROR IN sendMessage ---', error);
            throw error;
        }
    }

    async markAsRead(conversationId: string, userId: string) {
        await this.messageRepository.update(
            { conversationId, senderId: Not(userId), isRead: false },
            { isRead: true }
        );
        return { success: true };
    }

    async getUnreadCount(userId: string) {
        const conversations = await this.participantRepository.find({
            where: { userId },
            select: ['conversationId']
        });

        const conversationIds = conversations.map(c => c.conversationId);
        if (conversationIds.length === 0) return 0;

        const count = await this.messageRepository.count({
            where: {
                conversationId: In(conversationIds),
                senderId: Not(userId),
                isRead: false
            }
        });

        return count;
    }

    async getChatUsers(userId: string, search?: string) {
        const query = this.usersRepository.createQueryBuilder('user')
            .where('user.id != :userId', { userId })
            .andWhere('user.status = :status', { status: 'active' });

        if (search) {
            query.andWhere('(user.name ILIKE :search OR user.email ILIKE :search)', { search: `%${search}%` });
        }

        // Limit results for performance
        query.limit(20);

        const users = await query.getMany();

        return users.map(user => ({
            id: user.id,
            name: user.name,
            email: user.email,
            avatar: user.avatar,
            role: user.role
        }));
    }
}

