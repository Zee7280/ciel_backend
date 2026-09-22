import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Never blocks the request — it always reaches the controller. If a valid JWT is present,
 * `req.user` is populated; otherwise `req.user` is left undefined instead of throwing 401 here.
 *
 * Real authorization for each magic-link kind lives in
 * OpportunitiesService.assertVerificationIdentityIfRequired: faculty and partner magic links are
 * anonymous (the emailed token is the credential). Legacy liaison tokens still require a matching
 * login when {@link isProjectVerificationAuthRequired} is true. Gating that decision here
 * would require the guard to look up the opportunity before the controller even runs, which is
 * exactly the job the service layer already does once it knows the token's kind.
 */
@Injectable()
export class VerificationVerifyAuthGuard extends AuthGuard('jwt') {
    handleRequest<TUser = any>(_err: any, user: any): TUser {
        return (user || undefined) as TUser;
    }
}
