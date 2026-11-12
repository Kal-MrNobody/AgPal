/**
 * pnpm sim:week [--dry] [--days 7] [--orders 2] — Phase 3 exit test: a simulated week of the demo shop.
 * Real sandbox captures/payouts/refunds and real model calls unless --dry (no PayPal client at all).
 * In the cloud dev environment set NODE_USE_ENV_PROXY=1 for OpenAI.
 */
import { simulateWeek } from '@agpal/agents';
import { arg, context, flag, usd } from './lib.js';

const dry = flag('dry');
const ctx = await context({ dry, payoutSettleWaitMs: 60_000 });
const report = await simulateWeek({
  db: ctx.db,
  services: ctx.s,
  days: Number(arg('days') ?? '7'),
  ordersPerDay: Number(arg('orders') ?? '2'),
  ...(ctx.env.OPENAI_API_KEY ? { openaiApiKey: ctx.env.OPENAI_API_KEY.reveal() } : {}),
  log: (l) => {
    console.log(l);
  },
});

console.log(`\n══════════ Simulated week — ${report.companyId}${dry ? ' (DRY)' : ''} ══════════`);
console.log('\nP&L per department (positive = income):');
for (const [dept, row] of Object.entries(report.pnl)) {
  console.log(
    `  ${dept.padEnd(9)} ${Object.entries(row)
      .map(([k, v]) => `${k}=${usd(v)}`)
      .join('  ')}`,
  );
}
console.log('\nEnvelopes:');
for (const [d, e] of Object.entries(report.envelopes))
  console.log(
    `  ${d.padEnd(9)} balance ${usd(e.balance)}  held ${usd(e.held)}  available ${usd(e.available)}`,
  );
console.log(`\nTreasury: ${usd(report.treasuryMinor)}`);
console.log(`\nHeld approvals (${report.heldApprovals.length}):`);
for (const h of report.heldApprovals) console.log(`  ${h.id} ${h.rule}: ${h.explanation}`);
console.log(`\nPolicy denials (${report.denials.length}):`);
for (const d of report.denials)
  console.log(`  ${d.agentId} ${d.action} → ${d.rule}: ${d.explanation}`);
console.log('\nAI cost per agent:');
for (const [a, c] of Object.entries(report.aiCostByAgent))
  console.log(`  ${a.padEnd(18)} ${usd(c)}`);
console.log(
  `\nRuns: ${report.runs.length} (${report.runs.filter((r) => r.status === 'completed').length} completed)`,
);
console.log(
  `Invariant violations: ${report.invariantViolations.length === 0 ? 'none' : report.invariantViolations.join('; ')}`,
);
if (report.reconciliation) {
  console.log(
    `Reconciliation: ${report.reconciliation.clean ? 'CLEAN' : 'MISMATCH'} ${JSON.stringify(report.reconciliation.counts)}`,
  );
  for (const p of report.reconciliation.problems) console.log(`  ${p}`);
} else {
  console.log(
    `Reconciliation: not applicable in dry mode; PayPal calls attempted: ${report.paypalAttemptsInDryMode.length}`,
  );
}
const pass =
  report.invariantViolations.length === 0 &&
  (report.reconciliation?.clean ?? report.paypalAttemptsInDryMode.length === 0);
console.log(`\n${pass ? 'PASS' : 'FAIL'}: Phase 3 exit test`);
await ctx.db.$client.end();
process.exitCode = pass ? 0 : 1;
