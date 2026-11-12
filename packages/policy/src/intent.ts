import { z } from 'zod';
import { isCurrency } from '@agpal/shared';

/** Invariant 1: every money action is a SpendIntent that passes through the gate. */
export const spendActions = [
  'payout',
  'refund',
  'internal_invoice',
  'allocation',
  'subscription_change',
  'price_change',
] as const;
export type SpendAction = (typeof spendActions)[number];

const minorUnits = z
  .string()
  .regex(/^\d+$/, 'amountMinor must be a positive integer string (minor units, no decimals)')
  .transform((s) => BigInt(s))
  .refine((n) => n > 0n, 'amountMinor must be greater than zero');

export const spendIntentSchema = z.object({
  companyId: z.string().min(1),
  agentId: z.string().min(1),
  runId: z.string().min(1),
  /** The envelope (department) whose rules and budget apply. */
  envelope: z.string().min(1),
  action: z.enum(spendActions),
  amountMinor: minorUnits,
  currency: z.string().refine(isCurrency, 'Unsupported currency'),
  /** Payout: the payee's PayPal email. Refund: the capture id. */
  payee: z.string().min(1).optional(),
  /** Allocation / internal invoice: the receiving department. */
  target: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
  reason: z.string().min(1),
  evidence: z.array(z.url()).default([]),
  /** Action-specific data the executor needs (e.g. payout note, plan id). Never read by rules. */
  details: z.record(z.string(), z.unknown()).default({}),
});

export type SpendIntentInput = z.input<typeof spendIntentSchema>;
export type SpendIntent = z.output<typeof spendIntentSchema>;

export type Outcome = 'approve' | 'hold_for_founder' | 'deny';

export interface Decision {
  outcome: Outcome;
  /** Stable rule id, e.g. `cap.per_tx`. */
  rule: string;
  explanation: string;
}
