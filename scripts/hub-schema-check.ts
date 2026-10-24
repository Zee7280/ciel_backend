/**
 * Verifies that every hub entity's mapped columns exist in the migrated `external_hub` schema, by
 * opening the RUNTIME hub DataSource (role ciel_hub_app) and selecting all mapped columns of each
 * entity. A column named in an entity but missing from the migration fails here, not in production.
 *
 *   HUB_DATABASE_URL=postgres://ciel_hub_app:...@host/db npm run hub:schema-check
 */
import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { DataSource } from 'typeorm';
import { buildHubDataSourceOptions } from '../src/integration-hub/hub-data-source';
import { HUB_ENTITIES } from '../src/integration-hub/entities';

dotenv.config();

async function main() {
  const ds = new DataSource(buildHubDataSourceOptions(process.env, 'runtime'));
  await ds.initialize();
  let failed = 0;
  try {
    for (const entity of HUB_ENTITIES) {
      const meta = ds.getMetadata(entity);
      try {
        // select() with no args = every mapped column; LIMIT 1 keeps it cheap on big tables.
        await ds
          .getRepository(entity)
          .createQueryBuilder('e')
          .select()
          .limit(1)
          .getMany();
        console.log(
          `PASS  ${meta.tableName.padEnd(26)} ${meta.columns.length} columns`,
        );
      } catch (e) {
        failed += 1;
        console.log(
          `FAIL  ${meta.tableName.padEnd(26)} ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  } finally {
    await ds.destroy();
  }
  console.log(
    `\n${HUB_ENTITIES.length - failed}/${HUB_ENTITIES.length} entities match the schema`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
