import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { DataSource } from 'typeorm';
import { buildHubDataSourceOptions } from './hub-data-source';

dotenv.config();

/**
 * TypeORM CLI entry point for hub migrations (role ciel_hub_migrator). Used by:
 *   npm run hub:migrate | hub:migrate:revert | hub:migrate:show
 * Never imported by the application.
 */
export default new DataSource(
  buildHubDataSourceOptions(process.env, 'migration'),
);
