import { Type } from 'class-transformer';
import {
    ArrayMaxSize,
    IsArray,
    IsIn,
    IsInt,
    IsNumber,
    IsOptional,
    IsString,
    Min,
    ValidateNested,
    registerDecorator,
    ValidationArguments,
    ValidationOptions,
} from 'class-validator';

/**
 * Every field on the notify DTO is optional on its own, so an empty body would validate
 * and then silently no-op. This asserts the payload carries at least one meaningful field.
 */
function HasAnyAwardNotifyField(validationOptions?: ValidationOptions) {
    return function (object: object, propertyName: string) {
        registerDecorator({
            name: 'hasAnyAwardNotifyField',
            target: object.constructor,
            propertyName,
            options: validationOptions,
            validator: {
                validate(_value: unknown, args: ValidationArguments) {
                    const dto = args.object as NotifyCommunityAwardDto;
                    return Boolean(
                        dto.kind ||
                        (typeof dto.scopeLabel === 'string' && dto.scopeLabel.trim().length > 0) ||
                        (Array.isArray(dto.picks) && dto.picks.length > 0) ||
                        (Array.isArray(dto.reportIds) && dto.reportIds.length > 0),
                    );
                },
                defaultMessage() {
                    return 'At least one of kind, scopeLabel, picks or reportIds must be provided.';
                },
            },
        });
    };
}

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

    /**
     * Not a client field — a carrier for the cross-field check above. It cannot live on one of
     * the real fields because `@IsOptional()` short-circuits every validator on that property
     * when it is absent, which is exactly the empty-body case being rejected here.
     */
    @HasAnyAwardNotifyField()
    _requireAtLeastOneField?: never;
}
