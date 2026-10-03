import { Logger } from '@nestjs/common';

const DEV_FALLBACK_SECRET = 'secretKey';
const MIN_SECRET_LENGTH = 16;

/**
 * Resolve the JWT signing secret.
 *
 *  - Development / test: a missing JWT_SECRET falls back to a well-known value so local setups work.
 *  - Production: a missing / built-in / too-short secret is forgeable (anyone could sign an admin
 *    token), so the app REFUSES TO START instead of running insecurely. Set JWT_SECRET (>= 16
 *    chars). Emergency escape hatch: ALLOW_INSECURE_JWT_FALLBACK=true downgrades the refusal to a
 *    loud error log — use it only to get a deploy up while the secret is being provisioned.
 */
export function resolveJwtSecret(
    configured: string | undefined,
    logger: Pick<Logger, 'error'> = new Logger('JwtSecret'),
    nodeEnv: string | undefined = process.env.NODE_ENV,
    allowInsecureFallback: boolean = process.env.ALLOW_INSECURE_JWT_FALLBACK === 'true',
): string {
    const secret = (configured ?? '').trim();
    const weak =
        !secret || secret === DEV_FALLBACK_SECRET || secret.length < MIN_SECRET_LENGTH;
    if (!weak) return secret;
    if (nodeEnv === 'production') {
        const message =
            'JWT_SECRET is missing, built-in, or shorter than 16 characters in production — anyone could forge tokens. Set a strong JWT_SECRET.';
        if (!allowInsecureFallback) {
            throw new Error(message);
        }
        logger.error(`${message} (continuing because ALLOW_INSECURE_JWT_FALLBACK=true)`);
    }
    return secret || DEV_FALLBACK_SECRET;
}
