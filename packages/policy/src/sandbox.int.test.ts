import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@agpal/db/testing';
import { ACC, Ledger } from '@agpal/ledger';
import { PayPal } from '@agpal/paypal';
import { loadEnv, newId } from '@agpal/shared';
import { Commerce } from './commerce.js';
import { Gate } from './gate.js';
import { PayPalPayments } from './paypal-port.js';

/**
 * Real PayPal sandbox transactions. Opt in with AGPAL_SANDBOX_TESTS=1 (needs DATABASE_URL and sandbox
 * credentials). Creates a card order, captures it, refunds part of it and pays out to a contractor.
 */
const enabled = process.env.AGPAL_SANDBOX_TESTS === '1' && Boolean(process.env.DATABASE_URL);

describe.runIf(enabled)('PayPal sandbox (integration)', () => {
  let t: TestDatabase;
  let ledger: Ledger;
  let gate: Gate;
  let commerce: Commerce;
  let paypal: PayPal;
  const co = newId('co');

  beforeAll(async () => {
    const env = loadEnv();
    if (env.PAYPAL_ENVIRONMENT !== 'sandbox')
      throw new Error('Integration tests only run against sandbox');
    t = await createTestDatabase();
    ledger = new Ledger(t.db);
    paypal = new PayPal({
      environment: 'sandbox',
      clientId: env.PAYPAL_CLIENT_ID,
      clientSecret: env.PAYPAL_CLIENT_SECRET,
    });
    gate = new Gate(t.db, ledger, new PayPalPayments(paypal, { payoutSettleWaitMs: 90_000 }));
    commerce = new Commerce(ledger, paypal);
    await ledger.setupCompany({
      id: co,
      name: 'Sandbox Shop',
      currency: 'USD',
      departments: ['revenue', 'finance', 'support', 'growth'].map((code) => ({
        code,
        name: code,
      })),
    });
  });
  afterAll(async () => t.drop());

  it('captures a sale and books gross, fee and net', async () => {
    const c = await commerce.sandboxCardSale({
      companyId: co,
      amountMinor: 2900n,
      currency: 'USD',
      description: 'Notion template',
    });
    expect(c.status).toBe('COMPLETED');
    expect(c.feeMinor).toBeGreaterThan(0n);
    expect(await ledger.balance(co, ACC.unallocated)).toBe(c.netMinor);
    expect(await ledger.balance(co, ACC.paypalFees)).toBe(c.feeMinor);
    // Booking the same capture again (e.g. from the webhook) is a no-op.
    await commerce.bookCapture(co, c);
    expect(await ledger.balance(co, ACC.unallocated)).toBe(c.netMinor);

    const refund = await gate.submit({
      companyId: co,
      agentId: 'support-agent',
      runId: newId('run'),
      envelope: 'support',
      action: 'refund',
      amountMinor: '1000',
      currency: 'USD',
      payee: c.captureId,
      category: 'refunds',
      reason: 'Partial refund: customer asked for the lite version',
    });
    expect(refund.status).toBe('executed');
    expect(await ledger.balance(co, ACC.refunds('revenue'))).toBe(1000n);
  }, 60_000);

  it('pays out to a contractor through the gate and books the real fee', async () => {
    await ledger.post({
      companyId: co,
      currency: 'USD',
      actor: 'founder',
      description: 'Founder funding (sandbox opening balance)',
      flow: 'founder_funding',
      postings: [
        { account: ACC.unallocated, amountMinor: 10_000n },
        { account: ACC.ownerEquity, amountMinor: -10_000n },
      ],
    });
    const base = { companyId: co, runId: newId('run'), currency: 'USD', reason: 'test' };
    expect(
      (
        await gate.submit({
          ...base,
          agentId: 'finance-agent',
          envelope: 'finance',
          action: 'allocation',
          amountMinor: '5000',
          target: 'growth',
          category: 'budgeting',
        })
      ).status,
    ).toBe('executed');
    await gate.allowPayee(co, 'agpal-contractor-a@example.com', 'Contractor A', 'founder');
    const held = await gate.submit({
      ...base,
      agentId: 'growth-agent',
      envelope: 'growth',
      action: 'payout',
      amountMinor: '150',
      payee: 'agpal-contractor-a@example.com',
      category: 'content',
      reason: 'Sandbox payout test',
    });
    expect(held.decision.rule).toBe('payee.first_payout');
    const r = await gate.approve(held.approvalId ?? '', 'founder', 'integration test');
    expect(['executed', 'pending']).toContain(r.status);
    if (r.status === 'executed') {
      const fee = await ledger.balance(co, ACC.paypalFees);
      expect(fee).toBeGreaterThan(0n);
      expect((await ledger.envelope(co, 'growth')).held).toBe(0n);
    }
  }, 150_000);
});
