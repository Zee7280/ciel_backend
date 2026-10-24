import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ExternalMetricCatalog, ExternalMetricValue } from '../entities';
import { HUB_CONNECTION } from '../hub-connection.constants';
import { HubActor, HubAuditService } from '../audit/hub-audit.service';
import { MetricDefinitionDto } from '../platforms/dto/platform.dto';

export const METRIC_CLASSIFICATIONS: string[] = [
  'observed',
  'self_reported',
  'estimated',
  'projected',
  'externally_verified',
];

export type MetricValidation =
  | { ok: true; metrics: ExternalMetricValue[] }
  | { ok: false; errors: string[] };

/** Pure validation against a catalog map; exported for the processing tests. */
export function validateMetricValues(
  input: ExternalMetricValue[] | undefined,
  catalog: Map<string, ExternalMetricCatalog>,
): MetricValidation {
  const errors: string[] = [];
  const out: ExternalMetricValue[] = [];
  const seen = new Set<string>();
  for (const m of input ?? []) {
    const def = catalog.get(m.code);
    if (!def || !def.active) {
      errors.push(`metric "${m.code}" is not in the catalog`);
      continue;
    }
    if (seen.has(m.code)) {
      errors.push(`metric "${m.code}" repeated`);
      continue;
    }
    seen.add(m.code);
    if (typeof m.value !== 'number' || !Number.isFinite(m.value)) {
      errors.push(`metric "${m.code}" value must be a finite number`);
      continue;
    }
    if (def.dataType === 'integer' && !Number.isInteger(m.value)) {
      errors.push(`metric "${m.code}" must be an integer`);
      continue;
    }
    const min = def.minValue !== null ? Number(def.minValue) : null;
    const max = def.maxValue !== null ? Number(def.maxValue) : null;
    if (min !== null && m.value < min)
      errors.push(`metric "${m.code}" below minimum ${min}`);
    if (max !== null && m.value > max)
      errors.push(`metric "${m.code}" above maximum ${max}`);
    if (m.unit && m.unit !== def.unit) {
      errors.push(`metric "${m.code}" unit must be ${def.unit}`);
    }
    out.push({
      code: m.code,
      value: m.value,
      unit: def.unit,
      classification:
        m.classification && METRIC_CLASSIFICATIONS.includes(m.classification)
          ? m.classification
          : def.defaultClassification,
      ...(m.method ? { method: String(m.method).slice(0, 200) } : {}),
    });
  }
  return errors.length ? { ok: false, errors } : { ok: true, metrics: out };
}

@Injectable()
export class MetricCatalogService {
  private cache: {
    map: Map<string, ExternalMetricCatalog>;
    expiresAt: number;
  } | null = null;

  constructor(
    @InjectRepository(ExternalMetricCatalog, HUB_CONNECTION)
    private readonly repo: Repository<ExternalMetricCatalog>,
    private readonly audit: HubAuditService,
  ) {}

  invalidate(): void {
    this.cache = null;
  }

  async catalogMap(): Promise<Map<string, ExternalMetricCatalog>> {
    if (this.cache && this.cache.expiresAt > Date.now()) return this.cache.map;
    const rows = await this.repo.find();
    const map = new Map(rows.map((r) => [r.code, r]));
    this.cache = { map, expiresAt: Date.now() + 60_000 };
    return map;
  }

  async validate(
    input: ExternalMetricValue[] | undefined,
  ): Promise<MetricValidation> {
    return validateMetricValues(input, await this.catalogMap());
  }

  list(): Promise<ExternalMetricCatalog[]> {
    return this.repo.find({ order: { code: 'ASC' } });
  }

  async create(
    dto: MetricDefinitionDto,
    actor: HubActor,
  ): Promise<ExternalMetricCatalog> {
    if (await this.repo.findOne({ where: { code: dto.code } })) {
      throw new ConflictException(`Metric "${dto.code}" already exists`);
    }
    const row = this.repo.create(
      this.apply(this.repo.create({ code: dto.code }), dto),
    );
    await this.repo.save(row);
    this.invalidate();
    await this.audit.log({
      actor,
      action: 'METRIC_CREATED',
      targetType: 'metric',
      targetId: row.id,
      details: { code: row.code, unit: row.unit, aggregation: row.aggregation },
    });
    return row;
  }

  async update(id: string, dto: Partial<MetricDefinitionDto>, actor: HubActor) {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Metric not found');
    this.apply(row, dto);
    await this.repo.save(row);
    this.invalidate();
    await this.audit.log({
      actor,
      action: 'METRIC_UPDATED',
      targetType: 'metric',
      targetId: row.id,
      details: { code: row.code, changed: Object.keys(dto) },
    });
    return row;
  }

  private apply(
    row: ExternalMetricCatalog,
    dto: Partial<MetricDefinitionDto>,
  ): ExternalMetricCatalog {
    if (dto.name !== undefined) row.name = dto.name.trim();
    if (dto.unit !== undefined) row.unit = dto.unit.trim();
    if (dto.dataType !== undefined) row.dataType = dto.dataType;
    if (dto.aggregation !== undefined) row.aggregation = dto.aggregation;
    if (dto.defaultClassification !== undefined)
      row.defaultClassification = dto.defaultClassification;
    if (dto.minValue !== undefined) {
      row.minValue =
        dto.minValue === null ? null : String(Number(dto.minValue));
    }
    if (dto.maxValue !== undefined) {
      row.maxValue =
        dto.maxValue === null ? null : String(Number(dto.maxValue));
    }
    if (dto.sector !== undefined) row.sector = dto.sector.trim() || null;
    if (dto.sdgs !== undefined)
      row.sdgs = dto.sdgs.filter((n) => n >= 1 && n <= 17);
    if (dto.methodologyNotes !== undefined)
      row.methodologyNotes = dto.methodologyNotes.trim() || null;
    if (dto.platformFieldMappings !== undefined)
      row.platformFieldMappings = dto.platformFieldMappings;
    if (dto.active !== undefined) row.active = dto.active;
    return row;
  }
}
