/** Every queue the worker owns. */
export const QUEUES = {
  webhookPaypal: 'webhook.paypal',
  reconciliation: 'reconciliation.run',
  agentHeartbeat: 'agent.heartbeat',
  agentWake: 'agent.wake',
  payoutSync: 'payout.sync',
  scheduleApply: 'schedule.apply',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const allQueues = (): QueueName[] => Object.values(QUEUES);

/** Webhook processing retries before an event goes to suspense. */
export const WEBHOOK_RETRY_LIMIT = 8;
