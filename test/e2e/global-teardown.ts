import * as dotenv from 'dotenv';
import { Client } from 'pg';

const SCRATCH = 'ciel_e2e_scratch';

/** `pg` ships no typings (and @types/pg is not installed): the few client members this file uses. */
type PgClient = {
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
};
const PgClient = Client as unknown as new (config: {
  host: string;
  port: number;
  user?: string;
  password?: string;
  database: string;
}) => PgClient;

export default async function globalTeardown() {
  dotenv.config();
  const c = new PgClient({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: 'postgres',
  });
  await c.connect();
  try {
    await c.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
  } finally {
    await c.end();
  }
}
