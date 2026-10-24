import { DataSourceOptions } from 'typeorm';
import { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';
import { join } from 'path';
import { HUB_ENTITIES } from './entities';
import {
  HUB_DATABASE_URL_ENV,
  HUB_MIGRATION_DATABASE_URL_ENV,
  HUB_SCHEMA,
} from './hub-connection.constants';

export type HubDataSourceMode = 'runtime' | 'migration';

function sslFor(env: NodeJS.ProcessEnv): PostgresConnectionOptions['ssl'] {
  // Same policy as the core connection: TLS on Vercel / production, opt-in locally.
  if (env.NODE_ENV === 'production' || env.VERCEL || env.DB_SSL === 'true') {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

/**
 * Connection options for the Integration Hub's own TypeORM DataSource.
 *
 * - runtime:   HUB_DATABASE_URL, role ciel_hub_app (no privileges on `public`), tiny pool,
 *              synchronize OFF, never runs migrations.
 * - migration: HUB_MIGRATION_DATABASE_URL, role ciel_hub_migrator (owns `external_hub`), used by
 *              the CLI scripts `hub:migrate*` only.
 *
 * The hub never uses autoLoadEntities: HUB_ENTITIES is the complete, explicit list, so no core
 * entity can be attached to this connection by accident.
 */
export function buildHubDataSourceOptions(
  env: NodeJS.ProcessEnv,
  mode: HubDataSourceMode = 'runtime',
): DataSourceOptions {
  const urlEnv =
    mode === 'migration'
      ? HUB_MIGRATION_DATABASE_URL_ENV
      : HUB_DATABASE_URL_ENV;
  const url = (env[urlEnv] ?? '').trim();
  if (!url) {
    throw new Error(`${urlEnv} is not set`);
  }
  const poolMax = Math.max(
    1,
    Math.min(10, parseInt(env.HUB_DB_POOL_MAX ?? '2', 10) || 2),
  );
  const options: PostgresConnectionOptions = {
    type: 'postgres',
    url,
    ssl: sslFor(env),
    schema: HUB_SCHEMA,
    entities: HUB_ENTITIES,
    synchronize: false,
    migrationsRun: false,
    // Neither role may CREATE EXTENSION; uuid defaults use the built-in gen_random_uuid().
    installExtensions: false,
    migrationsTableName: 'hub_migrations',
    migrations:
      mode === 'migration'
        ? [join(__dirname, '..', '..', 'migrations', 'hub', '*{.ts,.js}')]
        : [],
    logging: env.HUB_DB_LOGGING === 'true',
    extra: {
      max: mode === 'migration' ? 1 : poolMax,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
      application_name: mode === 'migration' ? 'ciel-hub-migrate' : 'ciel-hub',
    },
  };
  return options;
}
