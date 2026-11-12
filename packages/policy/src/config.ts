import { z } from 'zod';
import { spendActions } from './intent.js';

/**
 * Policy config per company (constitution §3). Validated with zod; stored in policy_configs.
 * Never shown to or editable by an LLM (invariant 5). Amounts are minor-unit strings; multipliers are
 * basis points (10000 = 1×) so no float ever touches money.
 */
const minor = z
  .string()
  .regex(/^\d+$/)
  .transform((s) => BigInt(s));

export const envelopeRulesSchema = z.object({
  actions: z.array(z.enum(spendActions)),
  autoApproveUpToMinor: minor,
  perTxCapMinor: minor.nullable(),
  dailyCapMinor: minor,
  velocity: z.object({
    max: z.number().int().positive(),
    windowMinutes: z.number().int().positive(),
  }),
  payeePolicy: z.enum(['allowlist', 'original_order', 'none']),
  categories: z.array(z.string()).nullable(),
  alwaysHold: z.array(z.enum(spendActions)).default([]),
  /** Off by default: adding a payee to the allow-list is the founder's approval of the relationship. */
  holdFirstPayoutToNewPayee: z.boolean().default(false),
});

export const autonomyLevelSchema = z.object({
  level: z.number().int().min(0).max(4),
  capMultiplierBps: z.number().int().positive(),
  autoApproveMultiplierBps: z.number().int().min(0),
});

export const policyConfigSchema = z.object({
  version: z.literal(1),
  currency: z.string(),
  envelopes: z.record(z.string(), envelopeRulesSchema),
  autonomy: z.array(autonomyLevelSchema).length(5),
  /** Payout fee buffer held with each payout (fees are known only after PayPal answers). */
  payoutFeeBufferMinor: minor,
});

export type EnvelopeRules = z.output<typeof envelopeRulesSchema>;
export type PolicyConfig = z.output<typeof policyConfigSchema>;
export type PolicyConfigInput = z.input<typeof policyConfigSchema>;

/** Constitution §3 and §4 defaults. */
export const defaultPolicyConfig: PolicyConfigInput = {
  version: 1,
  currency: 'USD',
  payoutFeeBufferMinor: '100',
  autonomy: [
    { level: 0, capMultiplierBps: 5000, autoApproveMultiplierBps: 0 },
    { level: 1, capMultiplierBps: 10000, autoApproveMultiplierBps: 10000 },
    { level: 2, capMultiplierBps: 15000, autoApproveMultiplierBps: 15000 },
    { level: 3, capMultiplierBps: 20000, autoApproveMultiplierBps: 20000 },
    { level: 4, capMultiplierBps: 30000, autoApproveMultiplierBps: 30000 },
  ],
  envelopes: {
    revenue: {
      actions: ['price_change', 'subscription_change', 'internal_invoice'],
      autoApproveUpToMinor: '0',
      perTxCapMinor: null,
      dailyCapMinor: '100000000',
      velocity: { max: 10, windowMinutes: 60 },
      payeePolicy: 'none',
      categories: ['pricing', 'listings', 'internal'],
      alwaysHold: ['price_change'],
    },
    finance: {
      actions: ['allocation', 'internal_invoice'],
      autoApproveUpToMinor: '50000',
      perTxCapMinor: '200000',
      dailyCapMinor: '300000',
      velocity: { max: 10, windowMinutes: 60 },
      payeePolicy: 'none',
      categories: ['budgeting', 'internal'],
    },
    support: {
      actions: ['refund', 'internal_invoice', 'dispute_accept'],
      autoApproveUpToMinor: '5000',
      perTxCapMinor: null,
      dailyCapMinor: '20000',
      velocity: { max: 5, windowMinutes: 60 },
      payeePolicy: 'original_order',
      categories: ['refunds', 'disputes', 'internal'],
      alwaysHold: ['dispute_accept'],
    },
    growth: {
      actions: ['payout', 'internal_invoice'],
      autoApproveUpToMinor: '5000',
      perTxCapMinor: '25000',
      dailyCapMinor: '40000',
      velocity: { max: 5, windowMinutes: 60 },
      payeePolicy: 'allowlist',
      categories: ['content', 'listings', 'launches', 'internal'],
    },
  },
};

export const parsePolicyConfig = (raw: unknown): PolicyConfig => policyConfigSchema.parse(raw);

export const scale = (amount: bigint, bps: number): bigint => (amount * BigInt(bps)) / 10000n;
