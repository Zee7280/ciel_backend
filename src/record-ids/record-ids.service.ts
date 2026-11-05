import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  EntityTarget,
  ObjectLiteral,
  Repository,
} from 'typeorm';
import { PAKISTANI_UNIVERSITIES } from '../auth/constants/pakistani-universities';
import {
  foldUniversityName,
  universityNamesMatch,
} from '../opportunities/university-scope.util';
import { Organization } from '../organizations/entities/organization.entity';
import { CourseProjectEntry } from '../paths/entities/course-project-entry.entity';
import { FypEntry } from '../paths/entities/fyp-entry.entity';
import { VentureEntry } from '../paths/entities/venture-entry.entity';
import { QuickWorkLog } from '../quick-work/entities/quick-work-log.entity';
import { StudentReport } from '../reports/entities/student-report.entity';
import { User } from '../users/entities/user.entity';
import { RecordCounter } from './entities/record-counter.entity';
import { University } from './entities/university.entity';
import {
  academicYearOf,
  aliasesFor,
  deriveUniversityCode,
  formatPublicId,
  normalizeUniversityCode,
  parsePublicId,
  RECORD_KINDS,
  RecordKind,
} from './record-id.util';
import { UNIVERSITY_CODES } from './university-codes';

export type UniversityResolveInput = {
  /** The account's own organisation link (university staff / linked students). */
  organizationId?: string | null;
  /** Profile fields the student picked at signup. */
  university?: string | null;
  institution?: string | null;
  /** University names typed on the record itself — only used when the profile cannot decide. */
  claims?: Array<string | null | undefined>;
};

/** The few fields of the five record entities this service reads. */
type RecordShape = {
  userId?: string | null;
  leadUserId?: string | null;
  studentId?: string | null;
  status?: string | null;
  projectTitle?: string | null;
  course?: string | null;
  ventureName?: string | null;
  university?: string | null;
  projectInfo?: { title?: string | null; university?: string | null } | null;
  studentInfo?: { universityName?: string | null } | null;
  academicSetup?: { university?: string | null } | null;
  section1?: { team_lead?: { university?: string | null } | null } | null;
};

type KindConfig = {
  table: string;
  entity: EntityTarget<ObjectLiteral>;
  ownerOf: (e: RecordShape) => string | null;
  claimsOf: (e: RecordShape) => Array<string | null | undefined>;
  /** SQL predicate: the row has reached the point where it should carry an id. */
  eligibleSql: string;
  /** The same predicate for an in-memory entity (save paths). Keep the two in step. */
  eligible: (e: RecordShape) => boolean;
};

const hasText = (v: unknown): boolean =>
  typeof v === 'string' && v.trim() !== '';

const nonEmpty = (col: string) => `TRIM(COALESCE(${col}, '')) <> ''`;

const KINDS: Record<RecordKind, KindConfig> = {
  fyp: {
    table: 'fyp_entries',
    entity: FypEntry,
    ownerOf: (e) => e.userId ?? null,
    claimsOf: (e) => [e.projectInfo?.university],
    eligibleSql: `(${nonEmpty('"projectTitle"')} OR ${nonEmpty(`"projectInfo"->>'title'`)})`,
    eligible: (e) => hasText(e.projectTitle) || hasText(e.projectInfo?.title),
  },
  coursework: {
    table: 'course_project_entries',
    entity: CourseProjectEntry,
    ownerOf: (e) => e.userId ?? null,
    claimsOf: (e) => [e.studentInfo?.universityName],
    eligibleSql: `(${nonEmpty('"projectTitle"')} OR ${nonEmpty('"course"')})`,
    eligible: (e) => hasText(e.projectTitle) || hasText(e.course),
  },
  startup: {
    table: 'venture_entries',
    entity: VentureEntry,
    ownerOf: (e) => e.userId ?? null,
    claimsOf: (e) => [e.academicSetup?.university],
    eligibleSql: nonEmpty('"ventureName"'),
    eligible: (e) => hasText(e.ventureName),
  },
  quick_impact: {
    table: 'quick_work_logs',
    entity: QuickWorkLog,
    ownerOf: (e) => e.leadUserId ?? null,
    claimsOf: (e) => [e.university],
    eligibleSql: `"status" <> 'draft'`,
    eligible: (e) => e.status !== 'draft',
  },
  community_engagement: {
    table: 'student_reports',
    entity: StudentReport,
    ownerOf: (e) => e.studentId ?? null,
    claimsOf: (e) => [e.section1?.team_lead?.university],
    eligibleSql: `LOWER(COALESCE("status", '')) NOT IN ('draft', 'continue', '')`,
    eligible: (e) =>
      !['draft', 'continue', ''].includes(String(e.status ?? '').toLowerCase()),
  },
};

export type BackfillReport = {
  dryRun: boolean;
  universitiesSeeded: number;
  recordsLinked: number;
  idsIssued: number;
  idsWouldIssue: number;
  unmatched: { kind: string; university: string; records: number }[];
};

@Injectable()
export class RecordIdsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RecordIdsService.name);
  private cache: { rows: University[]; expiresAt: number } | null = null;
  private static readonly CACHE_TTL_MS = 60_000;

  constructor(
    @InjectRepository(University)
    private readonly universities: Repository<University>,
    @InjectRepository(Organization)
    private readonly organizations: Repository<Organization>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /**
   * Cheap and idempotent: one query when everything is already there, and it only inserts listed
   * universities that are missing. Organisations are linked lazily the first time one is resolved
   * (and in full by the admin backfill), so a cold start never loops over every organisation.
   * Never blocks or fails startup.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    try {
      await this.seedUniversities({ linkOrganizations: false });
    } catch (err) {
      this.logger.error(
        `University seed failed: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  /* --------------------------------------------------------- universities */

  invalidateCache(): void {
    this.cache = null;
  }

  async listUniversities(): Promise<University[]> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) return this.cache.rows;
    const rows = await this.universities.find({ order: { name: 'ASC' } });
    this.cache = {
      rows,
      expiresAt: now + RecordIdsService.CACHE_TTL_MS,
    };
    return rows;
  }

  /** Inserts the listed universities that are missing and links onboarded university organisations. */
  async seedUniversities(
    opts: { linkOrganizations?: boolean } = {},
  ): Promise<number> {
    const existing = await this.universities.find();
    const takenCodes = new Set(existing.map((u) => u.code));
    const knownNames = new Set(existing.map((u) => foldUniversityName(u.name)));
    let created = 0;
    for (const name of PAKISTANI_UNIVERSITIES) {
      if (knownNames.has(foldUniversityName(name))) continue;
      let code = UNIVERSITY_CODES[name];
      if (!code || takenCodes.has(code)) {
        code = deriveUniversityCode(name, takenCodes);
      }
      try {
        await this.universities.save(
          this.universities.create({
            code,
            name,
            aliases: aliasesFor(name),
            active: true,
          }),
        );
        created += 1;
      } catch (err) {
        // Another instance seeded the same university a moment ago (unique code): carry on.
        const pg =
          (err as { code?: string; driverError?: { code?: string } }) ?? {};
        if ((pg.code ?? pg.driverError?.code) !== '23505') throw err;
      }
      takenCodes.add(code);
      knownNames.add(foldUniversityName(name));
    }
    if (opts.linkOrganizations !== false) {
      const orgs = await this.organizations
        .createQueryBuilder('o')
        .where('LOWER(o."orgType") = :t', { t: 'university' })
        .getMany();
      for (const org of orgs) await this.ensureUniversityForOrg(org);
    }
    this.invalidateCache();
    return created;
  }

  private matchesUniversity(name: string, uni: University): boolean {
    return (
      universityNamesMatch(name, uni.name) ||
      (uni.aliases ?? []).some((alias) => universityNamesMatch(name, alias))
    );
  }

  private findByName(name: unknown, rows: University[]): University | null {
    if (typeof name !== 'string' || !foldUniversityName(name)) return null;
    const folded = foldUniversityName(name);
    return (
      rows.find((u) => foldUniversityName(u.name) === folded) ??
      rows.find((u) => this.matchesUniversity(name, u)) ??
      null
    );
  }

  /** The university row for an onboarded organisation, creating / linking it when needed. */
  async ensureUniversityForOrg(
    org: Pick<Organization, 'id' | 'name' | 'orgType'>,
  ): Promise<University | null> {
    const rows = await this.universities.find();
    const linked = rows.find((u) => u.organizationId === org.id);
    if (linked) return linked;
    if (String(org.orgType || '').toLowerCase() !== 'university') return null;
    const byName = this.findByName(org.name, rows);
    if (byName) {
      // A second account for the same university shares the row; only the first one links.
      if (!byName.organizationId) {
        byName.organizationId = org.id;
        await this.universities.save(byName);
        this.invalidateCache();
      }
      return byName;
    }
    const code = deriveUniversityCode(
      org.name,
      new Set(rows.map((u) => u.code)),
    );
    const created = await this.universities.save(
      this.universities.create({
        code,
        name: org.name,
        aliases: [],
        organizationId: org.id,
        active: true,
      }),
    );
    this.invalidateCache();
    return created;
  }

  /**
   * One rule for "which university is this?" — same order of authority as
   * isAffiliatedWithUniversity: the account's organisation, then the profile, then any name typed
   * on the record (which can never override a profile that names a listed university).
   */
  async resolveUniversityId(
    input: UniversityResolveInput,
  ): Promise<string | null> {
    const rows = await this.listUniversities();
    if (input.organizationId) {
      const linked = rows.find(
        (u) => u.organizationId === input.organizationId,
      );
      if (linked) return linked.id;
      const org = await this.organizations.findOne({
        where: { id: input.organizationId },
      });
      if (org) {
        const uni = await this.ensureUniversityForOrg(org);
        if (uni) return uni.id;
      }
    }
    for (const name of [input.university, input.institution]) {
      const hit = this.findByName(name, rows);
      if (hit) return hit.id;
    }
    for (const name of input.claims ?? []) {
      const hit = this.findByName(name, rows);
      if (hit) return hit.id;
    }
    return null;
  }

  private async resolveForOwner(
    manager: EntityManager,
    ownerId: string | null,
    claims: Array<string | null | undefined>,
  ): Promise<string | null> {
    if (!ownerId) return this.resolveUniversityId({ claims });
    const owner = await manager.getRepository(User).findOne({
      where: { id: ownerId },
      relations: ['organization'],
    });
    const fromProfile = owner
      ? await this.resolveUniversityId({
          organizationId: owner.organization?.id,
          university: owner.university,
          institution: owner.institution,
        })
      : null;
    return fromProfile ?? this.resolveUniversityId({ claims });
  }

  /* ----------------------------------------------------------------- ids */

  /**
   * Stamps a record with its public id (once). Safe to call on every save: an already-stamped record
   * returns its id untouched, concurrent callers serialise on the row lock, and a record whose
   * university cannot be resolved stays unstamped (returns null) instead of getting a made-up code.
   */
  async issue(
    kind: RecordKind,
    id: string,
    opts: { at?: Date } = {},
  ): Promise<string | null> {
    const cfg = KINDS[kind];
    return this.dataSource.transaction(async (manager) => {
      const locked: { publicId: string | null }[] = await manager.query(
        `SELECT "publicId" FROM "${cfg.table}" WHERE "id" = $1 FOR UPDATE`,
        [id],
      );
      if (!locked.length) return null;
      if (locked[0].publicId) return locked[0].publicId;
      const entity = (await manager
        .getRepository(cfg.entity)
        .findOne({ where: { id } as never })) as RecordShape | null;
      if (!entity) return null;
      const universityId = await this.resolveForOwner(
        manager,
        cfg.ownerOf(entity),
        cfg.claimsOf(entity),
      );
      if (!universityId) return null;
      const uni = (await this.listUniversities()).find(
        (u) => u.id === universityId,
      );
      if (!uni) return null;
      const year = academicYearOf(opts.at ?? new Date());
      const rows: { lastSeq: number }[] = await manager.query(
        `INSERT INTO "record_counters" ("universityId", "academicYear", "lastSeq")
         VALUES ($1, $2, 1)
         ON CONFLICT ("universityId", "academicYear")
         DO UPDATE SET "lastSeq" = "record_counters"."lastSeq" + 1
         RETURNING "lastSeq"`,
        [universityId, year],
      );
      const publicId = formatPublicId(uni.code, year, Number(rows[0].lastSeq));
      await manager.query(
        `UPDATE "${cfg.table}" SET "publicId" = $1, "universityId" = $2 WHERE "id" = $3`,
        [publicId, universityId, id],
      );
      return publicId;
    });
  }

  /** Best-effort wrapper for save paths: a failed stamp must never fail the student's save. */
  async issueSafely(
    kind: RecordKind,
    id: string,
    opts: { at?: Date } = {},
  ): Promise<string | null> {
    try {
      return await this.issue(kind, id, opts);
    } catch (err) {
      this.logger.error(
        `Public id for ${kind}/${id} failed: ${(err as Error)?.message ?? err}`,
        (err as Error)?.stack,
      );
      return null;
    }
  }

  /** The row's id (and university) after a stamp, for callers that hold a stale entity copy. */
  async stampOnto<
    T extends {
      id: string;
      publicId?: string | null;
      universityId?: string | null;
    },
  >(kind: RecordKind, entity: T, opts: { at?: Date } = {}): Promise<T> {
    if (entity.publicId) return entity;
    if (!KINDS[kind].eligible(entity as RecordShape)) return entity;
    const publicId = await this.issueSafely(kind, entity.id, opts);
    if (!publicId) return entity;
    entity.publicId = publicId;
    const rows: { universityId: string | null }[] = await this.dataSource.query(
      `SELECT "universityId" FROM "${KINDS[kind].table}" WHERE "id" = $1`,
      [entity.id],
    );
    entity.universityId = rows[0]?.universityId ?? null;
    return entity;
  }

  async universityIdForOrganization(
    organizationId: string,
  ): Promise<string | null> {
    return this.resolveUniversityId({ organizationId });
  }

  /* ------------------------------------------------------------ admin ops */

  async lookup(publicId: string) {
    const parsed = parsePublicId(publicId);
    if (!parsed) return null;
    const id = `CIEL-${parsed.code}-${parsed.academicYear}-${String(parsed.seq).padStart(4, '0')}`;
    for (const kind of RECORD_KINDS) {
      const rows: { id: string; universityId: string | null }[] =
        await this.dataSource.query(
          `SELECT "id", "universityId" FROM "${KINDS[kind].table}" WHERE "publicId" = $1`,
          [id],
        );
      if (rows.length) {
        return {
          kind,
          publicId: id,
          recordId: rows[0].id,
          universityId: rows[0].universityId,
        };
      }
    }
    return null;
  }

  /** Links users and records to universities and stamps ids on existing records, oldest first. */
  async backfill(
    dryRun: boolean,
    limit?: number,
  ): Promise<BackfillReport & { remaining: number }> {
    const report: BackfillReport & { remaining: number } = {
      remaining: 0,
      dryRun,
      universitiesSeeded: 0,
      recordsLinked: 0,
      idsIssued: 0,
      idsWouldIssue: 0,
      unmatched: [],
    };
    if (!dryRun) report.universitiesSeeded = await this.seedUniversities();
    const unmatched = new Map<string, number>();
    const noteUnmatched = (kind: string, name: string) => {
      const key = `${kind}\u0000${name}`;
      unmatched.set(key, (unmatched.get(key) ?? 0) + 1);
    };

    // Records only: a user row carries no university id (the users table is deliberately never
    // altered). Each record is resolved from its owner's profile, so nothing is stored per user.
    // records — gather everything that still needs an id, then stamp strictly oldest first so
    // sequence numbers follow history across all five modules.
    type Candidate = { kind: RecordKind; id: string; at: Date };
    const candidates: Candidate[] = [];
    for (const kind of RECORD_KINDS) {
      const cfg = KINDS[kind];
      const rows: { id: string; createdAt: Date }[] =
        await this.dataSource.query(
          `SELECT "id", "createdAt" FROM "${cfg.table}"
           WHERE "publicId" IS NULL AND ${cfg.eligibleSql}`,
        );
      for (const r of rows) {
        candidates.push({ kind, id: r.id, at: new Date(r.createdAt) });
      }
    }
    candidates.sort((a, b) => a.at.getTime() - b.at.getTime());
    // Optional batch size: the job is resumable (a stamped record is never picked again, and the
    // oldest unstamped records always come first), so a big dataset can be done in several calls
    // without hitting a request timeout.
    const batch =
      limit && limit > 0 ? candidates.slice(0, Math.floor(limit)) : candidates;
    report.remaining = candidates.length - batch.length;
    for (const c of batch) {
      const cfg = KINDS[c.kind];
      const entity = (await this.dataSource
        .getRepository(cfg.entity)
        .findOne({ where: { id: c.id } as never })) as Record<
        string,
        any
      > | null;
      if (!entity) continue;
      const owner = cfg.ownerOf(entity)
        ? await this.users.findOne({
            where: { id: cfg.ownerOf(entity) as string },
            relations: ['organization'],
          })
        : null;
      const universityId =
        (await this.resolveUniversityId({
          organizationId: owner?.organization?.id,
          university: owner?.university,
          institution: owner?.institution,
        })) ??
        (await this.resolveUniversityId({ claims: cfg.claimsOf(entity) }));
      if (!universityId) {
        const claimed =
          [owner?.university, owner?.institution, ...cfg.claimsOf(entity)].find(
            (n) => typeof n === 'string' && n.trim(),
          ) ?? '(no university given)';
        noteUnmatched(c.kind, String(claimed).trim());
        continue;
      }
      report.recordsLinked += 1;
      if (dryRun) {
        report.idsWouldIssue += 1;
        continue;
      }
      const issued = await this.issue(c.kind, c.id, { at: c.at });
      if (issued) report.idsIssued += 1;
    }
    report.unmatched = [...unmatched.entries()]
      .map(([key, records]) => {
        const [kind, university] = key.split('\u0000');
        return { kind, university, records };
      })
      .sort((a, b) => b.records - a.records);
    return report;
  }

  async unmatched() {
    return (await this.backfill(true)).unmatched;
  }

  async createUniversity(dto: {
    name: string;
    code: string;
    organizationId?: string | null;
    aliases?: string[];
  }) {
    const code = normalizeUniversityCode(dto.code);
    if (code.length < 2 || code.length > 10) {
      throw new Error('Code must be 2–10 letters or digits');
    }
    const created = await this.universities.save(
      this.universities.create({
        code,
        name: dto.name.trim(),
        aliases: (dto.aliases ?? []).map((a) => a.trim()).filter(Boolean),
        organizationId: dto.organizationId ?? null,
        active: true,
      }),
    );
    this.invalidateCache();
    return created;
  }

  async codeHasIds(universityId: string): Promise<boolean> {
    const n = await this.dataSource
      .getRepository(RecordCounter)
      .count({ where: { universityId } });
    return n > 0;
  }

  async updateUniversity(
    id: string,
    dto: {
      name?: string;
      code?: string;
      aliases?: string[];
      organizationId?: string | null;
      active?: boolean;
    },
  ) {
    const uni = await this.universities.findOne({ where: { id } });
    if (!uni) return null;
    if (dto.code !== undefined) {
      const code = normalizeUniversityCode(dto.code);
      if (code !== uni.code) {
        if (await this.codeHasIds(id)) {
          throw new Error(
            'This university already has public ids — its code can no longer change',
          );
        }
        if (code.length < 2 || code.length > 10) {
          throw new Error('Code must be 2–10 letters or digits');
        }
        uni.code = code;
      }
    }
    if (dto.name !== undefined) uni.name = dto.name.trim();
    if (dto.aliases !== undefined) {
      uni.aliases = dto.aliases.map((a) => a.trim()).filter(Boolean);
    }
    if (dto.organizationId !== undefined)
      uni.organizationId = dto.organizationId;
    if (dto.active !== undefined) uni.active = dto.active;
    const saved = await this.universities.save(uni);
    this.invalidateCache();
    return saved;
  }
}
