import 'reflect-metadata';
import { UserRole } from '../users/enums/user-role.enum';
import { ROLES_KEY } from '../auth/roles.decorator';
import { AdminController } from './admin.controller';

/** Regression guard: every /admin route must stay locked to SUPER_ADMIN. */
describe('AdminController role protection', () => {
  const proto = AdminController.prototype as unknown as Record<string, unknown>;
  const classRoles: string[] | undefined = Reflect.getMetadata(
    ROLES_KEY,
    AdminController,
  );

  it('is restricted to SUPER_ADMIN at class level', () => {
    expect(classRoles).toEqual([UserRole.SUPER_ADMIN]);
  });

  it('has no handler that overrides the role requirement with something weaker', () => {
    const handlers = Object.getOwnPropertyNames(proto).filter(
      (name) => name !== 'constructor' && typeof proto[name] === 'function',
    );
    expect(handlers.length).toBeGreaterThan(20);
    for (const name of handlers) {
      const handlerRoles: string[] | undefined = Reflect.getMetadata(
        ROLES_KEY,
        proto[name] as object,
      );
      const effective = handlerRoles ?? classRoles;
      expect({ name, roles: effective }).toEqual({
        name,
        roles: [UserRole.SUPER_ADMIN],
      });
    }
  });
});
