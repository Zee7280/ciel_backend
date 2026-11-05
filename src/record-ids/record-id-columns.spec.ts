import { getMetadataArgsStorage } from 'typeorm';
import { CourseProjectEntry } from '../paths/entities/course-project-entry.entity';
import { FypEntry } from '../paths/entities/fyp-entry.entity';
import { VentureEntry } from '../paths/entities/venture-entry.entity';
import { QuickWorkLog } from '../quick-work/entities/quick-work-log.entity';
import { StudentReport } from '../reports/entities/student-report.entity';

/**
 * A public id must survive a stale entity being saved later. TypeORM's save() diffs an entity
 * against the row, so a copy loaded before the id was issued (publicId = null) would write NULL
 * over it. `update: false` makes these columns insert-only for the ORM; only RecordIdsService
 * (raw SQL) writes them. This was reproduced against Postgres before the guard was added.
 */
describe.each([
  ['fyp_entries', FypEntry],
  ['course_project_entries', CourseProjectEntry],
  ['venture_entries', VentureEntry],
  ['quick_work_logs', QuickWorkLog],
  ['student_reports', StudentReport],
])('%s record-id columns', (_table, entity) => {
  const col = (name: string) =>
    getMetadataArgsStorage().columns.find(
      (c) => c.target === entity && c.propertyName === name,
    );

  it.each(['publicId', 'universityId'])(
    '%s is nullable and ORM-write-once',
    (name) => {
      const c = col(name);
      expect(c).toBeDefined();
      expect(c?.options.nullable).toBe(true);
      expect(c?.options.update).toBe(false);
    },
  );
});
