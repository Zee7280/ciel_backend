import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, Min, ValidateNested } from 'class-validator';

export class CommunityAwardPickDto {
    @IsString()
    reportId: string;
    @Type(() => Number)
    @IsInt()
    @Min(1)
    rank: number;
    @IsOptional() @Type(() => Number) @IsInt() @Min(1) of?: number;
    @IsOptional() @Type(() => Number) @IsNumber() total?: number;
}

export class NotifyCommunityAwardDto {
    @IsOptional()
    @IsIn(['fac', 'par', 'uni', 'ciel'])
    kind?: 'fac' | 'par' | 'uni' | 'ciel';
    @IsOptional() @IsString() scopeLabel?: string;
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(3)
    @ValidateNested({ each: true })
    @Type(() => CommunityAwardPickDto)
    picks?: CommunityAwardPickDto[];
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(3)
    @IsString({ each: true })
    reportIds?: string[];
}
