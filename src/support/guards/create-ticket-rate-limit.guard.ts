import {
    CanActivate,
    ExecutionContext,
    HttpException,
    HttpStatus,
    Injectable,
} from '@nestjs/common';

/** Per-process sliding window; sufficient for single-instance or dev. */
@Injectable()
export class CreateTicketRateLimitGuard implements CanActivate {
    private readonly windowMs = 15 * 60 * 1000;
    private readonly maxCreates = 8;
    private readonly hits = new Map<string, number[]>();

    canActivate(context: ExecutionContext): boolean {
        const req = context.switchToHttp().getRequest();
        const userId: string | undefined = req.user?.id;
        if (!userId) {
            return true;
        }
        const now = Date.now();
        const prev = this.hits.get(userId) ?? [];
        const recent = prev.filter((t) => now - t < this.windowMs);
        if (recent.length >= this.maxCreates) {
            throw new HttpException(
                'Too many support tickets created recently. Please try again later.',
                HttpStatus.TOO_MANY_REQUESTS,
            );
        }
        recent.push(now);
        this.hits.set(userId, recent);
        return true;
    }
}
