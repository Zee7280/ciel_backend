import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

@Injectable()
export class MembershipActiveGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
        const req = context.switchToHttp().getRequest();
        const status = req.user?.status;
        if (status === 'pending_membership_payment') {
            throw new ForbiddenException({
                success: false,
                code: 'MEMBERSHIP_PAYMENT_REQUIRED',
                message:
                    'Your account is pending membership fee verification. Pay the fee and submit proof, or wait for an administrator to activate your account.',
            });
        }
        return true;
    }
}
