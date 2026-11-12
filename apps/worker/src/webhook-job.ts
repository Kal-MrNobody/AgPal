import { eq, sql } from 'drizzle-orm';
import { webhookEvents, type Database } from '@agpal/db';
import { RetryLaterError, type PayPalEvent, type WebhookProcessor } from '@agpal/policy';
import { WEBHOOK_RETRY_LIMIT } from './queues.js';

/**
 * Process one stored webhook event. Throws RetryLaterError for out-of-order events so pg-boss retries with backoff;
 * on the final attempt the processor sends anything still unmatched to suspense.
 */
export async function handleWebhookJob(
  db: Database,
  processor: WebhookProcessor,
  eventId: string,
  retryCount: number,
): Promise<string> {
  const [row] = await db.select().from(webhookEvents).where(eq(webhookEvents.id, eventId));
  if (!row) return 'missing';
  if (row.status === 'processed' || row.status === 'suspense' || row.status === 'ignored')
    return row.status;
  await db
    .update(webhookEvents)
    .set({ attempts: sql`${webhookEvents.attempts} + 1` })
    .where(eq(webhookEvents.id, eventId));
  try {
    const result = await processor.process(row.payload as unknown as PayPalEvent, {
      simulated: !row.verified,
      finalAttempt: retryCount >= WEBHOOK_RETRY_LIMIT,
    });
    const status =
      result.outcome === 'suspense'
        ? 'suspense'
        : result.outcome === 'ignored'
          ? 'ignored'
          : 'processed';
    await db
      .update(webhookEvents)
      .set({ status, error: null, processedAt: new Date() })
      .where(eq(webhookEvents.id, eventId));
    return status;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db
      .update(webhookEvents)
      .set({ status: e instanceof RetryLaterError ? 'received' : 'failed', error: message })
      .where(eq(webhookEvents.id, eventId));
    throw e;
  }
}
