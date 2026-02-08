
import { IsNotEmpty, IsNumber, IsString, IsArray, IsOptional } from 'class-validator';

export class CreateFundingApplicationDto {
    @IsNotEmpty()
    @IsNumber()
    fundingId: number;

    @IsNotEmpty()
    @IsNumber()
    proposedBudget: number;

    @IsNotEmpty()
    @IsString()
    projectDescription: string;

    @IsNotEmpty()
    @IsNumber()
    expectedBeneficiaries: number;

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    documents: string[];
}
