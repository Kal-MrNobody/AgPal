import { createDb } from '@agpal/db';
import { loadEnv } from '@agpal/shared';
import { buildServer } from './server.js';

const env = loadEnv();
const db = createDb(env.DATABASE_URL);
const app = buildServer({
  logLevel: env.LOG_LEVEL,
  checkDatabase: async () => (await db.$client.query('select 1')).rowCount === 1,
});

const close = async (): Promise<void> => {
  await app.close();
  await db.$client.end();
};
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());

await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
