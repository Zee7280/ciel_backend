import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AdminCreateUserDto } from './dto/admin-create-user.dto';
import { normalizeUserRoleInput } from './user-role-input.util';

describe('partner = NGO account type', () => {
  it('maps the legacy word "partner" to the ngo role, leaves everything else alone', () => {
    expect(normalizeUserRoleInput('partner')).toBe('ngo');
    expect(normalizeUserRoleInput(' Partner ')).toBe('ngo');
    expect(normalizeUserRoleInput('corporate')).toBe('corporate');
    expect(normalizeUserRoleInput('all')).toBe('all');
    expect(normalizeUserRoleInput(undefined)).toBeUndefined();
  });

  it('admin create accepts role "partner" and stores it as ngo', async () => {
    const dto = plainToInstance(AdminCreateUserDto, { name: 'N', email: 'n@x.pk', password: 'Str0ngPass!', role: 'partner' });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.role).toBe('ngo');
  });

  it('still rejects unknown roles', async () => {
    const dto = plainToInstance(AdminCreateUserDto, { name: 'N', email: 'n@x.pk', password: 'Str0ngPass!', role: 'banana' });
    expect((await validate(dto)).length).toBeGreaterThan(0);
  });
});
