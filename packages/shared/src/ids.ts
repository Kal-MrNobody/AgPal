import { randomUUID } from 'node:crypto';

/** Invariant 4: every money-moving external call carries an idempotency key. */
export type IdempotencyKey = string & { readonly __brand: 'IdempotencyKey' };

export const newIdempotencyKey = (): IdempotencyKey => randomUUID() as IdempotencyKey;

/** Invariant 7: every agent action is attributable. */
export interface Attribution {
  agentId: string;
  runId: string;
  reason: string;
}
