import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { isProjectVerificationAuthRequired } from '../common/project-verification-auth.util';

/**
 * When {@link isProjectVerificationAuthRequired} is true, verify endpoints require a valid JWT.
 * See util for env / NODE_ENV rules.
 */
@Injectable()
export class VerificationVerifyAuthGuard extends AuthGuard('jwt') {
    canActivate(context: ExecutionContext) {
        if (!isProjectVerificationAuthRequired()) {
            return true;
        }
        return super.canActivate(context) as boolean | Promise<boolean>;
    }
}
