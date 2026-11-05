import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Last sequence number handed out for one university in one academic year. Bumped with a single
 * atomic upsert inside the same transaction that stamps the record, so two saves can never share a
 * number and a rolled-back save never burns one.
 */
@Entity('record_counters')
export class RecordCounter {
  @PrimaryColumn({ type: 'uuid' })
  universityId: string;

  @PrimaryColumn({ type: 'int' })
  academicYear: number;

  @Column({ type: 'int', default: 0 })
  lastSeq: number;
}
