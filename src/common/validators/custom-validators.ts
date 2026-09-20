import {
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
} from 'class-validator';

export function IsCNIC(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isCNIC',
      target: object.constructor,
      propertyName: propertyName,
      options: validationOptions,
      validator: {
        validate(value: any, args: ValidationArguments) {
          if (typeof value !== 'string') return false;

          // UI sends xxxxx-xxxxxxx-x; engagement/apply often store 13 digits.
          const digits = value.replace(/\D/g, '');
          return digits.length === 13;
        },
        defaultMessage(args: ValidationArguments) {
          return 'CNIC must be 13 digits, with or without dashes (12345-1234567-1)';
        },
      },
    });
  };
}

export function IsPakistaniMobile(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
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
        },
      },
    });
  };
}
