import { PgBoss } from 'pg-boss';
import { createDb } from '@agpal/db';
import { createServices } from '@agpal/policy';
import { loadEnv } from '@agpal/shared';
import { QUEUES, WEBHOOK_RETRY_LIMIT } from './queues.js';
import { handleWebhookJob } from './webhook-job.js';

const env = loadEnv();
const db = createDb(env.DATABASE_URL);
const services = createServices(
  db,
  env,
  env.AGPAL_COMPANY_ID ? { defaultCompanyId: env.AGPAL_COMPANY_ID } : {},
);
const boss = new PgBoss(env.DATABASE_URL.reveal());
boss.on('error', (err: unknown) => {
  console.error('pg-boss error', err instanceof Error ? err.message : 'unknown');
});

await boss.start();
await boss.createQueue(QUEUES.webhookPaypal, {
  retryLimit: WEBHOOK_RETRY_LIMIT,
  retryDelay: 5,
  retryBackoff: true,
});
for (const q of [QUEUES.reconciliation, QUEUES.agentHeartbeat, QUEUES.agentWake, QUEUES.payoutSync])
  await boss.createQueue(q);

await boss.work<{ eventId: string }>(QUEUES.webhookPaypal, async ([job]) => {
  if (!job) return;
  await handleWebhookJob(db, services.webhooks, job.data.eventId, job.retryCount);
});

console.warn(`worker ready${services.dry ? ' (dry mode)' : ''}`);

const stop = async (): Promise<void> => {
  await boss.stop({ graceful: true });
  await db.$client.end();
};
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
