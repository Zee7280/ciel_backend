import { IsString, IsEmail, IsOptional, IsBoolean, IsIn } from 'class-validator';
import {
    LEGAL_REGISTRATION_TYPES,
    ORGANIZATION_CATEGORIES,
} from '../organization-taxonomy.constants';

export class CreateOrganizationDto {
    @IsString()
    name: string;

    @IsString()
    orgType: string;

    @IsOptional()
    @IsString()
    @IsIn([...ORGANIZATION_CATEGORIES])
    organizationCategory?: string;

    @IsOptional()
    @IsString()
    @IsIn([...LEGAL_REGISTRATION_TYPES])
    legalRegistrationType?: string;

    @IsString()
    @IsOptional()
    city?: string;

    @IsOptional()
    @IsString()
    contactName?: string;

    @IsOptional()
    @IsEmail()
    contactEmail?: string;

    @IsOptional()
    @IsString()
    contactPhone?: string;

    @IsOptional()
    @IsString()
    websiteUrl?: string;

    @IsOptional()
    @IsString()
    verificationNotes?: string;
}

export class UpdateOrganizationDto {
    @IsString()
    @IsOptional()
    description?: string;

    @IsString()
    @IsOptional()
    city?: string;

    @IsString()
    @IsOptional()
    region?: string;

    @IsString()
    @IsOptional()
    address?: string;

    @IsString()
    @IsOptional()
    websiteUrl?: string;

    @IsString()
    @IsOptional()
    logoUrl?: string;

    @IsString()
    @IsOptional()
    contactName?: string;

    @IsEmail()
    @IsOptional()
    contactEmail?: string;

    @IsString()
    @IsOptional()
    contactPhone?: string;

    @IsBoolean()
    @IsOptional()
    safeguardingAcknowledged?: boolean;

    @IsBoolean()
    @IsOptional()
    dataPolicyAcknowledged?: boolean;

    @IsString()
    @IsOptional()
    userId?: string; // Optional, usually strictly via req.user.id but user mentioned passing it
}

export class AcknowledgePolicyDto {
    @IsBoolean()
    safeguarding: boolean;

    @IsBoolean()
    dataPolicy: boolean;

    @IsBoolean()
    worksWithMinors: boolean;
}

export class AdminRejectOrganizationDto {
    @IsString()
    notes: string;
}
