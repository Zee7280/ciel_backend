import { passwordPolicyError } from './password-policy.util';

describe('passwordPolicyError', () => {
  it.each(['short', '12345678', '00000000', 'aaaaaaaa', 'Password', 'password123', 'QWERTY123'])(
    'rejects %s',
    (pw) => expect(passwordPolicyError(pw)).toBeTruthy(),
  );
  it.each(['Tr0ub4dor&3', 'correct horse battery', 'ciel-pk-2026!', 'abc12345x'])(
    'accepts %s',
    (pw) => expect(passwordPolicyError(pw)).toBeNull(),
  );
  it('rejects non-strings', () => {
    expect(passwordPolicyError(undefined)).toBeTruthy();
    expect(passwordPolicyError(12345678)).toBeTruthy();
  });
});
