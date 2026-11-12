import { loadEnv } from '@agpal/shared';
import { createDb } from './index.js';
import { runMigrations } from './migrate.js';

const env = loadEnv();
const db = createDb(env.DATABASE_URL, { max: 1 });
await runMigrations(db);
await db.$client.end();
console.warn('migrations applied');
