import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UsersService } from '../users/users.service';
import { UserRole } from '../users/enums/user-role.enum';
import { resolveJwtSecret } from './jwt-secret.util';

/** Mirrors the statuses AuthService.login() accepts. */
export function isSessionStatusAllowed(status: string): boolean {
  return (
    status === 'active' ||
    status === 'approved' ||
    status === 'pending_membership_payment' ||
    status === 'pending_subscription_payment'
  );
}

const ORGANIZATION_ACCOUNT_ROLES = new Set<string>([
  UserRole.UNIVERSITY,
  UserRole.NGO,
  UserRole.CORPORATE,
  UserRole.ORGANIZATION_ADMIN,
]);

/**
 * An organization account whose organization a CIEL admin rejected loses access. Only REJECTED:
 * new accounts wait on `pending_org_verification` instead, and accounts already active before
 * the review gate keep working while their organization is still PENDING.
 */
export function isOrganizationAccessRejected(
  role: string,
  organization?: { verificationStatus?: string | null } | null,
): boolean {
  return (
    ORGANIZATION_ACCOUNT_ROLES.has(role) &&
    String(organization?.verificationStatus || '').toUpperCase() === 'REJECTED'
  );
}

/** Claims minted by AuthService.login(); only `sub` is guaranteed on every token. */
export interface JwtPayload {
  sub: string;
  email?: string;
  role?: string;
  tokenVersion?: number;
  organizationId?: string;
  organizationName?: string;
  department?: string;
  faculty_department?: string;
  city?: string;
  university?: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private readonly usersService: UsersService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: resolveJwtSecret(
        configService.get<string>('JWT_SECRET'),
        new Logger('JwtStrategy'),
      ),
    });
  }

  async validate(payload: JwtPayload) {
    const user = await this.usersService.findOne(payload.sub);
    if (!user) {
      throw new UnauthorizedException();
    }
    const fromToken = payload.tokenVersion ?? 0;
    const current = user.tokenVersion ?? 0;
    if (fromToken !== current) {
      throw new UnauthorizedException();
    }
    // Suspended / rejected / deleted-state accounts lose access immediately, not at token expiry.
    if (!isSessionStatusAllowed(user.status)) {
      throw new UnauthorizedException('Account is not active');
    }
    if (user.organization?.isBlocked) {
      throw new UnauthorizedException('Organization is blocked');
    }
    if (isOrganizationAccessRejected(user.role, user.organization)) {
      throw new UnauthorizedException(
        'Organization application was not approved',
      );
    }
    return {
      id: payload.sub,
      email: payload.email,
      // Role comes from the DB so a demotion applies even to tokens minted before it.
      role: user.role,
      organizationId: payload.organizationId ?? user.organization?.id,
      status: user.status,
      name: user.name,
    };
  }
}
