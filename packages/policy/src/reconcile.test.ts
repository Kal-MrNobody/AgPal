import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { alerts, reconciliationRuns } from '@agpal/db';
import { createTestDatabase, type TestDatabase } from '@agpal/db/testing';
import { ACC, Ledger } from '@agpal/ledger';
import type { Balance, TransactionRecord } from '@agpal/paypal';
import { newId } from '@agpal/shared';
import { Commerce } from './commerce.js';
import { Reconciler } from './reconcile.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const DEPTS = ['revenue', 'finance', 'support', 'growth'].map((code) => ({ code, name: code }));
const HOUR = 3_600_000;

describe.runIf(hasDb)('Reconciler', () => {
  let t: TestDatabase;
  let ledger: Ledger;
  let commerce: Commerce;
  let co: string;
  let records: TransactionRecord[] & { lastRefreshed?: Date };
  let balance: Balance;
  let rec: Reconciler;
  const now = new Date();
  const ago = (h: number) => new Date(now.getTime() - h * HOUR);

  const tx = (
    id: string,
    code: string,
    gross: bigint,
    fee: bigint,
    status = 'S',
    at = ago(5),
  ): TransactionRecord => ({
    transactionId: id,
    eventCode: code,
    status,
    currency: 'USD',
    grossMinor: gross,
    feeMinor: fee,
    netMinor: gross + fee,
    initiatedAt: at.toISOString(),
  });

  const sale = async (id: string, gross: bigint, fee: bigint, at = ago(5)) => {
    await ledger.post({
      companyId: co,
      currency: 'USD',
      actor: 'system',
      description: `capture ${id}`,
      flow: 'capture',
      externalRef: id,
      occurredAt: at,
      idempotencyKey: `paypal:capture:${id}`,
      postings: [
        { account: ACC.unallocated, amountMinor: gross - fee },
        { account: ACC.paypalFees, amountMinor: fee },
        { account: ACC.sales('revenue'), amountMinor: -gross },
      ],
    });
  };

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => t.drop());
  beforeEach(async () => {
    ledger = new Ledger(t.db);
    commerce = new Commerce(ledger, {} as never);
    co = newId('co');
    await ledger.setupCompany({ id: co, name: 'Shop', currency: 'USD', departments: DEPTS });
    await ledger.post({
      companyId: co,
      currency: 'USD',
      actor: 'founder',
      description: 'opening balance',
      flow: 'opening_balance',
      occurredAt: ago(10),
      postings: [
        { account: ACC.unallocated, amountMinor: 500_000n },
        { account: ACC.ownerEquity, amountMinor: -500_000n },
      ],
    });
    records = Object.assign([] as TransactionRecord[], { lastRefreshed: ago(2) });
    balance = {
      currency: 'USD',
      availableMinor: 500_000n,
      withheldMinor: 0n,
      totalMinor: 500_000n,
      asOf: ago(9).toISOString(),
    };
    rec = new Reconciler(t.db, ledger, {
      searchTransactions: () => Promise.resolve(records),
      balances: () => Promise.resolve(balance),
    });
  });

  const run = () => rec.run(co, ago(10), now, { now });

  it('clean: every PayPal transaction matches gross, fee and net, and balances agree', async () => {
    await sale('CAP-1', 2_900n, 124n);
    records.push(tx('CAP-1', 'T0006', 2_900n, -124n));
    balance = { ...balance, availableMinor: 500_000n + 2_776n, asOf: ago(3).toISOString() };
    const r = await run();
    expect(r.clean).toBe(true);
    expect(r.counts.matched).toBe(1);
    expect(r.balance?.checked).toBe(true);
    const [row] = await t.db
      .select()
      .from(reconciliationRuns)
      .where(eq(reconciliationRuns.id, r.runId));
    expect(row?.status).toBe('clean');
  });

  it('missing in ledger: a PayPal transaction we never booked', async () => {
    records.push(tx('CAP-X', 'T0006', 1_000n, -75n));
    const r = await run();
    expect(r.counts.missing_in_ledger).toBe(1);
    expect(r.clean).toBe(false);
    const a = await t.db.select().from(alerts).where(eq(alerts.companyId, co));
    expect(a.some((x) => x.kind === 'reconciliation.missing_in_ledger')).toBe(true);
  });

  it('missing in PayPal: an old ledger entry PayPal does not know', async () => {
    await sale('CAP-GHOST', 1_000n, 75n, ago(5));
    const r = await rec.run(co, ago(10), now, { now, pendingGraceMs: 4 * HOUR });
    expect(r.counts.missing_in_paypal).toBe(1);
  });

  it('pending, not missing: an entry booked after PayPal’s data cutoff (Transaction Search lag)', async () => {
    await sale('CAP-NEW', 1_000n, 75n, ago(0.5));
    const r = await run();
    expect(r.counts.pending).toBe(1);
    expect(r.counts.missing_in_paypal).toBe(0);
    expect(r.clean).toBe(true);
  });

  it('amount mismatch: fee differs by one cent', async () => {
    await sale('CAP-2', 2_900n, 124n);
    records.push(tx('CAP-2', 'T0006', 2_900n, -125n));
    const r = await run();
    expect(r.counts.amount_mismatch).toBe(1);
    expect(r.items.find((i) => i.kind === 'amount_mismatch')?.detail).toMatch(/fee \$1\.25/);
  });

  it('status mismatch: PayPal reversed a transaction the ledger still counts', async () => {
    await sale('CAP-3', 2_900n, 124n);
    records.push(tx('CAP-3', 'T0006', 2_900n, -124n, 'V'));
    expect((await run()).counts.status_mismatch).toBe(1);
  });

  it('suspense: unresolved suspense alerts keep reconciliation red', async () => {
    await t.db.insert(alerts).values({
      id: newId('alr'),
      companyId: co,
      kind: 'webhook.suspense',
      message: 'orphan refund',
    });
    const r = await run();
    expect(r.counts.suspense).toBe(1);
    expect(r.clean).toBe(false);
  });

  it('balance mismatch: zero tolerance at PayPal’s as-of time', async () => {
    balance = { ...balance, availableMinor: 499_999n };
    const r = await run();
    expect(r.counts.balance_mismatch).toBe(1);
  });

  it('a balance snapshot older than the company’s books is not compared', async () => {
    balance = { ...balance, availableMinor: 1n, asOf: ago(20).toISOString() };
    const r = await run();
    expect(r.balance?.checked).toBe(false);
    expect(r.counts.balance_mismatch).toBe(0);
  });

  it('reversed entries are excluded; refunds and payouts match by their PayPal ids', async () => {
    await sale('CAP-4', 5_000n, 179n);
    await commerce.bookCapture(co, {
      orderId: 'O',
      captureId: 'CAP-4',
      status: 'COMPLETED',
      currency: 'USD',
      grossMinor: 5_000n,
      feeMinor: 179n,
      netMinor: 4_821n,
    });
    await ledger.post({
      companyId: co,
      currency: 'USD',
      actor: 'system',
      description: 'refund',
      flow: 'refund',
      externalRef: 'REF-4',
      occurredAt: ago(4),
      postings: [
        { account: ACC.refunds('revenue'), amountMinor: 1_000n },
        { account: ACC.unallocated, amountMinor: -1_000n },
      ],
    });
    records.push(
      tx('CAP-4', 'T0006', 5_000n, -179n),
      tx('REF-4', 'T1107', -1_000n, 0n, 'S', ago(4)),
    );
    const r = await run();
    expect(r.counts.matched).toBe(2);
    expect(r.counts.amount_mismatch + r.counts.missing_in_ledger + r.counts.missing_in_paypal).toBe(
      0,
    );
  });
});

describe.runIf(hasDb)('Reconciler live verification', () => {
  it('verifies items inside the lag window by id, and flags a one-cent difference', async () => {
    const t = await createTestDatabase();
    try {
      const ledger = new Ledger(t.db);
      const co = newId('co');
      await ledger.setupCompany({ id: co, name: 'Shop', currency: 'USD', departments: DEPTS });
      const commerce = new Commerce(ledger, {} as never);
      await commerce.bookCapture(co, {
        orderId: 'O',
        captureId: 'CAP-LIVE',
        status: 'COMPLETED',
        currency: 'USD',
        grossMinor: 2_900n,
        feeMinor: 124n,
        netMinor: 2_776n,
      });
      await commerce.bookCapture(co, {
        orderId: 'O',
        captureId: 'CAP-OFF',
        status: 'COMPLETED',
        currency: 'USD',
        grossMinor: 1_000n,
        feeMinor: 75n,
        netMinor: 925n,
      });
      const lagged = Object.assign([] as TransactionRecord[], {
        lastRefreshed: new Date(Date.now() - 2 * HOUR),
      });
      const rec = new Reconciler(t.db, ledger, {
        searchTransactions: () => Promise.resolve(lagged),
        balances: () => Promise.reject(new Error('unused')),
      });
      const live = {
        getCapture: (id: string) =>
          Promise.resolve({
            orderId: 'O',
            captureId: id,
            status: 'COMPLETED',
            currency: 'USD' as const,
            grossMinor: id === 'CAP-OFF' ? 1_000n : 2_900n,
            feeMinor: id === 'CAP-OFF' ? 76n : 124n,
            netMinor: 0n,
          }),
        getRefund: () => Promise.reject(new Error('unused')),
        getPayoutItem: () => Promise.reject(new Error('unused')),
      };
      const r = await rec.run(co, new Date(Date.now() - HOUR), new Date(), {
        live,
        skipBalance: true,
      });
      expect(r.counts.verified_live).toBe(1);
      expect(r.counts.amount_mismatch).toBe(1);
      expect(r.clean).toBe(false);
    } finally {
      await t.drop();
    }
  });
});
