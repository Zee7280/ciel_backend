import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UsersService } from '../users/users.service';
import { UserRole } from '../users/enums/user-role.enum';
import { resolveJwtSecret } from './jwt-secret.util';

/** Mirrors the statuses AuthService.login() accepts (investors may log in while 'pending'). */
export function isSessionStatusAllowed(status: string, role: string): boolean {
    if (status === 'active' || status === 'approved' || status === 'pending_membership_payment') {
        return true;
    }
    return role === UserRole.INVESTOR && status === 'pending';
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
            secretOrKey: resolveJwtSecret(configService.get<string>('JWT_SECRET'), new Logger('JwtStrategy')),
        });
    }

    async validate(payload: any) {
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
        if (!isSessionStatusAllowed(user.status, user.role)) {
            throw new UnauthorizedException('Account is not active');
        }
        if (user.organization?.isBlocked) {
            throw new UnauthorizedException('Organization is blocked');
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
