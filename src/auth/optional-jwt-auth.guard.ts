import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Like JwtAuthGuard, but a missing, expired or invalid token leaves `req.user` undefined instead of
 * answering 401: for pages that work signed out and show more (or allow actions) when signed in.
 */
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  handleRequest<TUser = unknown>(err: unknown, user: TUser | false): TUser {
    return (err || !user ? undefined : user) as TUser;
  }
}
