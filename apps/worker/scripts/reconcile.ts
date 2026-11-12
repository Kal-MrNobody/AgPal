/**
 * pnpm reconcile [--company id] [--hours 24 | --since ISO] [--live] [--skip-balance]
 * Matches PayPal Transaction Search against the ledger (zero tolerance) and stores the run. Exit code 1 on mismatch.
 */
import { arg, context, flag, usd } from './lib.js';

const ctx = await context();
const companyId = arg('company') ?? ctx.env.AGPAL_COMPANY_ID;
if (!companyId) throw new Error('--company or AGPAL_COMPANY_ID is required');
const since = arg('since')
  ? new Date(arg('since') ?? '')
  : new Date(Date.now() - Number(arg('hours') ?? '24') * 3_600_000);
const until = arg('until') ? new Date(arg('until') ?? '') : new Date();
const r = await ctx.s.reconciler.run(companyId, since, until, {
  ...(flag('live') ? { live: ctx.s.inbound } : {}),
  skipBalance: flag('skip-balance'),
});
console.log(`\nReconciliation ${r.runId} for ${companyId}: ${r.clean ? 'CLEAN' : 'MISMATCH'}`);
console.log(
  `Window ${r.windowStart.toISOString()} → ${r.windowEnd.toISOString()}; PayPal data complete to ${r.coverageEnd.toISOString()}`,
);
console.log(
  Object.entries(r.counts)
    .map(([k, v]) => `${k}=${v}`)
    .join('  '),
);
if (r.balance) {
  console.log(
    r.balance.checked
      ? `Balance at ${r.balance.asOf}: ledger ${usd(r.balance.ledgerTreasuryMinor)} vs PayPal ${usd(r.balance.paypalAvailableMinor)}`
      : `Balance not compared: PayPal's snapshot (${r.balance.asOf}) predates these books`,
  );
}
for (const i of r.items) console.log(`  [${i.kind}] ${i.transactionId ?? ''} ${i.detail}`);
await ctx.db.$client.end();
process.exitCode = r.clean ? 0 : 1;
