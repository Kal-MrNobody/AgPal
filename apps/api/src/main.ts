import { PgBoss } from 'pg-boss';
import { createDb, webhookEvents } from '@agpal/db';
import { createServices } from '@agpal/policy';
import { loadEnv } from '@agpal/shared';
import { registerReadRoutes } from './routes.js';
import { buildServer } from './server.js';

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
await boss.createQueue('webhook.paypal', { retryLimit: 8, retryDelay: 5, retryBackoff: true });

const app = buildServer({
  logLevel: env.LOG_LEVEL,
  checkDatabase: async () => (await db.$client.query('select 1')).rowCount === 1,
  webhooks: {
    verify: async (headers, rawBody) => {
      if (!env.PAYPAL_WEBHOOK_ID) return false; // fail closed until the webhook is registered
      return services.inbound.verifyWebhook({ webhookId: env.PAYPAL_WEBHOOK_ID, headers, rawBody });
    },
    store: async (event, verified) => {
      const rows = await db
        .insert(webhookEvents)
        .values({
          id: event.id,
          eventType: event.event_type,
          resourceType: event.resource_type ?? null,
          resourceId: typeof event.resource?.id === 'string' ? event.resource.id : null,
          payload: event,
          verified,
        })
        .onConflictDoNothing()
        .returning({ id: webhookEvents.id });
      return rows.length > 0;
    },
    enqueue: async (eventId) => {
      await boss.send('webhook.paypal', { eventId }, { singletonKey: eventId });
    },
  },
  routes: (a) => {
    registerReadRoutes(a, {
      db,
      services,
      ...(env.AGPAL_COMPANY_ID ? { companyId: env.AGPAL_COMPANY_ID } : {}),
      ...(env.AGPAL_ADMIN_TOKEN ? { adminToken: env.AGPAL_ADMIN_TOKEN.reveal() } : {}),
    });
  },
});

const close = async (): Promise<void> => {
  await app.close();
  await boss.stop({ graceful: true });
  await db.$client.end();
};
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());

await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
