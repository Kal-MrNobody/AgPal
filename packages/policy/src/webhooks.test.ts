import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { alerts, domainEvents } from '@agpal/db';
import { createTestDatabase, type TestDatabase } from '@agpal/db/testing';
import { ACC, Ledger } from '@agpal/ledger';
import type { Capture } from '@agpal/paypal';
import { newId } from '@agpal/shared';
import { Commerce } from './commerce.js';
import { Gate } from './gate.js';
import { FakePayments } from './ports.js';
import { RetryLaterError, WebhookProcessor, type PayPalEvent } from './webhooks.js';
import * as fx from './fixtures/webhooks.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const DEPTS = ['revenue', 'finance', 'support', 'growth'].map((code) => ({ code, name: code }));

describe.runIf(hasDb)('WebhookProcessor', () => {
  let t: TestDatabase;
  let ledger: Ledger;
  let gate: Gate;
  let wp: WebhookProcessor;
  let co: string;
  let payments: FakePayments;

  /** Process with the worker's retry semantics: RetryLaterError means "try again later". */
  const run = (e: PayPalEvent, finalAttempt = false) => wp.process(e, { finalAttempt });

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => t.drop());
  beforeEach(async () => {
    ledger = new Ledger(t.db);
    payments = new FakePayments();
    gate = new Gate(t.db, ledger, payments);
    const commerce = new Commerce(ledger, {
      createOrder: () => Promise.reject(new Error('unused')),
      captureOrder: () => Promise.reject(new Error('unused')),
      createAndCaptureSandboxCardOrder: () => Promise.reject(new Error('unused')),
    });
    co = newId('co');
    wp = new WebhookProcessor(
      t.db,
      ledger,
      gate,
      commerce,
      { getCapture: () => Promise.reject<Capture>(new Error('unused')) },
      { defaultCompanyId: co },
    );
    await ledger.setupCompany({ id: co, name: 'Shop', currency: 'USD', departments: DEPTS });
  });

  it('books a capture once, however many times the event arrives, and publishes revenue.received once', async () => {
    const e = fx.captureCompleted(co);
    await run(e);
    await run(e);
    await run({ ...e, id: 'WH-REDELIVERED-WITH-NEW-ID' });
    expect(await ledger.balance(co, ACC.unallocated)).toBe(2_776n);
    expect(await ledger.balance(co, ACC.paypalFees)).toBe(124n);
    const evts = await t.db.select().from(domainEvents).where(eq(domainEvents.companyId, co));
    expect(evts.filter((x) => x.name === 'revenue.received')).toHaveLength(1);
  });

  it('a refund that arrives before its capture is retried, then books once the capture lands', async () => {
    await ledger.post({
      companyId: co,
      currency: 'USD',
      actor: 'founder',
      description: 'fund',
      flow: 'founder_funding',
      postings: [
        { account: ACC.unallocated, amountMinor: 1_000n },
        { account: ACC.ownerEquity, amountMinor: -1_000n },
      ],
    });
    const cap = `CAP-${co}`;
    await expect(run(fx.captureRefunded(cap, `REF-${co}`))).rejects.toBeInstanceOf(RetryLaterError);
    await run(fx.captureCompleted(co, cap));
    expect((await run(fx.captureRefunded(cap, `REF-${co}`))).outcome).toBe('booked');
    await run(fx.captureRefunded(cap, `REF-${co}`));
    expect(await ledger.balance(co, ACC.refunds('revenue'))).toBe(2_900n);
    expect(await ledger.balance(co, ACC.unallocated)).toBe(1_000n + 2_776n - 2_900n);
  });

  it('a refund that never finds its capture goes to suspense with an alert, never dropped', async () => {
    const r = await run(fx.captureRefunded('CAP-NEVER', 'REF-ORPHAN'), true);
    expect(r.outcome).toBe('suspense');
    const a = await t.db.select().from(alerts).where(eq(alerts.companyId, co));
    expect(a.some((x) => x.kind === 'webhook.suspense')).toBe(true);
  });

  it('books subscription payments (v1 sale resource)', async () => {
    await run(fx.saleCompleted(co));
    expect(await ledger.balance(co, ACC.subscriptions('revenue'))).toBe(-900n);
    expect(await ledger.balance(co, ACC.unallocated)).toBe(828n);
  });

  it('dispute: withheld on open (once), released when won', async () => {
    const cap = `CAP-D-${co}`;
    await run(fx.captureCompleted(co, cap, '49.00', '1.76'));
    await run(fx.dispute('CREATED', cap));
    await run(fx.dispute('UPDATED', cap));
    expect(await ledger.balance(co, ACC.withheld)).toBe(2_900n);
    await run(fx.dispute('RESOLVED', cap, 'RESOLVED_SELLER_FAVOUR'));
    await run(fx.dispute('RESOLVED', cap, 'RESOLVED_SELLER_FAVOUR'));
    expect(await ledger.balance(co, ACC.withheld)).toBe(0n);
    expect(await ledger.balance(co, ACC.unallocated)).toBe(4_724n);
  });

  it('dispute: lost becomes contra-revenue; out-of-order UPDATED before CREATED still withholds once', async () => {
    const cap = `CAP-L-${co}`;
    await run(fx.captureCompleted(co, cap, '49.00', '1.76'));
    await run(fx.dispute('UPDATED', cap));
    await run(fx.dispute('CREATED', cap));
    expect(await ledger.balance(co, ACC.withheld)).toBe(2_900n);
    await run(fx.dispute('RESOLVED', cap, 'RESOLVED_BUYER_FAVOUR'));
    expect(await ledger.balance(co, ACC.withheld)).toBe(0n);
    expect(await ledger.balance(co, ACC.refunds('revenue'))).toBe(2_900n);
  });

  describe('payout items', () => {
    let intentId: string;
    beforeEach(async () => {
      await ledger.post({
        companyId: co,
        currency: 'USD',
        actor: 'founder',
        description: 'fund',
        flow: 'founder_funding',
        postings: [
          { account: ACC.envelope('growth'), amountMinor: 10_000n },
          { account: ACC.ownerEquity, amountMinor: -10_000n },
        ],
      });
      await gate.allowPayee(co, 'alice@example.com', 'Alice', 'founder');
      // Make the fake provider report "pending" (no fee yet) so the webhook has to settle the payout.
      payments.payoutFee = () => 25n;
      const orig = payments.payout.bind(payments);
      payments.payout = async (req) => {
        const r = await orig(req);
        return { batchId: r.batchId, itemStatus: 'PENDING' };
      };
      const held = await gate.submit({
        companyId: co,
        agentId: 'growth-agent',
        runId: newId('run'),
        envelope: 'growth',
        action: 'payout',
        amountMinor: '4000',
        currency: 'USD',
        payee: 'alice@example.com',
        category: 'content',
        reason: 'post',
      });
      const r = await gate.approve(held.approvalId ?? '', 'founder');
      expect(r.status).toBe('pending');
      intentId = r.intentId;
    });

    it('SUCCEEDED settles a pending payout with the real fee, exactly once', async () => {
      await run(fx.payoutItem('SUCCEEDED', intentId));
      await run(fx.payoutItem('SUCCEEDED', intentId));
      const env = await ledger.envelope(co, 'growth');
      expect(env.held).toBe(0n);
      expect(env.balance).toBe(10_000n - 4_025n);
    });

    it('a SUCCEEDED event without a fee yet is retried', async () => {
      await expect(run(fx.payoutItem('SUCCEEDED', intentId, null))).rejects.toBeInstanceOf(
        RetryLaterError,
      );
    });

    it('RETURNED after SUCCEEDED reverses the payout; money is back in the envelope', async () => {
      await run(fx.payoutItem('SUCCEEDED', intentId));
      await run(fx.payoutItem('RETURNED', intentId));
      await run(fx.payoutItem('RETURNED', intentId));
      const env = await ledger.envelope(co, 'growth');
      expect(env.balance).toBe(10_000n);
      expect(await ledger.balance(co, ACC.contractors('growth'))).toBe(0n);
      const evts = await t.db.select().from(domainEvents).where(eq(domainEvents.companyId, co));
      expect(evts.filter((x) => x.name === 'payout.failed')).toHaveLength(1);
    });

    it('FAILED before any settlement releases the hold', async () => {
      await run(fx.payoutItem('FAILED', intentId, null));
      const env = await ledger.envelope(co, 'growth');
      expect(env.held).toBe(0n);
      expect(env.balance).toBe(10_000n);
    });

    it('a payout item matching no intent goes to suspense', async () => {
      expect((await run(fx.payoutItem('SUCCEEDED', 'int_unknown'))).outcome).toBe('suspense');
    });
  });
});
