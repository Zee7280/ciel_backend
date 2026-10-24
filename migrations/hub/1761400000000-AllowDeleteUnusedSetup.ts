import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lets the runtime role hard-delete platforms, credentials and connections that never received
 * data (enforced in HubDeletionService). Audit rows remain undeletable.
 */
export class AllowDeleteUnusedSetup1761400000000 implements MigrationInterface {
  name = 'AllowDeleteUnusedSetup1761400000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ciel_hub_app') THEN
          GRANT DELETE ON
            "external_hub"."external_platforms",
            "external_hub"."external_credentials",
            "external_hub"."external_connections"
          TO ciel_hub_app;
        END IF;
      END
      $$;`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ciel_hub_app') THEN
          REVOKE DELETE ON
            "external_hub"."external_platforms",
            "external_hub"."external_credentials",
            "external_hub"."external_connections"
          FROM ciel_hub_app;
        END IF;
      END
      $$;`);
  }
}
