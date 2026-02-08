import { IsNotEmpty, IsUUID } from 'class-validator';

export class GetOpportunityDetailDto {
    @IsNotEmpty()
    @IsUUID()
    id: string;
}
