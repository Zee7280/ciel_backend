import {
    Column,
    CreateDateColumn,
    Entity,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';

@Entity('platform_tutorials')
export class PlatformTutorial {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'varchar', length: 255 })
    title: string;

    @Column({ type: 'text', default: '' })
    description: string;

    @Column({ type: 'varchar', length: 120, default: 'General' })
    category: string;

    @Column({ type: 'varchar', length: 2048 })
    videoUrl: string;

    @Column({ type: 'varchar', length: 2048, nullable: true })
    posterUrl: string | null;

    @Column({ type: 'varchar', length: 32, nullable: true })
    durationLabel: string | null;

    @Column({ type: 'varchar', length: 2048, nullable: true })
    documentUrl: string | null;

    @Column({ type: 'varchar', length: 512, nullable: true })
    documentFilename: string | null;

    @Column({ type: 'int', default: 0 })
    sortOrder: number;

    @CreateDateColumn({ type: 'timestamptz' })
    createdAt: Date;

    @UpdateDateColumn({ type: 'timestamptz' })
    updatedAt: Date;
}
