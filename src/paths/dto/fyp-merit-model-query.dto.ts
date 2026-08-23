import { IsOptional, IsString } from 'class-validator';

/** Query params for GET paths/fyp-thesis/merit-model — which of these are actually honored depends
 * on the caller's role (faculty/university/CIEL scope), enforced in PathsService. */
export class FypMeritModelQueryDto {
    @IsOptional() @IsString() route?: string;
    @IsOptional() @IsString() school?: string;
    /** University/CIEL scope only — supervisor email to filter to. */
    @IsOptional() @IsString() supervisor?: string;
    @IsOptional() @IsString() semester?: string;
    @IsOptional() @IsString() year?: string;
    /** "YYYY-MM" — completion-month range. */
    @IsOptional() @IsString() from?: string;
    @IsOptional() @IsString() to?: string;
    /** CIEL scope only — organizationId of the university to filter to. */
    @IsOptional() @IsString() university?: string;
}
