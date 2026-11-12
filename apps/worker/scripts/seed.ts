/**
 * pnpm seed [--name "AgPal Demo Shop"] [--id co_x] — create the company this deployment runs, with its chart of
 * accounts and envelopes, and an opening balance equal to PayPal's reported available balance.
 * Prints AGPAL_COMPANY_ID.
 */
import { ACC } from '@agpal/ledger';
import { newId } from '@agpal/shared';
import { arg, context, usd } from './lib.js';

const ctx = await context();
const id = arg('id') ?? newId('co');
const name = arg('name') ?? 'AgPal Demo Shop';
await ctx.s.ledger.setupCompany({
  id,
  name,
  currency: 'USD',
  departments: [
    { code: 'revenue', name: 'Revenue' },
    { code: 'finance', name: 'Finance' },
    { code: 'support', name: 'Support' },
    { code: 'growth', name: 'Growth' },
  ],
});
const b = await ctx.s.inbound.balances('USD');
if (b.availableMinor > 0n) {
  await ctx.s.ledger.post({
    companyId: id,
    currency: 'USD',
    actor: 'founder',
    description: `Opening balance: PayPal available ${usd(b.availableMinor)} as of ${b.asOf ?? 'now'}`,
    flow: 'opening_balance',
    postings: [
      { account: ACC.unallocated, amountMinor: b.availableMinor },
      { account: ACC.ownerEquity, amountMinor: -b.availableMinor },
    ],
    idempotencyKey: `opening:${id}`,
    metadata: { paypalAsOf: b.asOf },
  });
}
console.log(
  `Created ${name} (${id}) with opening balance ${usd(b.availableMinor)}.\nSet AGPAL_COMPANY_ID=${id}`,
);
await ctx.db.$client.end();
