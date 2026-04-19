import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';

@Entity('support_faqs')
export class SupportFaq {
    @PrimaryGeneratedColumn()
    id: number;

    @Column()
    question: string;

    @Column({ type: 'text' })
    answer: string;

    @Column({ type: 'varchar', length: 255, nullable: true })
    category: string | null;

    @Column({ default: true })
    isPublished: boolean;

    @Column({ type: 'int', default: 0 })
    sortOrder: number;
}
