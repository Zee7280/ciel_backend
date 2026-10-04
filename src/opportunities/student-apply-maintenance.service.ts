import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Setting } from '../settings/entities/setting.entity';
import {
  ApplyGateFields,
  ApplyMaintenanceState,
  STUDENT_APPLY_CLOSED_BEFORE_KEY,
  STUDENT_APPLY_EXPIRED_MESSAGE_KEY,
  STUDENT_APPLY_MAINTENANCE_ENABLED_KEY,
  STUDENT_APPLY_MAINTENANCE_MESSAGE_KEY,
  decorateApplyGate,
  parseApplyExpiredMessage,
  parseApplyMaintenanceMessage,
  parseBooleanSettingValue,
  parseClosedBeforeSettingValue,
} from './student-apply-maintenance.util';

@Injectable()
export class StudentApplyMaintenanceService implements OnModuleInit {
  private cache: { state: ApplyMaintenanceState; expiresAt: number } | null =
    null;
  private readonly cacheTtlMs = 30_000;

  constructor(
    @InjectRepository(Setting)
    private readonly settingRepository: Repository<Setting>,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.seedClosedBeforeIfMissing();
      await this.refreshCache();
    } catch {
      this.cache = null;
    }
  }

  invalidateCache(): void {
    this.cache = null;
  }

  async refreshCache(): Promise<ApplyMaintenanceState> {
    const empty: ApplyMaintenanceState = {
      maintenanceEnabled: false,
      maintenanceMessage: parseApplyMaintenanceMessage(null),
      closedBefore: null,
      expiredMessage: parseApplyExpiredMessage(null),
    };
    try {
      const rows =
        typeof this.settingRepository.find === 'function'
          ? await this.settingRepository.find({
              where: {
                key: In([
                  STUDENT_APPLY_MAINTENANCE_ENABLED_KEY,
                  STUDENT_APPLY_MAINTENANCE_MESSAGE_KEY,
                  STUDENT_APPLY_CLOSED_BEFORE_KEY,
                  STUDENT_APPLY_EXPIRED_MESSAGE_KEY,
                ]),
              },
            })
          : [];
      const map = new Map(rows.map((row) => [row.key, row.value]));
      const state: ApplyMaintenanceState = {
        maintenanceEnabled: parseBooleanSettingValue(
          map.get(STUDENT_APPLY_MAINTENANCE_ENABLED_KEY),
          false,
        ),
        maintenanceMessage: parseApplyMaintenanceMessage(
          map.get(STUDENT_APPLY_MAINTENANCE_MESSAGE_KEY),
        ),
        closedBefore: parseClosedBeforeSettingValue(
          map.get(STUDENT_APPLY_CLOSED_BEFORE_KEY),
        ),
        expiredMessage: parseApplyExpiredMessage(
          map.get(STUDENT_APPLY_EXPIRED_MESSAGE_KEY),
        ),
      };
      this.cache = { state, expiresAt: Date.now() + this.cacheTtlMs };
      return state;
    } catch {
      this.cache = { state: empty, expiresAt: Date.now() + this.cacheTtlMs };
      return empty;
    }
  }

  async getState(): Promise<ApplyMaintenanceState> {
    if (this.cache && Date.now() < this.cache.expiresAt) {
      return this.cache.state;
    }
    // Read-only: seeding happens once at boot (onModuleInit) and only when the row is missing,
    // never from a request path, so an admin-disabled expiry can never be re-enabled by a GET.
    return this.refreshCache();
  }

  decorateOpportunity(
    opportunity: {
      createdAt?: Date | string | null;
      admin_hidden?: boolean;
      admin_expired?: boolean;
    },
    state: ApplyMaintenanceState,
  ): ApplyGateFields {
    return decorateApplyGate(opportunity, state);
  }

  async assertNewApplicationsAllowed(opportunity: {
    createdAt?: Date | string | null;
    admin_hidden?: boolean;
    admin_expired?: boolean;
  }): Promise<void> {
    const state = await this.getState();
    const gate = decorateApplyGate(opportunity, state);
    if (!gate.applications_open) {
      throw new BadRequestException(
        gate.apply_blocked_message ||
          'This opportunity is not open for new applications.',
      );
    }
  }

  /**
   * First boot after this feature: stamp cutoff = now so already-created
   * listings stop accepting applies without touching enrolled reports.
   */
  async seedClosedBeforeIfMissing(): Promise<Date | null> {
    try {
      if (typeof this.settingRepository.findOne !== 'function') {
        return null;
      }
      const existing = await this.settingRepository.findOne({
        where: { key: STUDENT_APPLY_CLOSED_BEFORE_KEY },
      });
      // Row exists (even as 'disabled' or empty) = an admin decision; never overwrite it.
      if (existing) {
        return parseClosedBeforeSettingValue(existing.value);
      }
      if (typeof this.settingRepository.create !== 'function') {
        return null;
      }
      const stamped = new Date();
      const row = this.settingRepository.create({
        key: STUDENT_APPLY_CLOSED_BEFORE_KEY,
        value: stamped.toISOString(),
        type: 'string',
        description:
          'Listings created on or before this time do not accept new student applications.',
      });
      await this.settingRepository.save(row);
      this.invalidateCache();
      return stamped;
    } catch {
      return null;
    }
  }
}
