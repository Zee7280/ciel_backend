import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Optional note CIEL PK sends to the creator together with the final approval. */
export class AdminApproveOpportunityDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  instructions?: string;
}
