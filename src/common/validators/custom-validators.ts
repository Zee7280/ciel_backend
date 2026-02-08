import { registerDecorator, ValidationOptions, ValidationArguments } from 'class-validator';

export function IsCNIC(validationOptions?: ValidationOptions) {
    return function (object: Object, propertyName: string) {
        registerDecorator({
            name: 'isCNIC',
            target: object.constructor,
            propertyName: propertyName,
            options: validationOptions,
            validator: {
                validate(value: any, args: ValidationArguments) {
                    if (typeof value !== 'string') return false;

                    // CNIC format: 12345-1234567-1 (5 digits, 7 digits, 1 digit)
                    const cnicRegex = /^\d{5}-\d{7}-\d{1}$/;
                    return cnicRegex.test(value);
                },
                defaultMessage(args: ValidationArguments) {
                    return 'CNIC must be in format: 12345-1234567-1 (13 digits with dashes)';
                }
            }
        });
    };
}

export function IsPakistaniMobile(validationOptions?: ValidationOptions) {
    return function (object: Object, propertyName: string) {
        registerDecorator({
            name: 'isPakistaniMobile',
            target: object.constructor,
            propertyName: propertyName,
            options: validationOptions,
            validator: {
                validate(value: any, args: ValidationArguments) {
                    if (typeof value !== 'string') return false;

                    // Pakistani mobile format: 03XXXXXXXXX (11 digits starting with 03)
                    const mobileRegex = /^03\d{9}$/;
                    return mobileRegex.test(value);
                },
                defaultMessage(args: ValidationArguments) {
                    return 'Mobile number must be in Pakistani format: 03XXXXXXXXX (11 digits)';
                }
            }
        });
    };
}
