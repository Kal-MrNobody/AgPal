import { describe, expect, it } from 'vitest';
import { defaultPolicyConfig, parsePolicyConfig } from './config.js';
import { spendIntentSchema, type SpendIntentInput } from './intent.js';
import { decide, type Facts } from './rules.js';

const config = parsePolicyConfig(defaultPolicyConfig);
const strictFirstPayout = parsePolicyConfig({
  ...defaultPolicyConfig,
  envelopes: {
    ...defaultPolicyConfig.envelopes,
    growth: { ...defaultPolicyConfig.envelopes.growth, holdFirstPayoutToNewPayee: true },
  },
});

const baseFacts: Facts = {
  companyKillSwitch: false,
  agentPaused: false,
  autonomyLevel: 1,
  fundsAvailableMinor: 100_000n,
  spentTodayMinor: 0n,
  recentCount: 0,
  payeeAllowlisted: true,
  payeeHasPriorPayout: true,
};

const payout = (patch: Partial<SpendIntentInput> = {}) =>
  spendIntentSchema.parse({
    companyId: 'c',
    agentId: 'growth-agent',
    runId: 'r',
    envelope: 'growth',
    action: 'payout',
    amountMinor: '4000',
    currency: 'USD',
    payee: 'alice@example.com',
    category: 'content',
    reason: 'blog post',
    ...patch,
  });

type Row = [
  label: string,
  intentPatch: Partial<SpendIntentInput>,
  facts: Partial<Facts>,
  outcome: string,
  rule: string,
];

const table: Row[] = [
  ['within policy', {}, {}, 'approve', 'within_policy'],
  ['company kill switch', {}, { companyKillSwitch: true }, 'deny', 'kill_switch.company'],
  ['agent paused', {}, { agentPaused: true }, 'deny', 'kill_switch.agent'],
  ['wrong currency', { currency: 'EUR' }, {}, 'deny', 'currency'],
  ['unknown envelope', { envelope: 'marketing' }, {}, 'deny', 'envelope.unknown'],
  ['action not allowed for envelope', { action: 'refund' }, {}, 'deny', 'action.not_allowed'],
  ['category not allowed', { category: 'gambling' }, {}, 'deny', 'category.not_allowed'],
  ['missing category', { category: undefined }, {}, 'deny', 'category.not_allowed'],
  ['over hard per-tx cap ($250)', { amountMinor: '25001' }, {}, 'deny', 'cap.per_tx'],
  [
    'cap scales with autonomy level 2',
    { amountMinor: '30000' },
    { autonomyLevel: 2, spentTodayMinor: 0n },
    'hold_for_founder',
    'approval_threshold',
  ],
  ['cap shrinks at level 0', { amountMinor: '13000' }, { autonomyLevel: 0 }, 'deny', 'cap.per_tx'],
  ['payee not allow-listed', {}, { payeeAllowlisted: false }, 'deny', 'payee.not_allowlisted'],
  ['payout without payee', { payee: undefined }, {}, 'deny', 'payee.missing'],
  [
    'insufficient envelope (fee buffer counts)',
    {},
    { fundsAvailableMinor: 4_099n },
    'deny',
    'funds.insufficient',
  ],
  [
    'exactly enough incl. fee buffer',
    {},
    { fundsAvailableMinor: 4_100n },
    'approve',
    'within_policy',
  ],
  [
    'first payout to an allow-listed payee is not held by default',
    {},
    { payeeHasPriorPayout: false },
    'approve',
    'within_policy',
  ],
  ['over daily cap ($400)', {}, { spentTodayMinor: 36_001n }, 'hold_for_founder', 'cap.daily'],
  ['at daily cap exactly', {}, { spentTodayMinor: 36_000n }, 'approve', 'within_policy'],
  ['velocity limit', {}, { recentCount: 5 }, 'hold_for_founder', 'velocity'],
  [
    'over auto-approve ($50)',
    { amountMinor: '5001' },
    {},
    'hold_for_founder',
    'approval_threshold',
  ],
  ['at auto-approve exactly', { amountMinor: '5000' }, {}, 'approve', 'within_policy'],
  [
    'level 0 holds everything',
    { amountMinor: '100' },
    { autonomyLevel: 0 },
    'hold_for_founder',
    'approval_threshold',
  ],
  [
    'founder approval skips hold rules',
    { amountMinor: '20000' },
    { founderApproved: true, payeeHasPriorPayout: false },
    'approve',
    'founder.approved',
  ],
  [
    'founder approval cannot skip deny rules',
    {},
    { founderApproved: true, companyKillSwitch: true },
    'deny',
    'kill_switch.company',
  ],
];

describe('decide (payout rules)', () => {
  it.each(table)('%s', (_label, patch, facts, outcome, rule) => {
    const d = decide(config, payout(patch), { ...baseFacts, ...facts });
    expect({ outcome: d.outcome, rule: d.rule }).toEqual({ outcome, rule });
    expect(d.explanation.length).toBeGreaterThan(10);
  });
});

describe('decide (optional first-payout hold)', () => {
  it('holds the first payout to a payee when the company turns the rule on', () => {
    expect(
      decide(strictFirstPayout, payout(), { ...baseFacts, payeeHasPriorPayout: false }).rule,
    ).toBe('payee.first_payout');
    expect(
      decide(strictFirstPayout, payout(), { ...baseFacts, payeeHasPriorPayout: true }).rule,
    ).toBe('within_policy');
  });
});

describe('decide (other actions)', () => {
  const base = { companyId: 'c', agentId: 'a', runId: 'r', currency: 'USD', reason: 'x' };

  it('refunds are capped by what is still refundable on the order', () => {
    const refund = spendIntentSchema.parse({
      ...base,
      envelope: 'support',
      action: 'refund',
      amountMinor: '2900',
      payee: 'CAP1',
      category: 'refunds',
    });
    expect(decide(config, refund, { ...baseFacts, refundableMinor: 2_900n }).outcome).toBe(
      'approve',
    );
    expect(decide(config, refund, { ...baseFacts, refundableMinor: 2_899n }).rule).toBe(
      'refund.over_captured',
    );
    expect(decide(config, refund, { ...baseFacts }).rule).toBe('refund.unknown_order');
    const big = spendIntentSchema.parse({
      ...base,
      envelope: 'support',
      action: 'refund',
      amountMinor: '6000',
      payee: 'CAP1',
      category: 'refunds',
    });
    expect(decide(config, big, { ...baseFacts, refundableMinor: 10_000n }).rule).toBe(
      'approval_threshold',
    );
  });

  it('every price change is held', () => {
    const pc = spendIntentSchema.parse({
      ...base,
      envelope: 'revenue',
      action: 'price_change',
      amountMinor: '1900',
      category: 'pricing',
    });
    expect(decide(config, pc, baseFacts).rule).toBe('always_hold');
  });

  it('allocations need a target and respect the auto-approve limit', () => {
    const alloc = (amount: string, target?: string) =>
      spendIntentSchema.parse({
        ...base,
        envelope: 'finance',
        action: 'allocation',
        amountMinor: amount,
        target,
        category: 'budgeting',
      });
    expect(decide(config, alloc('50000', 'growth'), baseFacts).outcome).toBe('approve');
    expect(
      decide(config, alloc('50001', 'growth'), { ...baseFacts, fundsAvailableMinor: 1_000_000n })
        .rule,
    ).toBe('approval_threshold');
    expect(decide(config, alloc('100'), baseFacts).rule).toBe('target.missing');
  });

  it('a department cannot invoice itself', () => {
    const inv = spendIntentSchema.parse({
      ...base,
      envelope: 'growth',
      action: 'internal_invoice',
      amountMinor: '100',
      target: 'growth',
      category: 'internal',
    });
    expect(decide(config, inv, baseFacts).rule).toBe('target.self');
  });

  it('is deterministic', () => {
    const i = payout();
    expect(decide(config, i, baseFacts)).toEqual(decide(config, i, baseFacts));
  });
});
