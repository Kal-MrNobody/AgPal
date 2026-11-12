/**
 * Every queue the worker owns. Handlers land in later prompts:
 * webhooks (Prompt 7), reconciliation (Prompt 8), heartbeats (Prompt 10).
 */
export const QUEUES = {
  webhookPaypal: 'webhook.paypal',
  reconciliation: 'reconciliation.run',
  agentHeartbeat: 'agent.heartbeat',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const allQueues = (): QueueName[] => Object.values(QUEUES);
