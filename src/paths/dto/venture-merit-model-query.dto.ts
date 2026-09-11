import { IsOptional, IsString } from 'class-validator';

/** Optional cohort filters for the Venture Merit Model. Pool itself is scoped by caller role
 * (faculty supervision / university org / CIEL). */
export class VentureMeritModelQueryDto {
    @IsOptional()
    @IsString()
    stage?: string;

    @IsOptional()
    @IsString()
    sdgGoal?: string;
}
