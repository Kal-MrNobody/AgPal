/**
 * pnpm loop:manual — Phase 1 exit test: the money loop against the PayPal sandbox, no AI.
 *
 *   1. The founder funds the company (owner equity against the sandbox business balance).
 *   2. A product and an order: prints a buyer approval link, then captures a sandbox card order.
 *   3. Revenue lands; Finance allocates part of it to the Growth envelope through the gate.
 *   4. Growth requests two payouts to a sandbox contractor through the gate: one under the auto-approve limit
 *      (approved), one over it (held — approve it with `pnpm approvals approve <id>`, or pass --auto-approve).
 *   5. Webhooks are pulled (if a webhook is registered), then reconciliation runs.
 *
 * Passes only if reconciliation is clean to the cent, fees included.
 * Options: --contractor email (default AGPAL_SANDBOX_CONTRACTOR or agpal-contractor-a@example.com), --auto-approve
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { eq } from 'drizzle-orm';
import { approvals, spendIntents } from '@agpal/db';
import { ACC } from '@agpal/ledger';
import { newId } from '@agpal/shared';
import { handleWebhookJob } from '../src/webhook-job.js';
import { arg, context, flag, printBalances, usd } from './lib.js';

const ctx = await context({ payoutSettleWaitMs: 120_000 });
const { s, db } = ctx;
const contractor =
  arg('contractor') ?? process.env.AGPAL_SANDBOX_CONTRACTOR ?? 'agpal-contractor-a@example.com';
const companyId = newId('co');
const startedAt = new Date();
const run = (agent: string) => ({
  companyId,
  agentId: agent,
  runId: newId('run'),
  currency: 'USD' as const,
});
const step = (n: number, title: string) => {
  console.log(`\n━━━ Step ${n}: ${title}`);
};

console.log(
  `AgPal manual money loop — company ${companyId}, sandbox, started ${startedAt.toISOString()}`,
);
await s.ledger.setupCompany({
  id: companyId,
  name: 'AgPal Loop Shop',
  currency: 'USD',
  departments: ['revenue', 'finance', 'support', 'growth'].map((code) => ({ code, name: code })),
});

// 1 ─────────────────────────────────────────────────────────────────────────────────────────────
step(1, 'Founder funds the company');
const balance = await s.inbound.balances('USD');
console.log(
  `  PayPal sandbox business balance: ${usd(balance.availableMinor)} available (as of ${balance.asOf ?? '?'})`,
);
await s.ledger.post({
  companyId,
  currency: 'USD',
  actor: 'founder',
  description: `Founder funding: sandbox business balance ${usd(balance.availableMinor)}`,
  flow: 'founder_funding',
  postings: [
    { account: ACC.unallocated, amountMinor: balance.availableMinor },
    { account: ACC.ownerEquity, amountMinor: -balance.availableMinor },
  ],
  idempotencyKey: `founder-funding:${companyId}`,
  metadata: { paypalAsOf: balance.asOf },
});
await printBalances(s, companyId, 'after founder funding');

// 2 ─────────────────────────────────────────────────────────────────────────────────────────────
step(2, 'Product, order, capture');
const product = await s.commerce.createProduct(
  companyId,
  'Notion Freelancer OS template',
  'Digital download',
);
console.log(`  Catalog product ${product.id}`);
const checkout = await s.commerce.createCheckout({
  companyId,
  amountMinor: 2900n,
  currency: 'USD',
  description: product.name,
  reference: `checkout-${companyId}`,
});
console.log(
  `  Buyer approval link (PAY_NOW, NO_SHIPPING) for a sandbox buyer: ${checkout.approveUrl ?? '(none)'}`,
);
console.log('  Capturing a sandbox card order for the same product (no browser needed)…');
const capture = await s.commerce.sandboxCardSale({
  companyId,
  amountMinor: 2900n,
  currency: 'USD',
  description: product.name,
  reference: `sale-${companyId}`,
});
console.log(
  `  Captured ${capture.captureId}: gross ${usd(capture.grossMinor)}, PayPal fee ${usd(capture.feeMinor)}, net ${usd(capture.netMinor)}`,
);
await printBalances(s, companyId, 'after capture');

// 3 ─────────────────────────────────────────────────────────────────────────────────────────────
step(3, 'Finance allocates part of the revenue to Growth (through the gate)');
const alloc = await s.gate.submit({
  ...run('finance-agent'),
  envelope: 'finance',
  action: 'allocation',
  amountMinor: '10000',
  target: 'growth',
  category: 'budgeting',
  reason: 'Weekly Growth budget from this week’s revenue',
});
console.log(`  Gate: ${alloc.decision.outcome} (${alloc.decision.rule}) → ${alloc.status}`);
await printBalances(s, companyId, 'after allocation');

// 4 ─────────────────────────────────────────────────────────────────────────────────────────────
step(4, `Growth pays contractor ${contractor} (through the gate)`);
await s.gate.allowPayee(companyId, contractor, 'Sandbox contractor A', 'founder');
console.log('  Founder allow-listed the contractor.');
const small = await s.gate.submit({
  ...run('growth-agent'),
  envelope: 'growth',
  action: 'payout',
  amountMinor: '500',
  payee: contractor,
  category: 'content',
  reason: 'Launch tweet thread per brief #1',
});
console.log(
  `  Payout $5.00: ${small.decision.outcome} (${small.decision.rule}) → ${small.status}${small.externalRef ? ` item ${small.externalRef}` : ''}`,
);
const big = await s.gate.submit({
  ...run('growth-agent'),
  envelope: 'growth',
  action: 'payout',
  amountMinor: '6000',
  payee: contractor,
  category: 'content',
  reason: 'Product listing rewrite per brief #2',
});
console.log(
  `  Payout $60.00: ${big.decision.outcome} (${big.decision.rule}) — ${big.decision.explanation}`,
);
await printBalances(s, companyId, 'with the $60.00 payout held');
if (big.approvalId) {
  if (flag('auto-approve')) {
    const r = await s.gate.approve(big.approvalId, 'founder', 'approved by loop --auto-approve');
    console.log(`  Founder approved (auto): ${r.status}`);
  } else {
    console.log(
      `\n  ▶ Approve it from another terminal:\n      pnpm approvals approve ${big.approvalId} --note "ok"\n  Waiting up to 10 minutes…`,
    );
    const deadline = Date.now() + 10 * 60_000;
    for (;;) {
      const [a] = await db.select().from(approvals).where(eq(approvals.id, big.approvalId));
      if (a && a.status !== 'pending') {
        console.log(`  Founder decision: ${a.status}${a.note ? ` (“${a.note}”)` : ''}`);
        break;
      }
      if (Date.now() > deadline) throw new Error('No founder decision within 10 minutes');
      await sleep(3000);
    }
  }
}
// Payouts settle once PayPal reports the fee; wait for both.
for (const id of [small.intentId, big.intentId]) {
  for (let i = 0; i < 60; i++) {
    const [row] = await db.select().from(spendIntents).where(eq(spendIntents.id, id));
    if (row && row.status !== 'pending' && row.status !== 'approved') {
      console.log(
        `  Intent ${id}: ${row.status}${row.externalRef ? ` (payout item ${row.externalRef})` : ''}`,
      );
      break;
    }
    await sleep(3000);
  }
}
await printBalances(s, companyId, 'after payouts');

// 5 ─────────────────────────────────────────────────────────────────────────────────────────────
step(5, 'Webhooks, then reconciliation');
const events = await s.inbound.listWebhookEvents(startedAt).catch(() => []);
if (events.length === 0) {
  console.log(
    '  No webhook events: no webhook is registered for this sandbox app (pnpm webhook:tunnel --register).',
  );
  console.log(
    '  Every movement above was booked from PayPal’s API responses; webhooks would be deduplicated against them.',
  );
} else {
  const { webhookEvents } = await import('@agpal/db');
  for (const e of events.reverse()) {
    await db
      .insert(webhookEvents)
      .values({
        id: e.id,
        eventType: e.event_type,
        payload: e,
        verified: true,
      })
      .onConflictDoNothing();
    console.log(`  ${e.event_type} ${e.id} → ${await handleWebhookJob(db, s.webhooks, e.id, 99)}`);
  }
}
const report = await s.reconciler.run(companyId, startedAt, new Date(), {
  live: s.inbound,
  skipBalance: true,
});
console.log(
  `\n  Reconciliation ${report.runId}: ${report.clean ? 'CLEAN' : 'MISMATCH'}  (PayPal Transaction Search complete to ${report.coverageEnd.toISOString()})`,
);
console.log(
  '  ' +
    Object.entries(report.counts)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${k}=${v}`)
      .join('  '),
);
for (const i of report.items) console.log(`    [${i.kind}] ${i.transactionId ?? ''} ${i.detail}`);
await printBalances(s, companyId, 'final');

const verified = report.counts.matched + report.counts.verified_live;
const expected = 3; // 1 capture + 2 payouts
const pass = report.clean && verified >= expected;
console.log(
  `\n${pass ? 'PASS' : 'FAIL'}: ${verified}/${expected} PayPal movements reconciled to the cent (fees included)` +
    `${report.counts.verified_live > 0 ? `; ${report.counts.verified_live} verified by id while Transaction Search catches up — re-run: pnpm reconcile --company ${companyId} --since ${startedAt.toISOString()} --skip-balance` : ''}.`,
);
await db.$client.end();
process.exitCode = pass ? 0 : 1;
