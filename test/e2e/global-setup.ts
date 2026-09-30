import * as dotenv from 'dotenv';
import { Client } from 'pg';

const SCRATCH = 'ciel_e2e_scratch';

async function admin(): Promise<Client> {
  dotenv.config();
  const host = process.env.DB_HOST || '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error(`e2e refuses to run against non-local DB host "${host}"`);
  }
  const c = new Client({
    host,
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: 'postgres', // maintenance DB — never the dev DB
  });
  await c.connect();
  return c;
}

/** Fresh empty scratch DB per run (tables are created by TypeORM synchronize inside the app). */
export default async function globalSetup() {
  const c = await admin();
  try {
    await c.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
    await c.query(`CREATE DATABASE ${SCRATCH}`);
  } finally {
    await c.end();
  }
}
