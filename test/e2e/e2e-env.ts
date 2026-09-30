/**
 * jest `setupFiles` for the e2e project: runs in every worker BEFORE any test module loads.
 * Forces the app onto the scratch database so an e2e run can never touch the dev DB
 * (AppModule uses `synchronize: true`). ConfigModule's dotenv does not override values that are
 * already present in process.env, so setting DB_NAME here wins over `.env`.
 */
import * as dotenv from 'dotenv';

dotenv.config();

export const E2E_DB_NAME = 'ciel_e2e_scratch';

process.env.DB_NAME = E2E_DB_NAME;
process.env.NODE_ENV = 'test';
delete process.env.VERCEL;
delete process.env.DB_SSL;
process.env.FRONTEND_URL = 'http://localhost:3000';

const host = process.env.DB_HOST || '127.0.0.1';
if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
  throw new Error(`e2e refuses to run against non-local DB host "${host}"`);
}
