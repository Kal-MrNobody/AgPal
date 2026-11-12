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

/** Prefixed random id, e.g. `je_3f2a...`. */
export const newId = (prefix: string): string => `${prefix}_${randomUUID().replaceAll('-', '')}`;
