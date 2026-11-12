import { describe, expect, it } from 'vitest';
import { spendIntentSchema } from './intent.js';

const valid = {
  companyId: 'c1',
  agentId: 'growth',
  runId: 'run_1',
  envelope: 'growth',
  action: 'payout',
  amountMinor: '2500',
  currency: 'USD',
  payee: 'contractor@example.com',
  reason: 'Blog post per brief #12',
};

describe('spendIntentSchema', () => {
  it('parses a valid intent into bigint minor units', () => {
    const intent = spendIntentSchema.parse(valid);
    expect(intent.amountMinor).toBe(2500n);
    expect(intent.evidence).toEqual([]);
  });

  it.each([
    ['float amount', { amountMinor: '25.00' }],
    ['number amount', { amountMinor: 2500 }],
    ['negative amount', { amountMinor: '-1' }],
    ['zero amount', { amountMinor: '0' }],
    ['unknown currency', { currency: 'XYZ' }],
    ['unknown action', { action: 'wire_transfer' }],
    ['missing reason (attribution)', { reason: '' }],
    ['missing run id (attribution)', { runId: '' }],
  ])('rejects %s', (_label, patch) => {
    expect(spendIntentSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });
});
