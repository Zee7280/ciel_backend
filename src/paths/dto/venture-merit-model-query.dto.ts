import { IsOptional, IsString } from 'class-validator';

/** Minimal filter set for Phase A+B — faculty-only pool, no cross-scope filters needed yet
 * (no listVenturesForUniversity exists). Room to grow once university/CIEL scoping is added. */
export class VentureMeritModelQueryDto {
    @IsOptional()
    @IsString()
    stage?: string;

    @IsOptional()
    @IsString()
    sdgGoal?: string;
}
