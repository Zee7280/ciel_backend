import { Type } from 'class-transformer';
import { IsArray, IsIn, IsOptional, IsString, ValidateNested } from 'class-validator';

export class FypMilestoneDto {
    @IsString()
    label: string;

    @IsIn(['pending', 'in_progress', 'complete'])
    status: 'pending' | 'in_progress' | 'complete';

    @IsOptional()
    @IsString()
    dueDate?: string | null;

    @IsOptional()
    @IsString()
    completedAt?: string | null;
}

export class FypCommunityLinkageDto {
    @IsOptional()
    @IsString()
    orgName?: string;

    @IsOptional()
    @IsString()
    contactName?: string;

    @IsOptional()
    @IsString()
    contactEmail?: string;

    @IsOptional()
    @IsString()
    description?: string;
}

export class UpdateFypDto {
    @IsOptional()
    @IsString()
    projectTitle?: string;

    @IsOptional()
    @IsString()
    overview?: string;

    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => FypMilestoneDto)
    milestones?: FypMilestoneDto[];

    @IsOptional()
    @ValidateNested()
    @Type(() => FypCommunityLinkageDto)
    communityLinkage?: FypCommunityLinkageDto;
}

export class AddFypDeliverableDto {
    @IsString()
    label: string;

    @IsString()
    fileUrl: string;
}
