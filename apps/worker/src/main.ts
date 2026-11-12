import { eq } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import { agentsToWake, createAgentRuntime } from '@agpal/agents';
import { agents, createDb } from '@agpal/db';
import {
  announcePendingApprovals,
  applyDailyAutonomy,
  createServices,
  TelegramChannel,
} from '@agpal/policy';
import { loadEnv } from '@agpal/shared';
import { QUEUES, WEBHOOK_RETRY_LIMIT } from './queues.js';
import { scheduleTools } from './schedule-tools.js';
import { handleWebhookJob } from './webhook-job.js';

const env = loadEnv();
const db = createDb(env.DATABASE_URL);
const services = createServices(
  db,
  env,
  env.AGPAL_COMPANY_ID ? { defaultCompanyId: env.AGPAL_COMPANY_ID } : {},
);
const { runtime } = createAgentRuntime(db, services, {
  extraTools: scheduleTools,
  ...(env.OPENAI_API_KEY ? { openaiApiKey: env.OPENAI_API_KEY.reveal() } : {}),
});
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

// Heartbeats: one pg-boss schedule per agent (keyed by agent id), from each agent's cron.
if (env.AGPAL_COMPANY_ID) {
  const hired = await db.select().from(agents).where(eq(agents.companyId, env.AGPAL_COMPANY_ID));
  for (const a of hired)
    await boss.schedule(QUEUES.agentHeartbeat, a.heartbeatCron, { agentId: a.id }, { key: a.id });
  console.warn(`scheduled ${hired.length} agent heartbeat(s)`);
}
await boss.work<{ agentId: string }>(QUEUES.agentHeartbeat, async ([job]) => {
  if (!job) return;
  await runtime.run(job.data.agentId, { kind: 'heartbeat' });
});

// Event wake-ups: new domain events wake the agents of their department (coalesced per agent).
await boss.work<{ agentId: string; eventId: string; name: string }>(
  QUEUES.agentWake,
  async ([job]) => {
    if (!job) return;
    await runtime.run(job.data.agentId, {
      kind: 'event',
      eventId: job.data.eventId,
      name: job.data.name,
    });
  },
);
let wakeCursor = new Date();
setInterval(() => {
  if (!env.AGPAL_COMPANY_ID) return;
  void agentsToWake(db, env.AGPAL_COMPANY_ID, wakeCursor).then(async (wakes) => {
    for (const w of wakes) {
      await boss.send(QUEUES.agentWake, w, { singletonKey: w.agentId, singletonSeconds: 60 });
      if (w.at > wakeCursor) wakeCursor = w.at;
    }
  });
}, 15_000);

// Telegram approval cards: announce each new held approval once.
if (
  env.AGPAL_COMPANY_ID &&
  env.TELEGRAM_BOT_TOKEN &&
  env.TELEGRAM_CHAT_ID &&
  env.AGPAL_CALLBACK_SECRET
) {
  const channel = new TelegramChannel({
    botToken: env.TELEGRAM_BOT_TOKEN,
    chatId: env.TELEGRAM_CHAT_ID,
    callbackSecret: env.AGPAL_CALLBACK_SECRET,
  });
  const companyId = env.AGPAL_COMPANY_ID;
  setInterval(() => {
    void announcePendingApprovals(db, companyId, channel).catch((e: unknown) => {
      console.error('telegram announce failed', e instanceof Error ? e.message : 'unknown');
    });
  }, 30_000);
}

// Crash recovery: execute approved-but-never-executed intents (idempotent).
setInterval(() => {
  void services.gate.recoverStuck().catch((e: unknown) => {
    console.error('recovery failed', e instanceof Error ? e.message : 'unknown');
  });
}, 5 * 60_000);

// Graduated autonomy: levels change only at the UTC day boundary (00:05), logged.
await boss.createQueue('autonomy.daily');
await boss.schedule('autonomy.daily', '5 0 * * *', {});
await boss.work('autonomy.daily', async () => {
  if (!env.AGPAL_COMPANY_ID) return;
  const staff = await db.select().from(agents).where(eq(agents.companyId, env.AGPAL_COMPANY_ID));
  await applyDailyAutonomy(
    db,
    env.AGPAL_COMPANY_ID,
    staff.map((a) => ({ id: a.id, department: a.department })),
  );
});

// Nightly reconciliation (03:17 UTC) for the deployment's company.
await boss.schedule(QUEUES.reconciliation, '17 3 * * *', {});
await boss.work(QUEUES.reconciliation, async () => {
  if (!env.AGPAL_COMPANY_ID) return;
  await services.reconciler.run(
    env.AGPAL_COMPANY_ID,
    new Date(Date.now() - 48 * 3_600_000),
    new Date(),
    { live: services.inbound },
  );
});

console.warn(`worker ready${services.dry ? ' (dry mode)' : ''}`);

const stop = async (): Promise<void> => {
  await boss.stop({ graceful: true });
  await db.$client.end();
};
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
