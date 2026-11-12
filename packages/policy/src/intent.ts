import { z } from 'zod';
import { isCurrency } from '@agpal/shared';

/**
 * Invariant 1: every money action is a SpendIntent that passes through this gate.
 * The rule engine itself arrives in Prompt 4; this is the contract.
 */
export const spendActions = [
  'payout',
  'refund',
  'internal_invoice',
  'allocation',
  'subscription_change',
  'price_change',
] as const;

const minorUnits = z
  .string()
  .regex(/^\d+$/, 'amountMinor must be a positive integer string (minor units, no decimals)')
  .transform((s) => BigInt(s))
  .refine((n) => n > 0n, 'amountMinor must be greater than zero');

export const spendIntentSchema = z.object({
  companyId: z.string().min(1),
  agentId: z.string().min(1),
  runId: z.string().min(1),
  envelope: z.string().min(1),
  action: z.enum(spendActions),
  amountMinor: minorUnits,
  currency: z.string().refine(isCurrency, 'Unsupported currency'),
  payee: z.string().min(1).optional(),
  reason: z.string().min(1),
  evidence: z.array(z.url()).default([]),
});

export type SpendIntent = z.output<typeof spendIntentSchema>;

export type Decision =
  | { outcome: 'approve'; rule: string; explanation: string }
  | { outcome: 'hold_for_founder'; rule: string; explanation: string }
  | { outcome: 'deny'; rule: string; explanation: string };
