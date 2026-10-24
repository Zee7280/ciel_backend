/** Name of the second TypeORM connection used only by the Integration Hub. */
export const HUB_CONNECTION = 'hub';

/** Postgres schema that holds every hub table. Nothing in `public` references it and vice versa. */
export const HUB_SCHEMA = 'external_hub';

/** Env var holding the restricted runtime URL (role ciel_hub_app). Absent ⇒ hub module not loaded. */
export const HUB_DATABASE_URL_ENV = 'HUB_DATABASE_URL';

/** Env var holding the migrator URL (role ciel_hub_migrator). Used by the migration CLI only. */
export const HUB_MIGRATION_DATABASE_URL_ENV = 'HUB_MIGRATION_DATABASE_URL';

export function isHubEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean((env[HUB_DATABASE_URL_ENV] ?? '').trim());
}
