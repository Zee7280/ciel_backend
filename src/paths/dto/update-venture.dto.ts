import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsOptional, IsString, ValidateNested } from 'class-validator';

export class VentureTractionRowDto {
    @IsString()
    date: string;

    @IsString()
    metric: string;

    @IsString()
    value: string;

    @IsOptional()
    @IsString()
    note?: string;
}

export class VentureTeamMemberDto {
    @IsString()
    name: string;

    @IsString()
    role: string;

    @IsOptional()
    @IsString()
    email?: string;
}

export class UpdateVentureDto {
    @IsOptional()
    @IsString()
    ventureName?: string;

    @IsOptional()
    @IsString()
    description?: string;

    @IsOptional()
    @IsString()
    stage?: string;

    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => VentureTractionRowDto)
    tractionRows?: VentureTractionRowDto[];

    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => VentureTeamMemberDto)
    team?: VentureTeamMemberDto[];

    @IsOptional()
    @IsArray()
    materialUrls?: string[];
}

export class SetVentureVisibilityDto {
    @IsBoolean()
    isVisible: boolean;
}
