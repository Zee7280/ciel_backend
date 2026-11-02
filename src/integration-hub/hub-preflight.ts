import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { buildHubDataSourceOptions } from './hub-data-source';
import { HUB_DATABASE_URL_ENV, isHubEnabled } from './hub-connection.constants';

/**
 * Boot-time guard: the Integration Hub's own database connection fails fast by design, but that
 * must never take the core API down with it (a wrong hub password once answered 500 to every
 * request on the platform). Before the app module is loaded, try the hub URL once; if it cannot
 * connect, clear it for this process so the hub module is simply not registered, and say so
 * loudly in the deploy log. Core routes keep working; hub routes answer 404 until fixed.
 */
export async function preflightHub(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 5000,
): Promise<boolean> {
  if (!isHubEnabled(env)) return false;
  const logger = new Logger('IntegrationHub');
  const ds = new DataSource({
    ...buildHubDataSourceOptions(env, 'runtime'),
    entities: [],
    extra: {
      max: 1,
      connectionTimeoutMillis: timeoutMs,
      application_name: 'ciel-hub-preflight',
    },
  });
  try {
    await ds.initialize();
    await ds.query('SELECT 1');
    await ds.destroy();
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(
      `Integration Hub DISABLED for this process: cannot connect with ${HUB_DATABASE_URL_ENV} (${msg}). ` +
        'The core API stays up. Fix the hub database URL / role password and redeploy to bring the hub back.',
    );
    env[HUB_DATABASE_URL_ENV] = '';
    try {
      if (ds.isInitialized) await ds.destroy();
    } catch {
      /* ignore */
    }
    return false;
  }
}
