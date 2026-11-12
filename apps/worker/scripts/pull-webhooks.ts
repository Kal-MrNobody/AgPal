/**
 * pnpm webhooks:pull — catch up on PayPal webhook events through the authenticated API instead of inbound delivery
 * (e.g. when no tunnel is possible). Stores each event like apps/api does (dedupe by event id) and processes it.
 */
import { createDb, webhookEvents } from '@agpal/db';
import { createServices } from '@agpal/policy';
import { loadEnv } from '@agpal/shared';
import { handleWebhookJob } from '../src/webhook-job.js';

const env = loadEnv();
const hours = Number(process.argv.find((a) => a.startsWith('--hours='))?.split('=')[1] ?? '24');
const db = createDb(env.DATABASE_URL, { max: 2 });
const services = createServices(
  db,
  env,
  env.AGPAL_COMPANY_ID ? { defaultCompanyId: env.AGPAL_COMPANY_ID } : {},
);
const events = await services.inbound.listWebhookEvents(new Date(Date.now() - hours * 3_600_000));
let processed = 0;
for (const e of events.reverse()) {
  await db
    .insert(webhookEvents)
    .values({
      id: e.id,
      eventType: e.event_type,
      resourceType: e.resource_type ?? null,
      resourceId: typeof e.resource?.id === 'string' ? e.resource.id : null,
      payload: e,
      verified: true,
    })
    .onConflictDoNothing();
  const status = await handleWebhookJob(db, services.webhooks, e.id, 99).catch(
    (err: unknown) => `error: ${err instanceof Error ? err.message : String(err)}`,
  );
  console.warn(`${e.event_type.padEnd(34)} ${e.id}  →  ${status}`);
  processed++;
}
console.warn(`${processed} event(s) pulled.`);
await db.$client.end();
