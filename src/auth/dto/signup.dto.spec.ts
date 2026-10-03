import { ArgumentMetadata, ValidationPipe } from '@nestjs/common';
import { SignupDto } from './signup.dto';
import { ResetPasswordDto } from './reset-password.dto';

describe('SignupDto / ResetPasswordDto — validation that the form used to be the only guard for', () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true });
  const signup = { type: 'body', metatype: SignupDto } as ArgumentMetadata;
  const reset = { type: 'body', metatype: ResetPasswordDto } as ArgumentMetadata;

  const student = (over: Record<string, unknown> = {}) => ({
    role: 'student',
    name: 'Ali Khan',
    email: 'ali@uni.edu.pk',
    password: 'Tr0ub4dor&3',
    institution: 'BNU',
    department: 'Architecture',
    city: 'Lahore',
    enrollmentYear: '2023',
    phone: '3001234567',
    acceptedTerms: true,
    ...over,
  });

  it('accepts a complete student signup', async () => {
    await expect(pipe.transform(student(), signup)).resolves.toBeTruthy();
  });

  it.each([
    ['no terms acceptance', { acceptedTerms: undefined }],
    ['terms declined', { acceptedTerms: false }],
    ['all-digit password', { password: '12345678' }],
    ['common password', { password: 'password123' }],
    ['short password', { password: 'abc1' }],
    ['whitespace-only name', { name: '   ' }],
    ['whitespace-only institution', { institution: '  ' }],
    ['whitespace-only department', { department: ' ' }],
    ['whitespace-only city', { city: '   ' }],
    ['whitespace-only enrollment year', { enrollmentYear: ' ' }],
    ['invalid email', { email: 'not-an-email' }],
    ['role escalation', { role: 'admin' }],
    ['junk student id', { registrationNumber: '<script>alert(1)</script>' }],
  ])('rejects %s', async (_l, patch) => {
    await expect(pipe.transform(student(patch), signup)).rejects.toBeTruthy();
  });

  it('trims surrounding whitespace on accepted values', async () => {
    const out = (await pipe.transform(
      student({ name: '  Ali Khan  ', email: ' ali@uni.edu.pk ', institution: ' BNU ', registrationNumber: ' 22-0451 ' }),
      signup,
    )) as SignupDto;
    expect(out.name).toBe('Ali Khan');
    expect(out.email).toBe('ali@uni.edu.pk');
    expect(out.institution).toBe('BNU');
    expect(out.registrationNumber).toBe('22-0451');
  });

  it('reset-password applies the same password policy', async () => {
    await expect(pipe.transform({ token: 't', newPassword: '12345678' }, reset)).rejects.toBeTruthy();
    await expect(pipe.transform({ token: 't', newPassword: 'Tr0ub4dor&3' }, reset)).resolves.toBeTruthy();
  });
});
