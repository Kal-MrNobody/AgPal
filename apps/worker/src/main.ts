import { PgBoss } from 'pg-boss';
import { loadEnv } from '@agpal/shared';
import { allQueues } from './queues.js';

const env = loadEnv();
const boss = new PgBoss(env.DATABASE_URL.reveal());
boss.on('error', (err: unknown) => {
  console.error('pg-boss error', err instanceof Error ? err.message : 'unknown');
});

await boss.start();
for (const q of allQueues()) await boss.createQueue(q);
console.warn(`worker ready: ${allQueues().join(', ')}`);

const stop = async (): Promise<void> => {
  await boss.stop({ graceful: true });
};
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
