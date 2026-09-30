import * as dotenv from 'dotenv';
import { Client } from 'pg';

const SCRATCH = 'ciel_e2e_scratch';

export default async function globalTeardown() {
  dotenv.config();
  const c = new Client({
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
