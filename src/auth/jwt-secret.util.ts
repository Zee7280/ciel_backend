import { Logger } from '@nestjs/common';

const DEV_FALLBACK_SECRET = 'secretKey';

/**
 * Resolve the JWT signing secret. A missing JWT_SECRET falls back to a well-known dev value so
 * local setups keep working; in production that is forgeable, so log a loud error at startup
 * (but do not crash prod — set JWT_SECRET ASAP).
 */
export function resolveJwtSecret(
    configured: string | undefined,
    logger: Pick<Logger, 'error'> = new Logger('JwtSecret'),
    nodeEnv: string | undefined = process.env.NODE_ENV,
): string {
    if (configured) return configured;
    if (nodeEnv === 'production') {
        logger.error(
            'JWT_SECRET is NOT set in production — falling back to an insecure built-in secret. Anyone can forge tokens. Set JWT_SECRET immediately.',
        );
    }
    return DEV_FALLBACK_SECRET;
}
