import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestDatabase } from '@agpal/db/testing';
import { isTreasuryAccount } from './chart.js';
import type { Ledger } from './ledger.js';
import { hasDatabase, setupLedger } from './test-helpers.js';

interface Step {
  day: string;
  label: string;
  postings: [string, number][];
  balances: Record<string, number>;
}

const steps = JSON.parse(
  readFileSync(new URL('./worked-example.fixture.json', import.meta.url), 'utf8'),
) as Step[];

describe.runIf(hasDatabase())('money constitution §6 worked example', () => {
  let t: TestDatabase;
  let ledger: Ledger;
  let companyId: string;

  beforeAll(async () => {
    ({ t, ledger, companyId } = await setupLedger());
    for (const s of steps) {
      for (const [code] of s.postings) {
        if (code.startsWith('liability:payable:contractor')) {
          await ledger.ensurePayable(companyId, code.split(':')[2] ?? '', 'USD');
        }
      }
    }
  });
  afterAll(async () => t.drop());

  it('reproduces every step with the same balances', async () => {
    for (const [i, s] of steps.entries()) {
      await ledger.post({
        companyId,
        description: s.label,
        flow: 'worked_example',
        currency: 'USD',
        actor: 'system',
        postings: s.postings.map(([account, amount]) => ({ account, amountMinor: BigInt(amount) })),
        idempotencyKey: `week:${i}`,
      });
      const actual = Object.fromEntries(
        [...(await ledger.balances(companyId))].map(([k, v]) => [k, Number(v)]),
      );
      expect(actual, `after step ${i + 1}: ${s.label}`).toEqual(s.balances);
    }
  });

  it('ends with the treasury equal to the PayPal balance ($4,909.04)', async () => {
    const balances = await ledger.balances(companyId);
    const treasury = [...balances]
      .filter(([k]) => isTreasuryAccount(k))
      .reduce((a, [, v]) => a + v, 0n);
    expect(treasury).toBe(490_904n);
    expect(balances.get('cash:envelope:growth')).toBe(31_270n);
    expect(balances.get('expense:paypal_fees')).toBe(696n);
  });
});
