import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { holds, spendIntents } from '@agpal/db';
import { createTestDatabase, type TestDatabase } from '@agpal/db/testing';
import { ACC, Ledger } from '@agpal/ledger';
import type { Capture } from '@agpal/paypal';
import { newId } from '@agpal/shared';
import { Commerce } from './commerce.js';
import { Gate } from './gate.js';
import { FakePayments, type PayoutRequest, type PayoutResult } from './ports.js';

/**
 * Chaos and reliability (Prompt 23). Every scenario must end in a consistent ledger: postings sum to zero, no cash
 * account negative, cached balances equal posted sums, no hold left active without a live intent.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.runIf(hasDb)('chaos', () => {
  let t: TestDatabase;
  let ledger: Ledger;
  let payments: FakePayments;
  let gate: Gate;
  let co: string;

  const consistent = async () => {
    const r = await t.db.execute<{
      total: string;
      neg: string;
      drift: string;
      orphan_holds: string;
    }>(sql`
      SELECT
        (SELECT coalesce(sum(p.amount_minor), 0) FROM postings p JOIN accounts a ON a.id = p.account_id WHERE a.company_id = ${co}) AS total,
        (SELECT count(*) FROM accounts WHERE company_id = ${co} AND rule = 'non_negative' AND balance_minor < 0) AS neg,
        (SELECT count(*) FROM accounts a WHERE a.company_id = ${co} AND a.balance_minor <> (SELECT coalesce(sum(amount_minor), 0) FROM postings WHERE account_id = a.id)) AS drift,
        (SELECT count(*) FROM holds h WHERE h.company_id = ${co} AND h.status = 'active'
           AND NOT EXISTS (SELECT 1 FROM spend_intents i WHERE i.hold_id = h.id AND i.status IN ('held', 'approved', 'pending', 'failed'))
           AND h.reference NOT LIKE 'run:%') AS orphan_holds`);
    expect(r.rows[0]).toEqual({ total: '0', neg: '0', drift: '0', orphan_holds: '0' });
  };

  const payout = (amount = '4000', agent = 'growth-agent') =>
    gate.submit({
      companyId: co,
      agentId: agent,
      runId: newId('run'),
      envelope: 'growth',
      action: 'payout',
      amountMinor: amount,
      currency: 'USD',
      payee: 'alice@example.com',
      category: 'content',
      reason: 'work',
    });

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => t.drop());
  beforeEach(async () => {
    ledger = new Ledger(t.db);
    payments = new FakePayments();
    gate = new Gate(t.db, ledger, payments);
    co = newId('co');
    await ledger.setupCompany({
      id: co,
      name: 'Shop',
      currency: 'USD',
      departments: ['revenue', 'finance', 'support', 'growth'].map((code) => ({
        code,
        name: code,
      })),
    });
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
  });

  it('PayPal 5xx mid-capture: the retry (same PayPal-Request-Id) books the capture once', async () => {
    const cap: Capture = {
      orderId: 'O1',
      captureId: 'CAP-CHAOS',
      status: 'COMPLETED',
      currency: 'USD',
      grossMinor: 2_900n,
      feeMinor: 124n,
      netMinor: 2_776n,
    };
    let calls = 0;
    const seenKeys: string[] = [];
    const commerce = new Commerce(ledger, {
      createOrder: () => Promise.reject(new Error('unused')),
      createAndCaptureSandboxCardOrder: () => Promise.reject(new Error('unused')),
      // PayPal captured the money, but the response was lost (503 on the way back), then the retry returns the same capture.
      captureOrder: (_id: string, requestId: string) => {
        seenKeys.push(requestId);
        return ++calls === 1 ? Promise.reject(new Error('PayPal 503')) : Promise.resolve(cap);
      },
    });
    await expect(commerce.capture(co, 'O1')).rejects.toThrow('503');
    await commerce.capture(co, 'O1');
    await commerce.capture(co, 'O1'); // and the webhook path / a third retry
    expect(new Set(seenKeys).size).toBe(1);
    expect(await ledger.balance(co, ACC.sales('revenue'))).toBe(-2_900n);
    await consistent();
  });

  it('timeout mid-payout after PayPal accepted it: the hold is kept, the retry sends nothing new, booked once', async () => {
    const real = payments.payout.bind(payments);
    let first = true;
    payments.payout = async (req: PayoutRequest): Promise<PayoutResult> => {
      const r = await real(req); // PayPal processed it…
      if (first) {
        first = false;
        throw new Error('timeout'); // …but we never saw the answer
      }
      return r;
    };
    const r = await payout();
    expect(r.status).toBe('failed');
    expect((await ledger.envelope(co, 'growth')).held).toBe(4_100n);
    expect((await gate.retry(r.intentId)).status).toBe('executed');
    expect(payments.payouts).toHaveLength(1); // sender_batch_id = intent id: one payout per intent
    expect(await ledger.balance(co, ACC.contractors('growth'))).toBe(4_000n);
    await consistent();
  });

  it('worker crash between the ledger hold and the PayPal call: recovery executes it exactly once', async () => {
    // The process dies right after the decision + hold commit, before the provider call.
    const spy = vi
      .spyOn(gate as unknown as { execute: () => Promise<unknown> }, 'execute')
      .mockImplementationOnce(() => {
        throw new Error('SIGKILL');
      });
    await expect(payout()).rejects.toThrow('SIGKILL');
    spy.mockRestore();
    const [stuck] = await t.db.select().from(spendIntents).where(eq(spendIntents.companyId, co));
    expect(stuck?.status).toBe('approved');
    expect(payments.payouts).toHaveLength(0);
    // Recovery sweep (the worker runs it every 5 minutes).
    const recovered = await gate.recoverStuck(0);
    expect(recovered).toEqual([stuck?.id]);
    expect(await gate.recoverStuck(0)).toEqual([]);
    expect(payments.payouts).toHaveLength(1);
    await consistent();
  });

  it('double-clicked approval: one payout', async () => {
    const held = await payout('9000');
    const results = await Promise.all([
      gate.approve(held.approvalId ?? '', 'founder'),
      gate.approve(held.approvalId ?? '', 'founder'),
    ]);
    // The second click sees the intent already approved (in flight or executed); it never executes it again.
    expect(results.some((r) => r.status === 'executed')).toBe(true);
    expect(results.every((r) => r.status === 'executed' || r.status === 'approved')).toBe(true);
    expect(payments.payouts).toHaveLength(1);
    await consistent();
  });

  it('two agents spending one envelope at the same instant: never more than it holds', async () => {
    const [a, b] = await Promise.all([
      payout('4900', 'growth-agent'),
      payout('4900', 'growth-agent-2'),
      payout('4900', 'growth-agent-3'),
    ]);
    const results = [a, b, ...(await Promise.all([payout('4900', 'growth-agent-4')]))];
    const executed = results.filter((r) => r.status === 'executed').length;
    expect(executed).toBeLessThanOrEqual(2); // 10,000¢ envelope, 4,900 + fees each
    expect(results.some((r) => r.decision.rule === 'funds.insufficient')).toBe(true);
    const env = await ledger.envelope(co, 'growth');
    expect(env.balance >= 0n && env.available >= 0n).toBe(true);
    await consistent();
  });

  it('holds never outlive their intent: a rejected approval releases its hold', async () => {
    const held = await payout('9000');
    await gate.reject(held.approvalId ?? '', 'founder');
    const active = await t.db.select().from(holds).where(eq(holds.companyId, co));
    expect(active.every((h) => h.status !== 'active')).toBe(true);
    await consistent();
  });
});
