import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

const COMMON_PASSWORDS = new Set([
  '12345678',
  '123456789',
  '1234567890',
  '87654321',
  'password',
  'password1',
  'password123',
  'qwertyui',
  'qwerty123',
  'iloveyou',
  '11111111',
  '00000000',
  'abcd1234',
  'admin123',
  'letmein1',
]);

/** Same rule the signup form enforces client-side — now enforced where it can't be bypassed. */
export function passwordPolicyError(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < 8) {
    return 'Password must be at least 8 characters long.';
  }
  if (/^\d+$/.test(password)) {
    return 'Password cannot be only numbers. Add letters or symbols.';
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return 'That password is too common. Choose a less predictable one.';
  }
  if (/^(.)\1+$/.test(password)) {
    return 'Password cannot be a single repeated character.';
  }
  return null;
}

/** class-validator decorator: fails with the exact reason from passwordPolicyError. */
export function IsAcceptablePassword(options?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: 'isAcceptablePassword',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate: (value: unknown) => passwordPolicyError(value) === null,
        defaultMessage: (args: ValidationArguments) =>
          passwordPolicyError(args.value) ?? 'Invalid password.',
      },
    });
  };
}
