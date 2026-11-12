import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { sql } from 'drizzle-orm';
import type { TestDatabase } from '@agpal/db/testing';
import { ACC } from './chart.js';
import {
  InsufficientFundsError,
  LedgerError,
  UnknownAccountError,
  type EntryInput,
  type Ledger,
} from './ledger.js';
import { hasDatabase, setupLedger } from './test-helpers.js';

describe.runIf(hasDatabase())('Ledger (Postgres)', () => {
  let t: TestDatabase;
  let ledger: Ledger;
  let co: string;

  const entry = (postings: [string, bigint][], extra: Partial<EntryInput> = {}): EntryInput => ({
    companyId: co,
    description: 'test',
    flow: 'test',
    currency: 'USD',
    actor: 'system',
    postings: postings.map(([account, amountMinor]) => ({ account, amountMinor })),
    ...extra,
  });
  const fund = (amount: bigint) =>
    ledger.post(
      entry(
        [
          [ACC.unallocated, amount],
          [ACC.ownerEquity, -amount],
        ],
        { flow: 'founder_funding' },
      ),
    );
  const allocate = (dept: string, amount: bigint) =>
    ledger.post(
      entry(
        [
          [ACC.envelope(dept), amount],
          [ACC.unallocated, -amount],
        ],
        { flow: 'allocation' },
      ),
    );

  beforeAll(async () => {
    ({ t, ledger, companyId: co } = await setupLedger());
    await fund(100_000n);
  });
  afterAll(async () => t.drop());

  it('posts a capture: gross, fee and net', async () => {
    await ledger.post(
      entry([
        [ACC.unallocated, 9_671n],
        [ACC.paypalFees, 329n],
        [ACC.sales('revenue'), -10_000n],
      ]),
    );
    expect(await ledger.balance(co, ACC.sales('revenue'))).toBe(-10_000n);
  });

  it('rejects unbalanced entries, unknown accounts and currency mismatches', async () => {
    await expect(
      ledger.post(
        entry([
          [ACC.unallocated, 1n],
          [ACC.ownerEquity, -2n],
        ]),
      ),
    ).rejects.toThrow(LedgerError);
    await expect(
      ledger.post(
        entry([
          [ACC.unallocated, 1n],
          ['cash:nope', -1n],
        ]),
      ),
    ).rejects.toThrow(UnknownAccountError);
    await expect(
      ledger.post({
        ...entry([
          [ACC.unallocated, 1n],
          [ACC.ownerEquity, -1n],
        ]),
        currency: 'EUR',
      }),
    ).rejects.toThrow(/is USD/);
  });

  it('never lets cash go negative', async () => {
    const before = await ledger.balance(co, ACC.unallocated);
    await expect(allocate('growth', before + 1n)).rejects.toThrow(InsufficientFundsError);
    expect(await ledger.balance(co, ACC.unallocated)).toBe(before);
  });

  it('requires attribution on agent entries (invariant 7)', async () => {
    await expect(
      ledger.post(
        entry(
          [
            [ACC.unallocated, 1n],
            [ACC.ownerEquity, -1n],
          ],
          { actor: 'agent' },
        ),
      ),
    ).rejects.toThrow(/attribution/);
  });

  it('is idempotent on the idempotency key', async () => {
    const e = entry(
      [
        [ACC.unallocated, 500n],
        [ACC.ownerEquity, -500n],
      ],
      { idempotencyKey: 'fund-once' },
    );
    const before = await ledger.balance(co, ACC.unallocated);
    const [a, b] = await Promise.all([ledger.post(e), ledger.post(e)]);
    expect(a.entryId).toBe(b.entryId);
    expect([a.duplicate, b.duplicate].sort()).toEqual([false, true]);
    expect(await ledger.balance(co, ACC.unallocated)).toBe(before + 500n);
  });

  it('reverses an entry exactly once and never edits the original', async () => {
    const { entryId } = await allocate('support', 1_000n);
    const before = await ledger.balance(co, ACC.envelope('support'));
    await ledger.reverse(co, entryId, 'wrong department', 'founder');
    expect(await ledger.balance(co, ACC.envelope('support'))).toBe(before - 1_000n);
    const again = await ledger.reverse(co, entryId, 'twice', 'founder');
    expect(again.duplicate).toBe(true);
    expect(await ledger.balance(co, ACC.envelope('support'))).toBe(before - 1_000n);
  });

  it('the database refuses UPDATE and DELETE on the ledger', async () => {
    await expect(
      t.db.execute(sql`UPDATE postings SET amount_minor = amount_minor + 1`),
    ).rejects.toThrow();
    await expect(t.db.execute(sql`DELETE FROM journal_entries`)).rejects.toThrow();
  });

  it('the database refuses an unbalanced entry even if code is bypassed', async () => {
    await expect(
      t.db.transaction(async (tx) => {
        await tx.execute(
          sql`INSERT INTO journal_entries (id, company_id, description, actor, flow) VALUES ('je_raw', ${co}, 'raw', 'system', 'raw')`,
        );
        await tx.execute(
          sql`INSERT INTO postings (entry_id, account_id, amount_minor, currency)
              SELECT 'je_raw', id, 100, 'USD' FROM accounts WHERE company_id = ${co} AND code = ${ACC.unallocated}`,
        );
      }),
    ).rejects.toThrow();
  });

  it('computes balances at a point in time', async () => {
    const t0 = new Date('2026-01-01T00:00:00Z');
    const t1 = new Date('2026-01-02T00:00:00Z');
    await ledger.post(
      entry(
        [
          [ACC.suspense, 7n],
          [ACC.ownerEquity, -7n],
        ],
        { occurredAt: t0 },
      ),
    );
    await ledger.post(
      entry(
        [
          [ACC.suspense, 5n],
          [ACC.ownerEquity, -5n],
        ],
        { occurredAt: t1 },
      ),
    );
    expect(await ledger.balance(co, ACC.suspense, new Date('2026-01-01T12:00:00Z'))).toBe(7n);
    expect(await ledger.balance(co, ACC.suspense, t1)).toBe(12n);
  });

  describe('holds and envelopes', () => {
    it('available = balance − held; holds release and convert', async () => {
      await allocate('growth', 10_000n);
      const start = await ledger.envelope(co, 'growth');
      const h1 = await ledger.placeHold(co, 'growth', 4_000n, 'intent-1');
      expect((await ledger.envelope(co, 'growth')).available).toBe(start.available - 4_000n);
      expect(await ledger.placeHold(co, 'growth', 4_000n, 'intent-1')).toBe(h1); // idempotent on reference

      await ledger.releaseHold(h1);
      expect((await ledger.envelope(co, 'growth')).available).toBe(start.available);

      await ledger.ensurePayable(co, 'contractor_x', 'USD');
      const h2 = await ledger.placeHold(co, 'growth', 4_080n, 'intent-2');
      await ledger.post(
        entry([
          [ACC.contractors('growth'), 4_000n],
          [ACC.payable('contractor_x'), -4_000n],
        ]),
      );
      await ledger.convertHold(
        h2,
        entry([
          [ACC.payable('contractor_x'), 4_000n],
          [ACC.paypalFees, 80n],
          [ACC.envelope('growth'), -4_080n],
        ]),
      );
      const end = await ledger.envelope(co, 'growth');
      expect(end.held).toBe(0n);
      expect(end.balance).toBe(start.balance - 4_080n);
    });

    it('spending cannot dip into held funds', async () => {
      const { available } = await ledger.envelope(co, 'growth');
      await ledger.placeHold(co, 'growth', available, 'all-of-it');
      await expect(
        ledger.post(
          entry([
            [ACC.contractors('growth'), 1n],
            [ACC.envelope('growth'), -1n],
          ]),
        ),
      ).rejects.toThrow(InsufficientFundsError);
    });

    it('two simultaneous holds cannot together exceed the envelope', async () => {
      await allocate('finance', 10_000n);
      const { available } = await ledger.envelope(co, 'finance');
      const amount = available / 2n + 1n;
      const results = await Promise.allSettled([
        ledger.placeHold(co, 'finance', amount, 'race-a'),
        ledger.placeHold(co, 'finance', amount, 'race-b'),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((await ledger.envelope(co, 'finance')).available).toBe(available - amount);
    });

    it('many concurrent spends never overdraw an envelope', async () => {
      await allocate('revenue', 1_000n);
      const start = await ledger.balance(co, ACC.envelope('revenue'));
      const spends = Array.from({ length: 20 }, () =>
        ledger.post(
          entry([
            [ACC.aiCompute('revenue'), start / 10n],
            [ACC.envelope('revenue'), -(start / 10n)],
          ]),
        ),
      );
      const ok = (await Promise.allSettled(spends)).filter((r) => r.status === 'fulfilled').length;
      expect(ok).toBe(10);
      expect(await ledger.balance(co, ACC.envelope('revenue'))).toBe(start - (start / 10n) * 10n);
    });
  });

  it('property: random operations keep the books balanced and cash non-negative', async () => {
    const depts = ['revenue', 'finance', 'support', 'growth'] as const;
    const op = fc.oneof(
      fc.record({
        kind: fc.constant('alloc' as const),
        dept: fc.constantFrom(...depts),
        amt: fc.bigInt({ min: 1n, max: 50_000n }),
      }),
      fc.record({
        kind: fc.constant('spend' as const),
        dept: fc.constantFrom(...depts),
        amt: fc.bigInt({ min: 1n, max: 50_000n }),
      }),
      fc.record({
        kind: fc.constant('sale' as const),
        dept: fc.constant('revenue' as const),
        amt: fc.bigInt({ min: 100n, max: 50_000n }),
      }),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 12 }), async (ops) => {
        for (const o of ops) {
          const p: [string, bigint][] =
            o.kind === 'alloc'
              ? [
                  [ACC.envelope(o.dept), o.amt],
                  [ACC.unallocated, -o.amt],
                ]
              : o.kind === 'spend'
                ? [
                    [ACC.contractors(o.dept), o.amt],
                    [ACC.envelope(o.dept), -o.amt],
                  ]
                : [
                    [ACC.unallocated, o.amt - 49n],
                    [ACC.paypalFees, 49n],
                    [ACC.sales('revenue'), -o.amt],
                  ];
          await ledger.post(entry(p)).catch((e: unknown) => {
            if (!(e instanceof InsufficientFundsError)) throw e;
          });
        }
        const check = await t.db.execute<{
          total: string;
          negative_cash: string;
          drift: string;
        }>(sql`
          SELECT
            (SELECT coalesce(sum(amount_minor), 0) FROM postings p JOIN accounts a ON a.id = p.account_id WHERE a.company_id = ${co}) AS total,
            (SELECT count(*) FROM accounts WHERE company_id = ${co} AND rule = 'non_negative' AND balance_minor < 0) AS negative_cash,
            (SELECT count(*) FROM accounts a WHERE company_id = ${co} AND balance_minor <>
               (SELECT coalesce(sum(amount_minor), 0) FROM postings WHERE account_id = a.id)) AS drift`);
        const row = check.rows[0];
        expect(row?.total).toBe('0');
        expect(row?.negative_cash).toBe('0');
        expect(row?.drift).toBe('0');
      }),
      { numRuns: 25 },
    );
  });
});
