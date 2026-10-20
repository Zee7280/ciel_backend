import { BadRequestException } from '@nestjs/common';
import { translateDatabaseInputError } from './issue-logs.filter';

describe('translateDatabaseInputError', () => {
  it('turns a Postgres invalid-uuid query failure into a 400', () => {
    const err = Object.assign(
      new Error('invalid input syntax for type uuid: "x"'),
      {
        driverError: { code: '22P02' },
      },
    );
    const out = translateDatabaseInputError(err);
    expect(out).toBeInstanceOf(BadRequestException);
  });

  it('leaves every other error untouched', () => {
    const err = Object.assign(new Error('boom'), {
      driverError: { code: '23505' },
    });
    expect(translateDatabaseInputError(err)).toBe(err);
    const plain = new Error('plain');
    expect(translateDatabaseInputError(plain)).toBe(plain);
  });
});
