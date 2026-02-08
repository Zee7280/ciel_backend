import { IsString } from 'class-validator';

export class GetApplicantsDto {
    @IsString()
    id: string; // opportunity ID
}
