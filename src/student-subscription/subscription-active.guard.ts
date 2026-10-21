import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PENDING_SUBSCRIPTION_STATUS } from './student-subscription.util';

/**
 * Blocks student tools until the subscription fee is approved. Only ever trips for accounts in
 * `pending_subscription_payment` (students from non-member universities), so it is safe on mixed-role
 * controllers. The subscription endpoints themselves and the profile endpoints stay open.
 */
@Injectable()
export class SubscriptionActiveGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<{ user?: { status?: string } }>();
    if (req.user?.status === PENDING_SUBSCRIPTION_STATUS) {
      throw new ForbiddenException({
        success: false,
        code: 'SUBSCRIPTION_PAYMENT_REQUIRED',
        message:
          'Your account is pending subscription fee verification. Pay the fee and submit proof, or wait for an administrator to activate your account.',
      });
    }
    return true;
  }
}
