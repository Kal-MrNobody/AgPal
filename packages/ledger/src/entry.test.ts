import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  assertBalanced,
  reversalOf,
  UnbalancedEntryError,
  type JournalEntryDraft,
  type Posting,
} from './entry.js';

const entry = (postings: Posting[]): JournalEntryDraft => ({
  companyId: 'c1',
  description: 't',
  postings,
});

describe('assertBalanced', () => {
  it('accepts a balanced capture (gross = fee + net)', () => {
    expect(() =>
      assertBalanced(
        entry([
          { accountId: 'treasury', amountMinor: 9_671n, currency: 'USD' },
          { accountId: 'fees', amountMinor: 329n, currency: 'USD' },
          { accountId: 'revenue', amountMinor: -10_000n, currency: 'USD' },
        ]),
      ),
    ).not.toThrow();
  });

  it('rejects unbalanced, single-leg, zero and cross-currency entries', () => {
    const bad: Posting[][] = [
      [
        { accountId: 'a', amountMinor: 100n, currency: 'USD' },
        { accountId: 'b', amountMinor: -99n, currency: 'USD' },
      ],
      [{ accountId: 'a', amountMinor: 100n, currency: 'USD' }],
      [
        { accountId: 'a', amountMinor: 0n, currency: 'USD' },
        { accountId: 'b', amountMinor: 0n, currency: 'USD' },
      ],
      [
        { accountId: 'a', amountMinor: 100n, currency: 'USD' },
        { accountId: 'b', amountMinor: -100n, currency: 'EUR' },
      ],
    ];
    for (const p of bad) expect(() => assertBalanced(entry(p))).toThrow(UnbalancedEntryError);
  });

  it('a reversal of any balanced entry is balanced and nets to zero (property)', () => {
    const amt = fc.bigInt({ min: 1n, max: 10n ** 12n });
    fc.assert(
      fc.property(fc.array(amt, { minLength: 1, maxLength: 8 }), (debits) => {
        const total = debits.reduce((a, b) => a + b, 0n);
        const original = entry([
          ...debits.map((d, i) => ({
            accountId: `d${i}`,
            amountMinor: d,
            currency: 'USD' as const,
          })),
          { accountId: 'credit', amountMinor: -total, currency: 'USD' },
        ]);
        assertBalanced(original);
        const rev = reversalOf('je_1', original, 'test');
        assertBalanced(rev);
        expect(rev.reverses).toBe('je_1');
        const net = [...original.postings, ...rev.postings].reduce((a, p) => a + p.amountMinor, 0n);
        expect(net).toBe(0n);
      }),
    );
  });
});
