import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { OpportunitiesService } from './opportunities.service';
import { StudentApplyMaintenanceService } from './student-apply-maintenance.service';
import type { ApplyMaintenanceState } from './student-apply-maintenance.util';
import {
  buildPublicExploreStats,
  countBrowsePaths,
} from './student-browse-listing.util';

@Controller('public/opportunities')
export class PublicOpportunitiesController {
  constructor(
    private readonly opportunitiesService: OpportunitiesService,
    private readonly studentApplyMaintenance: StudentApplyMaintenanceService,
  ) {}

  @Get()
  async findAll(@Query() query: any) {
    const data = await this.opportunitiesService.getPublicOpportunities(query);
    const state = await this.safeApplyState();
    const decorated = state
      ? data.map((item) => ({
          ...item,
          ...this.studentApplyMaintenance.decorateOpportunity(item, state),
        }))
      : data;
    return {
      success: true,
      apply_maintenance: state
        ? {
            enabled: state.maintenanceEnabled,
            message: state.maintenanceMessage,
          }
        : undefined,
      path_counts: countBrowsePaths(decorated),
      stats: buildPublicExploreStats(decorated),
      data: decorated,
    };
  }

  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.opportunitiesService.getPublicOpportunityById(id);
    const state = await this.safeApplyState();
    return {
      success: true,
      apply_maintenance: state
        ? {
            enabled: state.maintenanceEnabled,
            message: state.maintenanceMessage,
          }
        : undefined,
      data: state
        ? {
            ...data,
            ...this.studentApplyMaintenance.decorateOpportunity(data, state),
          }
        : data,
    };
  }

  private async safeApplyState(): Promise<ApplyMaintenanceState | null> {
    try {
      return await this.studentApplyMaintenance.getState();
    } catch {
      return null;
    }
  }
}
