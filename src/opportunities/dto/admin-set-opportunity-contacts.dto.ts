import { IsOptional, IsString } from 'class-validator';

export class AdminSetOpportunityContactsDto {
  @IsString()
  @IsOptional()
  faculty_supervisor_name?: string;

  @IsString()
  @IsOptional()
  faculty_supervisor_email?: string;

  @IsString()
  @IsOptional()
  partner_organization_name?: string;

  @IsString()
  @IsOptional()
  partner_contact_person?: string;

  @IsString()
  @IsOptional()
  partner_contact_email?: string;
}
