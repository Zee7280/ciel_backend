import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, OneToMany, OneToOne, JoinColumn } from 'typeorm';
import { ConversationParticipant } from './conversation-participant.entity';
import { Message } from './message.entity';

@Entity('conversations')
export class Conversation {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ default: 'DIRECT' })
    type: string; // DIRECT, GROUP

    @Column({ nullable: true })
    lastMessageId: string;

    @OneToOne(() => Message, { nullable: true })
    @JoinColumn({ name: 'lastMessageId' })
    lastMessage: Message;

    @OneToMany(() => ConversationParticipant, (participant) => participant.conversation)
    participants: ConversationParticipant[];

    @OneToMany(() => Message, (message) => message.conversation)
    messages: Message[];

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
