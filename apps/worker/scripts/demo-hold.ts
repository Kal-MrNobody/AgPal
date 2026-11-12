/**
 * pnpm demo:hold [--company <id>] [--amount 90]
 *
 * Demo setup: leave one contractor payout waiting for the founder, so the Approvals page has something to decide on
 * camera. Everything goes through the policy gate like any agent request, attributed to `demo-setup` (not to an
 * agent), so the audit trail shows exactly where it came from:
 *   1. Finance allocation $100 treasury → Growth (internal ledger only; within Finance's auto-approve, so it executes).
 *   2. Growth payout to the allow-listed contractor, above Growth's $50 auto-approve → held for the founder.
 * Approving it in the boardroom then sends a real sandbox payout through PayPal.
 */
import { arg, context, usd } from './lib.js';

const ctx = await context();
const companyId = arg('company') ?? ctx.env.AGPAL_COMPANY_ID;
if (!companyId) throw new Error('--company or AGPAL_COMPANY_ID required');
const amountMinor = BigInt(Math.round(Number(arg('amount') ?? '90') * 100));
const runId = `demo-setup:${new Date().toISOString()}`;
const by = { companyId, agentId: 'demo-setup', runId, currency: 'USD' } as const;

const top = await ctx.s.gate.submit({
  ...by,
  envelope: 'finance',
  action: 'allocation',
  amountMinor: '10000',
  target: 'growth',
  category: 'budgeting',
  reason: 'Demo setup: top up Growth so a contractor invoice can be reviewed by the founder',
});
console.log(`allocation $100 → growth: ${top.status} (${top.decision.rule})`);

const held = await ctx.s.gate.submit({
  ...by,
  envelope: 'growth',
  action: 'payout',
  amountMinor: String(amountMinor),
  payee: 'agpal-contractor-a@example.com',
  category: 'launches',
  reason: `Demo setup: contractor invoice for the launch thread (${usd(amountMinor)}), above Growth's auto-approve limit`,
});
console.log(
  `payout ${usd(amountMinor)} → agpal-contractor-a@example.com: ${held.status} (${held.decision.rule}: ${held.decision.explanation})`,
);
if (held.approvalId) console.log(`waiting for the founder: ${held.approvalId}`);
process.exit(held.status === 'held' ? 0 : 1);
